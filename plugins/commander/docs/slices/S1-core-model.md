# S1. Модель ядра: адреса, записи, план, job, ошибки, порт провайдера

## Цель

Типизированный словарь ядра из ТЗ §6 — единый для UI, CLI, agent tools,
host entry и провайдеров. Только схемы, чистые функции и интерфейсы; без I/O.

## Принятые пути

`src/core/model.ts`, `src/core/provider.ts`, `src/core/errors.ts`,
`src/core/size.ts`, `src/core/path.ts` и `*.test.ts` рядом.

## Контракт

### `src/core/size.ts`

Размеры и смещения в проводе — десятичные строки (JSON не держит > 2^53),
внутри — `bigint`.

```ts
export const Size = z.string().regex(/^(0|[1-9]\d{0,19})$/);      // ≤ 20 цифр
export type Size = z.infer<typeof Size>;
export function toBig(s: Size): bigint;                            // "5368709120" → 5368709120n
export function fromBig(n: bigint): Size;                          // отрицательное → throw RangeError
export function addSize(a: Size, b: Size): Size;
```

### `src/core/path.ts`

Имя и путь не сводятся к локальной строке. Путь — абсолютный, POSIX-разделитель
`/`, сегменты — байты.

```ts
// Сегмент: либо UTF-8 текст (без "/" и "\0"), либо сырые байты base64,
// если имя не декодируется как UTF-8. Текст и байты не смешиваются молча.
export const NameSegment = z.union([
  z.object({ t: z.string().min(1).max(1024).refine(s => !s.includes("/") && !s.includes("\0") && s !== "." && s !== "..") }).strict(),
  z.object({ b: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/).max(1400) }).strict(),
]);
export const ResourcePath = z.object({ segments: z.array(NameSegment).max(4096) }).strict();  // [] = корень
export function parsePosix(text: string): ResourcePath;   // "/a/b" → {segments:[{t:"a"},{t:"b"}]}; "a" или ".."-сегмент → CommanderError invalid_path
export function displayPath(p: ResourcePath): string;     // байтовый сегмент показывается как "\x.."-escape, не U+FFFD
export function join(p: ResourcePath, name: NameSegment): ResourcePath;
export function parent(p: ResourcePath): ResourcePath | null;  // корень → null
export function isAncestorOrSelf(a: ResourcePath, b: ResourcePath, caseSensitive: boolean): boolean;
export function samePath(a: ResourcePath, b: ResourcePath, caseSensitive: boolean): boolean;
```

Сравнение без учёта регистра — только для текстовых сегментов, через
`toLowerCase()` после NFC; байтовые сравниваются побайтно всегда.
Unicode-нормализация при хранении не выполняется (имя хранится как есть).

### `src/core/model.ts`

```ts
export const ProviderKind = z.enum(["local", "sftp"]);
export const EndpointId = z.string().regex(/^(host:[A-Za-z0-9_-]{1,64}|sftp:[0-9a-f-]{36})$/);
export const Endpoint = z.object({
  id: EndpointId,
  provider: ProviderKind,
  label: z.string().max(200),
  machine: z.string().max(200),            // на какой машине лежат файлы (имя BB-хоста или host:port SFTP)
  hostId: z.string().nullable(),           // BB host для local, null для sftp
  readOnly: z.boolean(),
  caseSensitive: z.boolean(),
}).strict();

export const ResourceRef = z.object({ endpoint: EndpointId, path: ResourcePath }).strict();

export const EntryKind = z.enum(["file", "dir", "symlink", "other"]);
export const TimePrecision = z.enum(["ns", "us", "ms", "s", "unknown"]);
export const Entry = z.object({
  name: NameSegment,
  kind: EntryKind,
  size: Size,
  mtimeNs: z.string().regex(/^-?\d{1,22}$/).nullable(),
  mtimePrecision: TimePrecision,
  mode: z.number().int().min(0).max(0o177777).nullable(),
  linkTarget: z.string().max(4096).nullable(),   // как прочитано, для показа; не разрешается
  hidden: z.boolean(),
}).strict();

export const Capability = z.enum([
  "list", "stat", "read", "write", "mkdir", "rename", "remove",
  "atomicReplace", "serverSideCopy", "seek", "checksum", "watch", "trash", "permissions",
]);

export const Fingerprint = z.object({
  size: Size,
  mtimeNs: z.string().regex(/^-?\d{1,22}$/).nullable(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
}).strict();

export const Permission = z.enum(["observe", "read", "write", "delete", "exec", "admin"]);

export const Initiator = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("owner") }).strict(),
  z.object({ kind: z.literal("agent"), threadId: z.string().min(1).max(64) }).strict(),
]);

export const OperationKind = z.enum(["copy", "move", "rename", "mkdir", "delete"]);
export const ConflictPolicy = z.enum(["ask", "overwrite", "skip", "rename", "overwriteIfNewer"]);
export const Route = z.enum(["same-endpoint", "relay-server"]);
export const Verify = z.enum(["size", "sha256"]);

export const PlanItem = z.object({
  source: ResourceRef.nullable(),          // null для mkdir
  target: ResourceRef.nullable(),          // null для delete
  kind: EntryKind,
  fingerprint: Fingerprint.nullable(),     // источника на момент плана; null для mkdir
  // После ревью S3 (решение координатора): + expectTarget: Fingerprint | "absent" | null —
  // состояние цели на момент плана, входит в digest; правит S2 (исключение владения).
}).strict();

export const OperationPlan = z.object({
  id: z.string().uuid(),
  kind: OperationKind,
  createdAt: z.string().datetime(),
  initiator: Initiator,
  sourceEndpoint: EndpointId.nullable(),
  targetEndpoint: EndpointId.nullable(),
  items: z.array(PlanItem).min(1).max(100_000),
  conflictPolicy: ConflictPolicy,
  route: Route,
  verify: Verify,
  totalBytes: Size,
  digest: z.string().regex(/^[0-9a-f]{64}$/),   // SHA-256 канонического JSON плана без digest
}).strict();

export const JobState = z.enum([
  "pending", "running", "awaiting_decision", "completed", "failed",
  "cancel_requested", "cancelled", "interrupted", "unknown",
]);

export const ConflictReason = z.enum(["exists", "source_changed", "target_changed", "type_mismatch"]);
export const Conflict = z.object({
  id: z.string().uuid(),
  jobId: z.string().uuid(),
  itemIndex: z.number().int().min(0),
  reason: ConflictReason,
  source: Fingerprint.nullable(),
  target: Fingerprint.nullable(),
}).strict();

export const ConflictAction = z.enum(["overwrite", "skip", "rename", "cancel"]);
export const ConflictDecision = z.object({
  conflictId: z.string().uuid(),
  action: ConflictAction,
  applyTo: z.enum(["this", "remaining_same_reason"]),
}).strict();

export const JobProgress = z.object({
  itemsDone: z.number().int().min(0),
  itemsTotal: z.number().int().min(0),
  bytesDone: Size,
  bytesTotal: Size,
}).strict();

export const ItemOutcome = z.enum(["pending", "done", "skipped", "failed", "unknown"]);

export const OperationJob = z.object({
  id: z.string().uuid(),
  plan: OperationPlan,
  state: JobState,
  progress: JobProgress,
  currentItem: z.number().int().min(0).nullable(),
  pendingConflict: Conflict.nullable(),
  awaitsOwner: z.boolean(),               // план агента вне гранта или с удалением: ждёт plan_approve (S7)
  items: z.array(z.object({ outcome: ItemOutcome, error: z.string().max(500).nullable() }).strict()),
  error: CommanderErrorShape.nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();
```

Плюс `export type X = z.infer<typeof X>` для каждой схемы и
`planDigest(plan: Omit<OperationPlan, "digest">): Promise<string>` через
`crypto.subtle` (глобальный Web Crypto, не `node:crypto`), канонический JSON —
ключи по алфавиту.

### `src/core/errors.ts`

```ts
export const ErrorCode = z.enum([
  "invalid_path", "not_found", "already_exists", "not_a_directory", "is_a_directory",
  "permission_denied", "read_only", "no_space", "changed_since_plan",
  "connection_failed", "host_key_rejected", "auth_failed", "consent_required",
  "cancelled", "timeout", "unsupported", "limit_exceeded", "outcome_unknown", "internal",
]);
export const CommanderErrorShape = z.object({ code: ErrorCode, message: z.string().max(500), retryable: z.boolean() }).strict();
export class CommanderError extends Error { constructor(code: ErrorCode, message: string, retryable?: boolean); toShape(): CommanderErrorShape }
export function isCommanderError(e: unknown): e is CommanderError;
```

Сообщения не содержат секретов, путей ключей, содержимого файлов.

### `src/core/provider.ts` — порт провайдера

```ts
export interface ListPage { entries: Entry[]; cursor: string | null }
export interface WriteSession {
  write(offset: bigint, bytes: Uint8Array, signal: AbortSignal): Promise<void>;
  // replace=false: atomically fail with already_exists if target exists.
  // expectTarget: target must still match (changed → target_changed).
  commit(opts: { replace: boolean; expectTarget: Fingerprint | null }, signal: AbortSignal): Promise<Fingerprint>;
  abort(): Promise<void>;       // удаляет временный файл; идемпотентно
  // Решение координатора (после слияния S1): добавляется
  // `readonly tempPath: ResourcePath` — путь временного файла для checkpoint
  // и reconciliation. Правку provider.ts делает S3 (исключение владения).
}
export interface FileProvider {
  readonly endpoint: Endpoint;
  readonly capabilities: ReadonlySet<Capability>;
  list(path: ResourcePath, opts: { cursor: string | null; limit: number }, signal: AbortSignal): Promise<ListPage>;
  stat(path: ResourcePath, signal: AbortSignal): Promise<Entry | null>;           // null = нет такого
  read(path: ResourcePath, offset: bigint, length: number, expect: Fingerprint | null, signal: AbortSignal): Promise<Uint8Array>;
  openWrite(target: ResourcePath, signal: AbortSignal): Promise<WriteSession>;    // пишет во временное имя рядом с target
  mkdir(path: ResourcePath, signal: AbortSignal): Promise<void>;
  rename(from: ResourcePath, to: ResourcePath, opts: { replace: boolean }, signal: AbortSignal): Promise<void>;
  remove(path: ResourcePath, opts: { kind: EntryKind }, signal: AbortSignal): Promise<void>;   // каталог — только пустой
  // После ревью S3: rename(from, to, { replace, expectTarget? }) и
  // remove(path, { kind, expect? }) — сверка отпечатка непосредственно перед
  // действием; правит S3 (исключение владения), реализуют S4 и S5.
  copyWithin?(from: ResourcePath, to: ResourcePath, opts: { replace: boolean }, signal: AbortSignal): Promise<Fingerprint>;
  sha256?(path: ResourcePath, signal: AbortSignal): Promise<string>;
}
export const READ_CHUNK_MAX = 4 * 1024 * 1024;
export const LIST_PAGE_MAX = 1000;
```

Ошибки провайдер бросает только как `CommanderError`. `read` с `expect`
сверяет size+mtime перед чтением и бросает `changed_since_plan`.

## Проверки (тесты, ожидаемые значения — литералы)

- `size`: `toBig("5368709120") === 5368709120n`; `fromBig(2n**64n)` → строка
  `"18446744073709551616"`; `Size.safeParse("01").success === false`;
  `Size.safeParse("-1").success === false`; `addSize("9007199254740993","1") === "9007199254740994"`.
- `path`: `parsePosix("/home/Привет/😀.txt")` → три текстовых сегмента;
  `parsePosix("/a/../b")` → `invalid_path`; байтовый сегмент `{b:"/w=="}`
  (байт 0xFF) показывается `displayPath` как `/\xff`, не `�`;
  `isAncestorOrSelf(/A, /a/b, false) === true`, `(…, true) === false`;
  `parent(root) === null`.
- `model`: `OperationPlan.parse` отвергает лишние поля, 100 001 элемент,
  `items: []`; `EndpointId` принимает `host:host_qu7wvy3gxm`,
  `sftp:` + uuid, отвергает `sftp:../x`.
- `planDigest` стабилен при перестановке ключей входного объекта (литерал
  хэша для фиксированного плана в тесте).
- `errors`: `toShape()` проходит `CommanderErrorShape`.
- Архитектурный тест зелёный (нет `node:`-импортов).

## Ожидаемый diff

5 модулей + 5 тестов в `src/core`, ~600–900 строк. Без изменений вне своих путей.
