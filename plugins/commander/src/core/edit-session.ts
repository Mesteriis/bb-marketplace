import { z } from "zod";
import { CommanderError } from "./errors.ts";
import { EntryKind, Fingerprint, ResourceRef, type ExpectedTarget } from "./model.ts";
import { matches } from "./reconcile.ts";

export const EditId = z.uuid();
export const EditRevision = z.int().nonnegative();
export const EditChoice = z.enum(["overwrite", "save-beside"]);
export type EditChoice = z.infer<typeof EditChoice>;
export const EDIT_SNAPSHOT_ENDPOINT = "host:commander-edit-snapshot";
export const EditConflict = z.strictObject({
  id: EditId,
  snapshotId: EditId,
  proof: Fingerprint.extend({ sha256: z.string().regex(/^[a-f0-9]{64}$/) }),
  revision: EditRevision,
  current: Fingerprint.nullable(),
  targetKind: EntryKind.nullable(),
});
export const EditState = z.strictObject({
  revision: EditRevision,
  conflict: EditConflict.nullable(),
  pendingJob: z.uuid().optional(),
  upload: z.strictObject({ baseRevision: EditRevision, lastChunkAt: z.iso.datetime() }).nullable(),
});
export type EditState = z.infer<typeof EditState>;

export const EditSession = z.strictObject({
  sessionId: EditId,
  ref: ResourceRef,
  base: Fingerprint,
  hostId: z.string().min(1),
  state: EditState,
  createdAt: z.iso.datetime(),
  lastSavedAt: z.iso.datetime().nullable(),
});
export type EditSession = z.infer<typeof EditSession>;

export const WriteBackRequest = z.strictObject({
  sessionId: EditId,
  clientRequestId: EditId,
  revision: EditRevision,
  choice: EditChoice.optional(),
  conflictId: EditId.optional(),
}).refine((input) => !!input.choice === !!input.conflictId, {
  message: "A conflict action requires a conflict id",
});
export type WriteBackRequest = z.infer<typeof WriteBackRequest>;

export const WriteBackResult = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("written"), jobId: z.uuid() }),
  z.strictObject({
    kind: z.literal("conflict"), conflictId: EditId, revision: EditRevision,
    reason: z.enum(["changed", "deleted"]), current: Fingerprint.nullable(),
  }),
]);
export type WriteBackResult = z.infer<typeof WriteBackResult>;

type EditCommand = Pick<WriteBackRequest, "choice" | "revision" | "conflictId">;
type Destination = { kind: EntryKind; fingerprint: Fingerprint } | null;
type WriteBackDecision =
  | { kind: "conflict" }
  | { kind: "original" | "beside"; expectTarget: ExpectedTarget };

export function writeBackCommand({ revision, choice, conflictId }: EditCommand): string {
  return JSON.stringify([revision, choice ?? null, conflictId ?? null]);
}

export function decideWriteBack(base: Fingerprint, state: EditState, request: EditCommand, target: Destination): WriteBackDecision {
  if (state.upload) throw new CommanderError("changed_since_plan", "Дождитесь сохранения");
  const conflict = { kind: "conflict" } as const;
  if (request.revision !== state.revision) return conflict;

  if (request.choice === undefined) {
    return target?.kind === "file" && matches(target.fingerprint, base)
      ? { kind: "original", expectTarget: base } : conflict;
  }

  const shown = state.conflict;
  const current = target?.fingerprint ?? null;
  if (!shown || shown.id !== request.conflictId || shown.revision !== request.revision
      || shown.targetKind !== (target?.kind ?? null)
      || !matches(current, shown.current) || !matches(shown.current, current)) {
    return conflict;
  }

  if (request.choice === "save-beside") return { kind: "beside", expectTarget: "absent" };
  if (target !== null && target.kind !== "file") return conflict;
  return { kind: "original", expectTarget: current ?? "absent" };
}

export const EDIT_UPLOAD_MS = 10 * 60 * 1000;
export const EDIT_IDLE_MS = 7 * 24 * 60 * 60 * 1000;

export function uploadExpired(state: EditState, now: number): boolean {
  return state.upload !== null && now - Date.parse(state.upload.lastChunkAt) >= EDIT_UPLOAD_MS;
}
