# S6. Хранение jobs в SQLite

## Цель

Реализация порта `JobStore` (S3, `src/core/job-store.ts`) поверх
`bb.storage.database()` (better-sqlite3), чтобы очередь переживала remount
UI, reload плагина и рестарт BB.

## Принятые пути

`src/adapters/bb/job-store-sqlite.ts`, `src/adapters/bb/migrations.ts` и их
`*.test.ts`.

## Контракт

```ts
export const MIGRATIONS: string[];   // append-only, для bb.storage.migrate(db, MIGRATIONS)
export function createSqliteJobStore(db: Database): JobStore;
```

Схема (миграция 1):

- `jobs(id TEXT PK, plan_json TEXT NOT NULL, state TEXT NOT NULL,
  progress_json TEXT NOT NULL, current_item INTEGER, pending_conflict_json TEXT,
  items_json TEXT NOT NULL, error_json TEXT, created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, initiator_kind TEXT NOT NULL, thread_id TEXT,
  awaits_owner INTEGER NOT NULL DEFAULT 0 CHECK (awaits_owner IN (0,1)))`;
  индекс по `(state, updated_at)`.
- `checkpoints(job_id TEXT, item_index INTEGER, phase TEXT, bytes_done TEXT,
  temp_path_json TEXT, at TEXT, PRIMARY KEY(job_id, item_index))` — хранится
  последняя точка элемента.
- Всё чтение проходит zod-схемы S1 (`OperationJob.parse`); битая строка →
  job помечается `unknown` с ошибкой `internal`, а не падение всего списка.
- `awaitsOwner` — отдельная колонка `awaits_owner`; `update`, переводящий
  job из `pending`, в том же `UPDATE` ставит `awaits_owner = 0`; запись
  `awaits_owner = 1` при `state != 'pending'` отвергается (CHECK или проверка
  до запроса) — инвариант S1.
- `update(..., expectState)` — `UPDATE … WHERE id=? AND state=?`, возврат
  `changes === 1`.
- Хранение: последние 1000 терминальных jobs; старше — удаляются при
  `create` (одна транзакция).
- Пути и имена ни в одной таблице не раскладываются в собственные текстовые
  колонки и не индексируются: путь хранится только как сериализованный
  `ResourcePath` в `*_json`-колонке (`plan_json`, `temp_path_json`), чтобы
  не индексировать содержимое. Checkpoint с `temp_path_json` этому правилу
  соответствует.

## Проверки

Тесты на настоящей better-sqlite3 во временном файле (`mkdtemp`):

- create → get возвращает `deepEqual` исходному job (литерал фикстуры с
  кириллицей, байтовым сегментом и `Size` "18446744073709551615").
- CAS: два `update` с одним `expectState` — первый `true`, второй `false`.
- `pending` + `awaitsOwner: true` → `update({state:"running"}, "pending")` →
  `get` даёт `awaitsOwner: false` без явного поля в patch; попытка
  `awaitsOwner: true` у `running` — отказ, строка не изменена.
- Повреждённый `plan_json` у одной строки → `list` возвращает остальные +
  эту со `state: "unknown"`.
- Закрыть и переоткрыть файл БД → данные на месте (эмуляция рестарта).
- Ретенция: 1001 терминальный job → после следующего `create` их 1000,
  нетерминальные не тронуты.
- `migrate` дважды — идемпотентно.

## Ожидаемый diff

2 модуля + тесты, ~400–600 строк.
