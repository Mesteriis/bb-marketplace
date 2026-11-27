import { z } from "zod";
import { CommanderErrorShape } from "./errors.ts";
import { NameSegment, ResourcePath } from "./path.ts";
import { Size } from "./size.ts";

export const ProviderKind = z.enum(["local", "sftp"]);
export type ProviderKind = z.infer<typeof ProviderKind>;
export const EndpointId = z.string().regex(/^(host:[A-Za-z0-9_-]{1,64}|sftp:[0-9a-f-]{36})$/);
export type EndpointId = z.infer<typeof EndpointId>;
export const Endpoint = z.object({
  id: EndpointId,
  provider: ProviderKind,
  label: z.string().max(200),
  machine: z.string().max(200),            // на какой машине лежат файлы (имя BB-хоста или host:port SFTP)
  hostId: z.string().nullable(),           // BB host для local, null для sftp
  readOnly: z.boolean(),
  caseSensitive: z.boolean(),
}).strict();
export type Endpoint = z.infer<typeof Endpoint>;

export const ResourceRef = z.object({ endpoint: EndpointId, path: ResourcePath }).strict();
export type ResourceRef = z.infer<typeof ResourceRef>;

export const EntryKind = z.enum(["file", "dir", "symlink", "other"]);
export type EntryKind = z.infer<typeof EntryKind>;
export const TimePrecision = z.enum(["ns", "us", "ms", "s", "unknown"]);
export type TimePrecision = z.infer<typeof TimePrecision>;
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
export type Entry = z.infer<typeof Entry>;

export const Capability = z.enum([
  "list", "stat", "read", "write", "mkdir", "rename", "remove",
  "atomicReplace", "serverSideCopy", "seek", "checksum", "watch", "trash", "permissions",
]);
export type Capability = z.infer<typeof Capability>;

export const Fingerprint = z.object({
  size: Size,
  mtimeNs: z.string().regex(/^-?\d{1,22}$/).nullable(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
}).strict();
export type Fingerprint = z.infer<typeof Fingerprint>;

export const Permission = z.enum(["observe", "read", "write", "delete", "exec", "admin"]);
export type Permission = z.infer<typeof Permission>;

export const Initiator = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("owner") }).strict(),
  z.object({ kind: z.literal("agent"), threadId: z.string().min(1).max(64) }).strict(),
]);
export type Initiator = z.infer<typeof Initiator>;

export const OperationKind = z.enum(["copy", "move", "rename", "mkdir", "delete"]);
export type OperationKind = z.infer<typeof OperationKind>;
export const ConflictPolicy = z.enum(["ask", "overwrite", "skip", "rename", "overwriteIfNewer"]);
export type ConflictPolicy = z.infer<typeof ConflictPolicy>;
export const Route = z.enum(["same-endpoint", "relay-server"]);
export type Route = z.infer<typeof Route>;
export const Verify = z.enum(["size", "sha256"]);
export type Verify = z.infer<typeof Verify>;

export const PlanItem = z.object({
  source: ResourceRef.nullable(),          // null для mkdir
  target: ResourceRef.nullable(),          // null для delete
  kind: EntryKind,
  fingerprint: Fingerprint.nullable(),     // источника на момент плана; null для mkdir
}).strict();
export type PlanItem = z.infer<typeof PlanItem>;

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
export type OperationPlan = z.infer<typeof OperationPlan>;

export const JobState = z.enum([
  "pending", "running", "awaiting_decision", "completed", "failed",
  "cancel_requested", "cancelled", "interrupted", "unknown",
]);
export type JobState = z.infer<typeof JobState>;

export const ConflictReason = z.enum(["exists", "source_changed", "target_changed", "type_mismatch"]);
export type ConflictReason = z.infer<typeof ConflictReason>;
export const Conflict = z.object({
  id: z.string().uuid(),
  jobId: z.string().uuid(),
  itemIndex: z.number().int().min(0),
  reason: ConflictReason,
  source: Fingerprint.nullable(),
  target: Fingerprint.nullable(),
}).strict();
export type Conflict = z.infer<typeof Conflict>;

export const ConflictAction = z.enum(["overwrite", "skip", "rename", "cancel"]);
export type ConflictAction = z.infer<typeof ConflictAction>;
export const ConflictDecision = z.object({
  conflictId: z.string().uuid(),
  action: ConflictAction,
  applyTo: z.enum(["this", "remaining_same_reason"]),
}).strict();
export type ConflictDecision = z.infer<typeof ConflictDecision>;

export const JobProgress = z.object({
  itemsDone: z.number().int().min(0),
  itemsTotal: z.number().int().min(0),
  bytesDone: Size,
  bytesTotal: Size,
}).strict();
export type JobProgress = z.infer<typeof JobProgress>;

export const ItemOutcome = z.enum(["pending", "done", "skipped", "failed", "unknown"]);
export type ItemOutcome = z.infer<typeof ItemOutcome>;

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
export type OperationJob = z.infer<typeof OperationJob>;

export async function planDigest(plan: Omit<OperationPlan, "digest">): Promise<string> {
  const unsigned: Partial<OperationPlan> = { ...plan };
  delete unsigned.digest;
  const canonical = JSON.stringify(unsigned, (_key, value: unknown) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, record[key]]));
  });

  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
