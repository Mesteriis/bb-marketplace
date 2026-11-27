# BB Commander — этап 2a: план реализации

> **Для исполнителей.** Каждая задача ниже — срез. Перед запуском координатор
> (`thr_mn6uyba78h`) пишет по ней `docs/slices/S<n>-*.md` с тестами-литералами
> и раздаёт дешёвому исполнителю в его worktree; ревью — astra + opus; слияние
> `--no-ff` в ветку этапа `feature/commander-stage-2a` (тред Commander
> `thr_ba4dpyzux4`). Шаги — чекбоксы `- [ ]`. Процесс исполнителя:
> superpowers:test-driven-development.

**Цель:** все файловые сценарии этапа 2 на local и SFTP — хеши, сравнение,
поиск с виртуальной панелью, массовое переименование, синхронизация по плану,
архивы ZIP/TAR, просмотр, F4 по серверу, восстановление очереди — приняты
вживую на изолированном BB.

**Архитектура:** записывающие действия остаются `OperationPlan` → `JobRunner`
этапа 1 (новые виды `pack`; переименование пачкой; синхронизация = связка
двух планов). Читающие действия (хеш, сравнение, поиск) — новый лёгкий
`ScanJob` с прогрессом и отменой, без сверки. Архив — read-only `FileProvider`
поверх файла на любом endpoint. Права — существующие `read/write/delete`.

**Стек:** TypeScript, zod 4 (`src/core`), React (`src/ui`), BB Plugin SDK
0.6.132, better-sqlite3 (готовый бинарник), Node `crypto`; библиотеки
архивов — по ADR 0002 (задача 1).

**Спецификация:** [`docs/stage-2-design.md`](../stage-2-design.md) (утверждён
2026-11-27); ТЗ §5, §6, §11; ADR 0001; [`docs/security.md`](../security.md).

## Общие ограничения

- `src/core` импортирует только `zod` и себя; `src/ui` — `react`, core,
  `@/components`, `@/lib`, `@/hooks`; хост только в `src/adapters/bb`,
  `server.ts`, `app.tsx`, `host.ts`. `tests/architecture.test.ts` не ослаблять.
- SDK — только декларации 0.6.132 (`node_modules/@get-bb/plugin-sdk/bundled-types/`);
  каждое `experimental_*` — в список ADR с fallback.
- Ожидаемые значения в тестах — литералы из спецификации, не тем же кодом.
- Fixtures без реальных адресов, секретов и личных путей; временные каталоги —
  `mkdtemp`.
- Перед сдачей: `npm run check`; при правке `package.json` — ещё
  `node ../../scripts/check-manifests.mjs`. Перед слиянием этапа —
  `npm run build`.
- Заимствованный или вендоренный код — запись в `THIRD_PARTY_NOTICES.md` в
  том же изменении.
- Удаления в синхронизации по умолчанию пусты; включаются только явно и
  требуют `delete`.
- Лимиты архивов по умолчанию: 10 ГиБ распакованного, 100 000 записей,
  коэффициент сжатия не больше 1:100; настраиваются.
- Содержимое файла агенту — по праву `read`, не больше 1 МиБ на ответ;
  бинарное — только hex-фрагмент.
- Для remote перед хешем, сравнением с хешем и поиском по содержимому
  показывается объём чтения; поиск по содержимому на remote — только opt-in.
- Активное HTML/SVG в просмотре не исполняется в origin BB.
- Push, теги, установка в рабочий BB — только с «да» владельца.

## Что проверить на ревью

Эти случаи не покрыты прямо ни одной формулировкой дизайна; тесты закреплены
за задачами:

1. Переименование пачкой с циклом имён (`a→b`, `b→a`) и с регистровой
   заменой на регистронезависимой ФС — выполняется через временные имена без
   потери файлов (задача 5).
2. Архив с именами `../x`, `/abs`, `C:\x`, symlink наружу и двумя записями с
   одинаковым именем — распаковка отказывает или переименовывает, ничего не
   пишет за пределы цели (задача 7).
3. Синхронизация, когда файл изменился между планом и запуском, — элемент
   становится конфликтом `source_changed`, а не перезаписью (задача 6).
4. F4: оригинал удалён на сервере во время правки — «Записать обратно»
   предлагает «сохранить рядом» и не создаёт файл молча (задача 9).
5. Поиск на SFTP, упёршийся в лимит, — честно помечен «неполный», отмена
   останавливает чтение в пределах одного запроса (задача 4).

---

### Задача 0: Ветка этапа, миграции и дизайн экранов

Координатор: создать `feature/commander-stage-2a` от `main`; параллельно
провести один проход `/pd` (Design canvas, направление v2) для экранов:
поиск и виртуальная панель, сравнение каталогов, переименование пачкой,
план синхронизации, архив как панель, просмотр, F4 «Записать обратно» с
конфликтом. Владелец смотрит один раз. Артборды — в `docs/design/v2/`.
Задачи 4–9 берут UI отсюда.

- [ ] Ветка создана, `git rev-list --count main..feature/commander-stage-2a` = 0
- [ ] Артборды утверждены владельцем

### Задача 1 (S9): Аудит библиотек и ADR 0002

**Files:** Create `docs/adr/0002-stage-2-io.md`, `research/stage-2-libs.md`;
Modify `docs/security.md` (раздел «Содержимое для агентов»), корневой
`THIRD_PARTY_NOTICES.md` (если выбрана библиотека).

**Produces:** решение: ZIP чтение/запись/шифрование/изменение и TAR
чтение/запись — какая библиотека или Rust-helper, лицензия, версия; diff
текста — библиотека; способ открыть копию в редакторе BB для F4 (проверено в
тестовом BB 0.50.1: `experimental_openFilePreview` правит или только
показывает; fallback — путь/file mention).

- [ ] Таблица кандидатов: функция → библиотека → лицензия → ZIP64 →
      не-UTF-8 имена → шифрование (ZipCrypto/AES) → потоковость → замер
      памяти на fixture 2 ГиБ / 100 000 записей
- [ ] Проба в тестовом BB: открытие копии в редакторе, скриншот
- [ ] ADR 0002 принят координатором; `security.md`: агент читает содержимое
      по `read`, лимит 1 МиБ, бинарное — hex
- [ ] Commit `docs(commander): ADR 0002 stage 2 I/O`

### Задача 2 (S10): ScanJob, хеши и сравнение

**Files:** Create `src/core/scan-job.ts`, `src/core/compare.ts`,
`src/adapters/bb/scan-store-sqlite.ts`, `src/ui/compare-view.tsx` (экран
сравнения и хеша по артборду `compare.html`, добавлен после ревью); Modify `src/adapters/bb/migrations.ts`
(таблица `scan_jobs`), `src/adapters/bb/rpc-handlers.ts`,
`src/adapters/bb/agent-tools.ts`, `src/core/wire/rpc.ts`.
Tests: `src/core/scan-job.test.ts`, `src/core/compare.test.ts`,
`src/adapters/bb/scan-store-sqlite.test.ts`.

**Produces:**
- `type ScanKind = "checksum" | "compare" | "search"`;
  `type ScanState = "running" | "done" | "failed" | "cancelled" | "interrupted"`.
- `interface ScanJob { id: string; kind: ScanKind; initiator: Initiator; endpoints: EndpointId[]; state: ScanState; progress: { items: number; bytes: bigint; bytesPlanned: bigint | null }; partial: boolean; error: CommanderError | null }`.
- `class ScanRunner { start<R>(spec, work: (ctx: ScanContext) => Promise<R>): ScanJob; cancel(id): void; result<R>(id): R | null }`;
  `ScanContext { signal; progress(delta) ; markPartial(reason) }`.
- `checksum(provider, path, signal): Promise<string>` — SHA-256 hex; через
  `provider.sha256` если есть, иначе `readChunks`.
- `compareFiles(a, b, mode: "size" | "sha256" | "bytes", signal): Promise<"same" | "different">`.
- `compareDirs(a, b, opts: { by: "size+mtime" | "sha256"; mtimeToleranceMs: number; limit: number }, signal): Promise<DirDiff>`;
  `DirDiff = { onlyLeft: Entry[]; onlyRight: Entry[]; differ: [Entry, Entry][]; same: number; partial: boolean }`.
- `estimateRead(entries): bigint` — объём чтения до старта.
- RPC и tools: `scan_start`, `scan_get`, `scan_cancel`; tools
  `commander_checksum`, `commander_compare` (право `read` на оба endpoint).

- [ ] Test `checksum of "abc" is ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad` — падает
- [ ] Test `compareDirs size+mtime: mtime differs by 1500 ms with tolerance 2000 → same; by 2500 → differ`
- [ ] Test `cancel during checksum stops within one chunk (≤ 1 read after cancel)`
- [ ] Test `restart marks running scan as interrupted, not done`
- [ ] Test `agent without read on right endpoint → forbidden, same text as planner refusals`
- [ ] Реализация; `npm run check` зелёный; commit

### Задача 3 (S17): Восстановление очереди

**Files:** Modify `src/core/job-runner.ts`, `src/core/job-machine.ts`,
`src/adapters/bb/rpc-handlers.ts`, `src/core/wire/rpc.ts`, `src/ui/queue.tsx`.

**Produces:** `retryJob(jobId, initiator): Promise<OperationPlan>` — новый
план только из элементов `failed | unknown`, построенный через `revalidate`;
`unknown` сначала сверяется `reconcileItem`, подтверждённые `done` не
повторяются. RPC `job_retry`; кнопка «Повторить невыполненное» в очереди.

- [ ] Test `retry of job with items [done, failed, unknown(confirmed done)] plans exactly 1 item`
- [ ] Test `retry after lost RPC response (outcome_unknown) does not write twice (mock counts 1 commit)`
- [ ] Test `retry by agent requires the same grants as the original`
- [ ] Реализация; commit

#### Реализация S17: границы повтора

- Повтор берёт задание в конечном состоянии (`completed`, `failed`, `cancelled`, `unknown`).
  Задание в `running`, `pending`, `awaiting_decision`, `cancel_requested`, `interrupted` не повторяется.
- Кандидаты: `failed`, `pending` (не начинались) и `unknown`, которые сверка не подтвердила как
  применённые. Элемент `done`, подтверждённый сверкой, записывается как `done` и в план не входит.
- Файлы внутри каталога, чьё создание осталось `unknown` без подтверждения, в план не входят и
  считаются (`excluded`, причина `parent_unconfirmed`). Пустой план — не ошибка: `plan: null`.
- Пропущенные элементы повторяются только если ранер пропустил их из-за каталога выше
  (причина записана в элементе). Явный пропуск владельца на конфликте не повторяется.
  Литерал старого задания: каталог `failed`, потомок `skipped` с `error: null` (до появления
  причины) — в плане только каталог; тест `retry plans a failed directory alone ...`.
  Признак причины — константа `parentSkipNote` в `src/core/retry-note.ts`, менять её нельзя.
- Кнопка «Повторить невыполненное» показывается, если в элементах есть `failed`, `pending`,
  `unknown` или `skipped` с причиной каталога.
- Агент: сверка `unknown` требует право `write` на каталог цели (как автозапуск). Без него
  повтор отказывает тем же текстом, что и планирование, и ничего не удаляется.
- Отмена запроса действует на весь проход повтора, включая итоговый `revalidate`; план
  сохраняется только после проверки отмены.
- Сверка `unknown` может **удалить временный файл, который создала очередь**, по записанным
  свидетельствам (`reconcileItem` → `recoverTemp`). Это происходит до того, как план существует:
  повтор не показывает владельцу удаляемое заранее. Сверку прерывает отмена запроса RPC и
  остановка раннера.
- Агентский путь: инструмент `commander_retry` использует ту же проверку гранта, что и
  `job_retry`; план остаётся на стороне хоста, агенту отдаётся тикет (`id`, `digest`).
  Чужой поток отказывает по владению до любой проверки гранта.

### Задача 4 (S11): Поиск и виртуальная панель

Решение координатора: результаты поиска — список настоящих `ResourceRef` на
одном endpoint, а не новый endpoint; операции над результатами строят обычные
планы. Источник `search:` из дизайна сведён к этому.

**Files:** Create `src/core/search.ts`, `src/core/glob.ts`,
`src/ui/search-panel.tsx`; Modify `src/ui/pane.tsx`, `src/core/planner.ts`
(источники из разных каталогов одного endpoint), `agent-tools.ts`.

**Consumes:** `ScanRunner` (задача 2).
**Produces:**
- `interface SearchQuery { root: ResourceRef; name?: { glob: string } | { regex: string }; minSize?: bigint; maxSize?: bigint; modifiedAfter?: string; modifiedBefore?: string; content?: { text: string; caseSensitive: boolean }; limits: { maxDepth: number; maxEntries: number; maxBytesRead: bigint } }`.
- `search(query, providers, ctx): AsyncIterable<SearchHit>`;
  `SearchHit = { ref: ResourceRef; entry: Entry; line?: { number: number; text: string } }`.
- Лимиты по умолчанию: `maxDepth 32`, `maxEntries 100 000`,
  `maxBytesRead` local 1 ГиБ, SFTP 0 (содержимое только opt-in).
- Tool `commander_search` (право `read`; строки совпадений — по решению
  владельца, усечены до 200 символов).

- [ ] Test `glob "*.TXT" matches "a.txt" only when caseInsensitive endpoint`
- [ ] Test `regex "(a+)+$" on 50 "a"+"!" finishes in < 100 ms or is refused as unsafe`
- [ ] Test `SFTP content search without opt-in → refused with code content_search_needs_consent`
- [ ] Test `maxEntries 3 on 5 files → 3 hits, partial: true`
- [ ] Test `cancel stops listing within one page`
- [ ] Test `copy of 2 hits from different dirs builds one plan with 2 items`
- [ ] UI по артборду задачи 0; Playwright-снимок 1440×900; commit

### Задача 5 (S12): Массовое переименование

**Files:** Create `src/core/rename-pattern.ts`, `src/ui/batch-rename.tsx`;
Modify `src/core/planner.ts` (rename с N элементами), `src/core/job-runner.ts`
(двухфазное выполнение через временные имена), `agent-tools.ts`.

**Produces:**
- `interface RenamePattern { template: string; find?: { text: string } | { regex: string }; replace?: string; case?: "keep" | "lower" | "upper" | "title"; counter?: { start: number; step: number; width: number } }`;
  шаблон: `[N]` имя, `[E]` расширение, `[C]` счётчик, `[N1-3]` срез.
- `previewRename(entries, pattern): RenamePreview[]`;
  `RenamePreview = { from: NameSegment; to: NameSegment | null; problem: null | "empty" | "invalid_name" | "duplicate" | "exists" }`.
- План `rename` с `items.length ≤ 10 000`; выполнение: фаза 1 — все в
  `tempNameFor(jobId, i)`, фаза 2 — в целевые имена; при сбое фазы 2 —
  чекпоинт и сверка.

- [ ] Test `template "[N]_[C]" counter{1,1,3} on ["a.txt","b.txt"] → ["a_001.txt","b_002.txt"]`
- [ ] Test `cycle a→b, b→a completes; both files present with swapped names`
- [ ] Test `two sources mapping to "x.txt" → problem "duplicate", plan refused`
- [ ] Test `case-only "A.txt"→"a.txt" on case-insensitive endpoint succeeds`
- [ ] Test `crash between phases → reconcile restores or finishes, no file lost`
- [ ] UI с preview; commit

### Задача 6 (S13): План синхронизации

**Files:** Create `src/core/sync.ts`, `src/ui/sync-dialog.tsx`;
Modify `src/adapters/bb/rpc-handlers.ts`, `src/core/wire/rpc.ts`,
`agent-tools.ts`.

**Consumes:** `compareDirs` (задача 2), `buildPlan`, `revalidate`.
**Согласованное отклонение:** S13 добавляет в `src/core/model.ts`
опциональные поля `OperationPlanBase.syncId` и `PlanItem.requireAbsent`.
Второе поле допустимо только в delete-плане с `syncId` и указывает путь,
который должен отсутствовать на противоположной стороне. Оба поля при наличии
входят в digest. Планы этапа 1 сохраняют прежний digest, а SQLite хранит поля
в `plan_json` без миграции.
**Produces:**
- `interface SyncRequest { left: ResourceRef; right: ResourceRef; direction: "left-to-right" | "right-to-left" | "both"; by: "size+mtime" | "sha256"; includeDeletes: boolean; filters?: { exclude: string[] } }`.
- `buildSyncPlan(req, deps): Promise<SyncPlan>`;
  `SyncPlan = { id: string; copies: OperationPlan[]; deletes: OperationPlan | null; conflicts: { left: Entry; right: Entry; reason: "target_newer" | "differs" }[] }`.
  `deletes` = `null` при `includeDeletes: false`; при `true` — отдельный
  `delete`-план, подтверждается отдельно и требует `delete`.
- Запуск: каждый план — обычное задание с `syncId`; перед запуском
  `revalidate`. Отсутствие пути для удаления проверяется при запуске, при
  подтверждении отложенного задания и непосредственно перед `remove`. Если
  путь появился, конфликт предлагает пропуск или отмену. При запуске владельцем
  такой конфликт сохраняется до первого удаления в задании. Каждый вложенный
  элемент наследует проверку отсутствия корня сравниваемого поддерева, даже
  если по другую сторону появился пока пустой каталог. Список и объём
  удалений учитывают вложенные элементы.
- Сравнение S10 сопоставляет непосредственных потомков. Неполное сравнение
  блокирует план. Фильтр `exclude` принимает точные имена потомков на обеих
  сторонах. В режиме «В обе стороны» удаление недоступно: для него нужно
  выбрать одну сторону назначения. Новые и обновляемые файлы можно
  подтвердить независимо. Удаления имеют отдельный список и подтверждение.

- [ ] Test `includeDeletes false, right-only file → deletes null, file untouched after run`
- [ ] Test `includeDeletes true → deletes plan with exactly the right-only entries`
- [ ] Test `direction both, file changed on both sides → conflict differs, not copied`
- [ ] Test `source changed after plan → item conflict source_changed`
- [ ] Test `agent with write but no delete: includeDeletes true → deletes plan awaits owner`
- [ ] UI по артборду; commit

### Задача 7 (S14): Архивы как источник и создание

**Files:** Create `src/core/archive-guard.ts`,
`src/adapters/bb/archive-provider.ts`, `src/adapters/bb/archive-writer.ts`;
Modify `src/core/model.ts` (`EndpointId` += `archive:<uuid>`,
`OperationKind` += `pack`), `src/core/permissions.ts` (`pack`: source
`read`, target `write`), `src/core/planner.ts`, `src/core/job-runner.ts`,
`src/adapters/bb/migrations.ts` (тест: задания этапа 1 читаются),
`src/ui/pane.tsx`.

**Consumes:** ADR 0002 (задача 1).
**Produces:**
- `ArchiveProvider implements FileProvider` — `list/stat/read`; остальное —
  `unsupported`; открывается по `(endpoint, path, fingerprint)`; отпечаток
  архива проверяется при каждом чтении.
- `checkEntryName(name): NameSegment[] | "refused"` — отказ для `..`,
  абсолютных, дисковых, пустых сегментов, NUL.
- `ExtractLimits = { maxTotalBytes: 10 * 2**30; maxEntries: 100_000; maxRatio: 100 }`.
- Распаковка = план `copy` из `archive:` в цель; создание = план `pack`
  (temp + rename с `expectTarget`); изменение существующего — перепаковка в
  temp + rename, только если ADR 0002 подтвердил библиотеку.
- Пароль: запрос владельца через диалог, в памяти процесса до закрытия
  архива; агент пароль не передаёт и не получает.

- [ ] Test `entries "../x", "/abs", "C:\\x", "a/../../b" → refused, nothing written`
- [ ] Test `symlink entry pointing outside target → extracted as refused item`
- [ ] Test `zip bomb fixture (ratio 1:1000) → stops with limit_exceeded before 101× compressed size written`
- [ ] Test `100 001 entries → limit_exceeded at plan time`
- [ ] Test `archive changed on disk while open → changed_since_plan`
- [ ] Test `stage-1 job rows load after migration (fixture DB from main@b44884df)`
- [ ] Test `pack of 3 files then list shows the same 3 names and sizes`
- [ ] UI: Enter на архиве открывает его как панель; commit

### Задача 8 (S15): Просмотр (F3)

**Files:** Create `src/core/preview.ts`, `src/ui/viewer.tsx`;
Modify `src/ui/workspace.tsx`, `agent-tools.ts` (`commander_read`).

**Produces:**
- `detectKind(name, head: Uint8Array): "text" | "image" | "binary"`;
  `readForView(provider, path, opts: { offset: bigint; length: number }, signal)`,
  `length ≤ 1 MiB`.
- Просмотр текста/кода с подсветкой синтаксиса средствами BB или своим
  `<pre>`; hex — 16 байт в строке; изображения — `blob:` URL в `<img>`
  (SVG — только как `<img>`, не inline); HTML — как текст.
- Tool `commander_read` (право `read`, лимит 1 МиБ, бинарное → hex).
- Решения координатора после ревью: лимит 1 МиБ — на весь результат tool с
  оболочкой; агенту только текст или hex; владельцу изображения до 32 МиБ из
  окон одной версии. На локальном F3 при успешном нативном просмотре BB
  (`onPreview`) показывается просмотр BB, а не наш `viewer.tsx`: гарантии
  DOM-тестов (SVG только `<img>`, HTML текстом) относятся только к нашему
  просмотру.

- [ ] Test `svg file renders via <img src=blob:>, no <svg> element in DOM`
- [ ] Test `html file shows source text; no iframe/script in DOM`
- [ ] Test `commander_read 2 MiB file → 1 MiB and truncated: true`
- [ ] Test `binary → hex lines "00000000  89 50 4e 47 …"`
- [ ] Commit

### Задача 9 (S16): F4 по серверу

**Files:** Create `src/core/edit-session.ts`, `src/ui/edit-bar.tsx`;
Modify `src/adapters/bb/rpc-handlers.ts`, `src/core/wire/rpc.ts`.

**Consumes:** `checksum` (задача 2), `readForView`/способ открытия (задачи
1, 8), `buildPlan`.
**Produces:**
- `openEdit(ref): Promise<EditSession>`;
  `EditSession = { id: string; ref: ResourceRef; base: Fingerprint & { sha256: string }; copyPath: string }`
  (копия в каталоге данных плагина).
- `writeBack(sessionId, choice?: "overwrite" | "save-beside"): Promise<WriteBackResult>`;
  `WriteBackResult = { kind: "written"; jobId: string } | { kind: "conflict"; reason: "changed" | "deleted"; current: Fingerprint | null }`.
  Без `choice` и с неизменным оригиналом — план `copy` с
  `expectTarget = base`; при изменении — конфликт; `save-beside` пишет
  `name (edited).ext` с `expectTarget: "absent"`.
- `closeEdit(sessionId)` удаляет копию.

- [ ] Test `unchanged original → written; target sha256 equals edited copy`
- [ ] Test `original changed after open → conflict changed; target untouched`
- [ ] Test `original deleted → conflict deleted; save-beside creates "a (edited).txt"`
- [ ] Test `closeEdit removes copy file`
- [ ] UI «Записать обратно»; commit

### Задача 10 (S18): Нагрузка и сквозные проверки

**Files:** Create `tests/fixtures/stage-2/README.md` (генератор, без
бинарных файлов в git), `scripts/gen-fixtures.mjs`, `docs/stage-2a-acceptance.md`.

- [ ] Fixtures: 1 файл 4 ГиБ, 100 000 файлов по 1 КиБ, Unicode/NFD, имена
      255 байт, путь 1024 байта, symlink-цикл, файл без прав
- [ ] Замер до оптимизации: пиковая память, время до первой отрисовки
      панели 100 000 записей, поиск по 100 000; цели записать по замеру
- [ ] Сквозной список ТЗ «Сквозные проверки» — строка на пункт со статусом
      `проверено вживую | на моке | не проверено`
- [ ] Живая приёмка на изолированном BB (local + SFTP), снимки
- [ ] Известные нестабильности (раздел ниже): облегчить фикстуры или вынести
      тяжёлые тесты в отдельный проект vitest с явным лимитом; таймауты
      вслепую не поднимать

### Задача 11: Приёмка и слияние

- [ ] `npm run check`, `npm run build`, `check-manifests` на ветке этапа
- [ ] `bb.description`, `PLUGIN_OVERVIEW.md`, запись `marketplace.json`
      описывают новое поведение
- [ ] Слияние в `main`; push — с «да» владельца

## Порядок

Волна 1 (параллельно): 1, 2, 3, 8 и дизайн из задачи 0. Волна 2: 4, 5, 6
(после 2), 7 (после 1). Волна 3: 9 (после 1, 2, 8), 10. Затем 11.
Задача 5 не ждёт задачу 2 и идёт во второй волне только из-за общей правки
`planner.ts` с задачей 4 — их ветки сливаются последовательно.

## Живая проверка SFTP 2026-11-27

Стенд: изолированный BB 0.50.1 (свои `--data-dir`, HOME и связка ключей),
Commander из `feature/commander-hostkey` (`e33670e0`, включает курсор S5),
Remote Hub `9da1d6bb`, тестовый sshd (Alpine) в Docker на `127.0.0.1:52785`.
Вызовы через CLI `bb makosh-commander`; интерфейс в живом BB не проверялся.

| Сценарий | Результат |
|---|---|
| Неизвестный ключ хоста | `host_key_rejected` (раньше `connection_failed`) |
| Листинг `/` после доверия ключу | работает |
| Копирование локально → SFTP, 5 МиБ, имя с кириллицей | `completed`, SHA-256 совпал |
| Копирование SFTP → локально | `completed`, SHA-256 совпал |
| Повторная загрузка того же файла | `awaiting_decision`, `reason: exists`; отмена работает |
| Цель — каталог `root` 0555 | `failed`, `permission_denied`, файлов нет |
| Смена ключа sshd | аудит `host_key_changed`, Commander `host_key_rejected` (после reload плагина) |
| Отзыв гранта | закрыт 1 канал, `ls` → `consent_required`, эндпоинт `readOnly` |
| Обрыв (`docker pause` посреди 256 МиБ) | через ~60 с `unknown`, `outcome_unknown` |

Находки:

1. После `outcome_unknown` на сервере оставался `.commander-<uuid>-0.part`
   (108 МиБ, 0644), а `progress.bytesDone` показывал 0. Закрыто срезом S5-live.
   Прогресс сохраняет последний подтверждённый чекпоинт элемента поверх
   ранее завершённых байтов. Неизвестность исхода выражена состоянием задания
   и исходом элемента. Тесты с SFTP-моком подтверждают, что повтор S17 удаляет
   временный файл один раз у владельца и у агента с правом записи на каталог
   цели. Без этого права файл остаётся.
2. Смена ключа на стенде проверялась после reload Commander. Закрыто срезом
   S5-live: тесты на уже открытом SFTP-провайдере подтверждают
   `host_key_rejected` при чтении и записи после отказа Remote Hub.
3. Профиль Remote Hub `authType: "agent"` даёт `auth_failed`: `~/.ssh/config`
   владельца задаёт `IdentityAgent` (1Password) и `IdentitiesOnly yes`, поэтому
   `SSH_AUTH_SOCK` не используется. Проверка шла профилем `key` с
   `identityFile`. Вопрос Remote Hub.
4. Профиль с паролем — общий `failure` в аудите Remote Hub, Commander
   показывает `connection_failed`. Причина не выяснена; вопрос Remote Hub.

Стенд удалён: контейнер, образ, тестовый ssh-agent, каталог стенда со
связкой ключей и тестовыми ключами, запись тестового хоста в
`~/.ssh/known_hosts`.

## Известные нестабильности

На ветке этапа после слияния S15 (`ada29356`) в одном полном прогоне
`npm run check` из трёх упали 3 теста по таймауту: около 6 с при лимите 5 с.
По отдельности они проходят (108/108), следующие два полных прогона зелёные.

- `tests/file-read.test.ts` — owner RPC switches a text file to hex with mode binary;
- `src/core/planner.test.ts` — rejects 100001 items with limit_exceeded;
- `src/core/preview.test.ts` — shows 600 KiB of 0x01 bytes as binary.

Владелец исправления — S18 (задача 10): облегчить фикстуры или вынести
тяжёлые тесты в отдельный проект vitest с явным лимитом. Таймауты вслепую
не поднимать.
