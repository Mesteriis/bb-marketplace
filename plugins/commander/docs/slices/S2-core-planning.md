# S2. Планирование операций, защитные проверки, имена, права

## Цель

Из выделения (набор `ResourceRef`) и параметров построить проверенный
`OperationPlan`: зафиксировать отпечатки, маршрут, политику конфликтов,
отказать в опасных операциях. Проверка прав одинакова для owner и agent.

## Принятые пути

`src/core/planner.ts`, `src/core/guards.ts`, `src/core/naming.ts`,
`src/core/permissions.ts` и их `*.test.ts`; корневой
`THIRD_PARTY_NOTICES.md` (запись, если переносится код MIT-доноров; если
переносятся только идеи тест-кейсов — не трогать). Там уже есть записи S0
(вендоренные компоненты) и треда Commander (иконки Lucide в артбордах):
свои записи добавлять отдельными разделами рядом, существующие не
переписывать.

## Контракт

```ts
// planner.ts
export interface PlanRequest {
  kind: OperationKind;
  initiator: Initiator;
  sources: ResourceRef[];            // для copy/move/delete/rename; для mkdir — []
  targetDir: ResourceRef | null;     // copy/move/mkdir
  newName: NameSegment | null;       // rename, mkdir
  conflictPolicy: ConflictPolicy;
  verify: Verify;                    // default "size" для local, "sha256" для relay
}
export interface PlannerDeps {
  provider(endpoint: EndpointId): FileProvider;   // из S1-порта
  now(): Date;
  uuid(): string;
  limits: { maxItems: number; maxDepth: number };  // по умолчанию 100_000 и 64
}
// Раскрывает каталоги рекурсивно (list по страницам), снимает stat-отпечатки,
// вычисляет route ("same-endpoint" если sourceEndpoint === targetEndpoint),
// totalBytes и digest. Симлинки не разыменовываются: элемент kind "symlink".
export function buildPlan(req: PlanRequest, deps: PlannerDeps, signal: AbortSignal): Promise<OperationPlan>;
// Повторно снимает stat всех source и сравнивает с plan.items[*].fingerprint.
export function revalidate(plan: OperationPlan, deps: PlannerDeps, signal: AbortSignal): Promise<{ ok: true } | { ok: false; changed: number[] }>;

// guards.ts — вызываются buildPlan, бросают CommanderError
export function assertNotIntoSelf(sources: ResourceRef[], targetDir: ResourceRef, caseSensitive: boolean): void;   // copy/move каталога в себя или потомка → invalid_path
export function assertNotReplacingSource(sources: ResourceRef[], targetDir: ResourceRef, caseSensitive: boolean): void; // цель == источник
export function assertDeletable(ref: ResourceRef, protectedPaths: ResourcePath[]): void;  // корень, home хоста, его родитель → permission_denied
export function assertWritable(endpoint: Endpoint): void;   // readOnly → read_only

// naming.ts
export function nextFreeName(name: NameSegment, taken: (n: NameSegment) => boolean, limit?: number): NameSegment;
// "a.txt" → "a (2).txt" → "a (3).txt"; "archive.tar.gz" → "archive (2).tar.gz"; ".bashrc" → ".bashrc (2)";
// без расширения "dir" → "dir (2)"; байтовые сегменты — суффикс в байтах; >limit (100_000) → limit_exceeded

// permissions.ts
export const REQUIRED: Record<OperationKind, Permission[]>;
// copy: ["read","write"], move: ["read","write","delete"], rename: ["write"], mkdir: ["write"], delete: ["delete"]
export interface Grant { endpoint: EndpointId | "*"; permissions: Permission[]; scope: ResourcePath | null }
export function authorize(initiator: Initiator, plan: OperationPlan, grants: Grant[]): { ok: true } | { ok: false; missing: Permission[] };
// owner: все права (grants игнорируются); agent: каждый item по source и target
// должен попадать в scope гранта своего endpoint (isAncestorOrSelf), иначе отказ.
```

## Проверки

- `buildPlan` на fake-провайдере (простая in-memory реализация `FileProvider`
  прямо в тесте; общий fake из S3 не использовать, чтобы не зависеть от него):
  каталог из 3 файлов (1, 2, 3 байта) и подкаталога → `items.length === 5`,
  `totalBytes === "6"`, `route === "relay-server"` для разных endpoint.
- Глубина 65 → `limit_exceeded`; 100 001 элемент → `limit_exceeded`.
- `revalidate` после изменения size одного файла → `{ok:false, changed:[1]}`.
- Copy `/a` в `/a/b` → `invalid_path`; delete `/` и home → `permission_denied`;
  запись в readOnly endpoint → `read_only`.
- `nextFreeName`: литералы из контракта выше.
- `authorize`: owner без грантов — ok; agent со scope `/data` на
  `host:x` и item `/data/a` → ok; item `/etc/passwd` → `missing: ["read"]`;
  move без delete → `missing: ["delete"]`.
- Кейсы взяты по идее из Bobroot (`lib.rs:588,1546,1955,1972`, MIT) — если
  переносится код, запись в `THIRD_PARTY_NOTICES.md`.

## Ожидаемый diff

4 модуля + 4 теста, ~700–1000 строк.
