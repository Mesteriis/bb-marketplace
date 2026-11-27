# S3. Jobs: автомат состояний, исполнитель, конфликты, reconciliation

## Цель

Исполнить утверждённый `OperationPlan` через порты `FileProvider` и
`JobStore`: потоковая передача кусками с ограничением памяти, конфликты по
элементам, отмена, контрольные точки, восстановление после рестарта без
слепого повтора записи.

## Принятые пути

`src/core/job-store.ts` (первая задача среза — сдать отдельно, от него зависит
S6), `src/core/job-machine.ts`, `src/core/job-runner.ts`,
`src/core/reconcile.ts`, `src/core/testing/fake-provider.ts`,
`src/core/testing/memory-job-store.ts` и `*.test.ts`.

Исключение владения: S3 правит `src/core/provider.ts` (S1) — и только
этими изменениями:
- `WriteSession` получает `readonly tempPath: ResourcePath` (путь временного
  файла, который реализация создала рядом с целью);
- `rename(from, to, { replace, expectTarget?: Fingerprint | "absent" })` и
  `remove(path, { kind, expect?: Fingerprint })` — провайдер сверяет
  отпечаток непосредственно перед действием и при расхождении бросает
  `changed_since_plan`.
Это первая задача среза вместе с `job-store.ts`: от неё зависят S4, S5, S6.
Порядок слияния: S2 → S3 → S6, S4, S5.

## Контракт

```ts
// job-store.ts — порт хранения (реализация SQLite в S6, in-memory в testing/)
export interface Checkpoint {
  jobId: string; itemIndex: number;
  phase: "copying" | "committed" | "verified" | "source_removed";
  bytesDone: Size;
  tempPath: ResourcePath | null;                       // из WriteSession.tempPath
  targetPath: ResourcePath | null;
  expectTarget: Fingerprint | "absent" | null;        // из PlanItem или решения конфликта
  verified: { size: Size; sha256?: string } | null;    // заполняется в фазе verified
}
export interface JobStore {
  create(job: OperationJob): Promise<void>;
  get(id: string): Promise<OperationJob | null>;
  list(filter: { states?: JobState[]; limit: number }): Promise<OperationJob[]>;
  update(id: string, patch: Partial<Pick<OperationJob, "state"|"progress"|"currentItem"|"pendingConflict"|"items"|"error"|"updatedAt"|"awaitsOwner">>, expectState: JobState): Promise<boolean>; // CAS по state
  // awaitsOwner меняется только при state pending; переход из pending в любое
  // другое состояние атомарно (в том же update) сбрасывает его в false —
  // реализации делают это сами, даже если patch его не передал. Результат
  // проходит инварианты OperationJob S1 (superRefine).
  checkpoint(c: Checkpoint): Promise<void>;
  lastCheckpoint(jobId: string, itemIndex: number): Promise<Checkpoint | null>;
}

// job-machine.ts — чистая функция переходов
export type JobEvent =
  | "start" | "conflict" | "decide" | "item_done" | "all_done" | "fail"
  | "cancel" | "cancel_done" | "process_lost" | "reconciled_done" | "reconciled_unknown" | "resume";
export function transition(state: JobState, ev: JobEvent): JobState;  // недопустимый переход → CommanderError internal
// Таблица: pending -start→ running; running -conflict→ awaiting_decision -decide→ running;
// running -all_done→ completed; running -fail→ failed; running|awaiting_decision|pending -cancel→ cancel_requested -cancel_done→ cancelled;
// running|cancel_requested -process_lost→ interrupted; interrupted -reconciled_done→ completed|… (см. reconcile),
// interrupted -reconciled_unknown→ unknown; interrupted -resume→ running. Терминальные: completed, failed, cancelled, unknown.

// job-runner.ts
export interface RunnerDeps {
  store: JobStore;
  provider(endpoint: EndpointId): FileProvider;
  now(): Date; uuid(): string;
  chunkBytes: number;              // по умолчанию 4 MiB, ≤ READ_CHUNK_MAX
  onEvent(e: { jobId: string; kind: "progress" | "state" | "conflict" }): void;   // для realtime, без путей
}
export class JobRunner {
  constructor(deps: RunnerDeps);
  submit(plan: OperationPlan, opts?: { awaitsOwner: boolean }): Promise<OperationJob>;  // pending; при awaitsOwner не исполняется до approve
  approve(jobId: string): Promise<void>;                  // снимает awaitsOwner, revalidate плана, затем start
  reject(jobId: string): Promise<void>;                   // pending → cancel_requested → cancelled, ни одной записи
  decide(jobId: string, d: ConflictDecision): Promise<void>;
  cancel(jobId: string): Promise<void>;                    // cancel_requested; AbortSignal в текущий шаг
  recover(): Promise<{ resumed: string[]; unknown: string[] }>;   // вызывается при старте сервера
}
```

Правила исполнения (каждое — тест):

1. Перед каждым элементом `stat` источника и цели; цель сверяется с
   `PlanItem.expectTarget` (расхождение → конфликт `target_changed`).
   В `rename`/`remove`/`commit` передаётся ожидаемый отпечаток, чтобы
   провайдер сверил его непосредственно перед действием. Источник не совпал с
   `fingerprint` плана → конфликт `source_changed` (не политика, всегда
   спрашивать). Цель существует → по `conflictPolicy`; `ask` →
   `awaiting_decision`, исполнение элемента ждёт `decide`.
2. `applyTo: "remaining_same_reason"` применяет решение к последующим
   конфликтам той же причины в этом job, не в других.
3. Копирование: `same-endpoint` и есть `copyWithin` → он; иначе цикл
   `read(chunk)` → `session.write` последовательно (в памяти не больше одного
   куска на job), затем `commit({replace, expectTarget})`. Для `overwrite`
   `replace=true`, `expectTarget` = отпечаток цели, снятый при решении.
4. Проверка после commit: `verify: "size"` — размер; `"sha256"` — хэш
   источника (считается по ходу чтения) против `sha256` назначения (если у
   провайдера нет `sha256` — повторное чтение назначения).
5. `move`: источник удаляется только после `verified`; между провайдерами —
   copy+verify+remove; на одном endpoint — `rename` (EXDEV-подобный
   отказ → copy+verify+remove).
6. Контрольная точка перед `commit` (`copying`, tempName) и после
   (`committed`, `verified`, `source_removed`).
7. Отмена: `AbortSignal` в текущий вызов, `session.abort()` временного
   файла, элементы после текущего — `pending`; итог показывает, какие
   элементы `done`. Частичный файл назначения не остаётся (только temp,
   который удаляется); если abort не подтвердился — элемент `unknown`.
8. `recover()`: job в `running`/`cancel_requested`/`awaiting_decision` после
   рестарта → `interrupted`; по последнему checkpoint: `copying` → stat
   цели и temp: цель не тронута → temp удалить, элемент `pending`, job
   `resume`; `committed` без `verified` → проверить по правилу 4;
   неоднозначно (цель изменилась, temp пропал, провайдер недоступен) →
   элемент `unknown`, job `unknown`. Никакого повтора записи без сверки.
9. Ошибка провайдера `retryable` → до 3 попыток с задержкой (через
   `now`/инъекцию таймера, не реальный sleep в тестах); иначе элемент
   `failed`, job продолжает остальные и заканчивается `failed`, если был хоть
   один `failed`.

`testing/fake-provider.ts` — in-memory `FileProvider` с внедрением сбоев
(`failOn: {op, path, times, error}`), задержек по сигналу, регистро-
(не)чувствительностью; `testing/memory-job-store.ts` — `JobStore` в памяти.

## Проверки

- Таблица переходов: каждый допустимый — литерал результата, 3 недопустимых
  → `internal`.
- Копирование 10 МБ при `chunkBytes = 1 MiB`: ровно 10 вызовов `read`,
  максимальный одновременно живой буфер ≤ 1 MiB (fake считает).
- Конфликт `ask` → `awaiting_decision`; `decide(skip, this)` → элемент
  `skipped`, следующий конфликт снова спрашивает; `remaining_same_reason` —
  не спрашивает.
- Источник изменён между планом и исполнением → `source_changed`, даже при
  политике `overwrite`.
- Move: сбой verify → источник не удалён, элемент `failed`.
- Отмена посреди файла → temp удалён, цель не создана, job `cancelled`,
  `items` = `[done, pending, …]`.
- `submit(plan, {awaitsOwner:true})` → ни одного вызова провайдера до
  `approve`; `reject` → `cancelled`, провайдер не вызывался.
- Recover: три сценария правила 8 → `resumed`, `resumed` (после verify),
  `unknown`.
- Ошибка `retryable` дважды, затем успех → `done`; трижды неретрайная →
  `failed`.

## Ожидаемый diff

4 модуля + 2 testing-модуля + тесты, ~1200–1800 строк.
