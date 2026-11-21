// The wire contract between a Chertog window and the plugin's server: load
// the workspace document, and save it against the revision it was made from.
// Plain zod schemas; the BB adapter wraps them with the SDK's contract helper.
import { z } from "zod";
import { workspaceDocumentSchema } from "../workspace/index.ts";
import type { WorkspaceReadResult, WorkspaceSaveResult } from "../workspace/index.ts";

const droppedPartSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("layout"), id: z.string().nullable(), name: z.string().nullable(), reason: z.string() }),
  z.strictObject({ kind: z.literal("panel"), panelId: z.string().nullable(), reason: z.string() }),
]);

export const loadWorkspaceInputSchema = z.strictObject({});

/** What `WorkspaceStore.load` returns, as it travels. */
export const loadWorkspaceOutputSchema: z.ZodType<WorkspaceReadResult> = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("empty") }),
  z.strictObject({
    status: z.literal("ok"),
    document: workspaceDocumentSchema,
    migratedFrom: z.int().nullable(),
    dropped: z.array(droppedPartSchema),
  }),
  z.strictObject({ status: z.literal("newer"), schemaVersion: z.int() }),
  z.strictObject({ status: z.literal("corrupt"), reason: z.string() }),
]);

/**
 * The document is not checked here on purpose: the store checks it and
 * answers `rejected` with the reason, which a refused request could not carry.
 */
export const saveWorkspaceInputSchema = z.strictObject({
  document: z.unknown(),
  /** The revision of the document this one was made from, 0 for the first save. */
  expectedRevision: z.int().min(0),
});

/** What `WorkspaceStore.save` returns, as it travels. */
export const saveWorkspaceOutputSchema: z.ZodType<WorkspaceSaveResult> = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("saved"), document: workspaceDocumentSchema }),
  z.strictObject({ status: z.literal("conflict"), current: workspaceDocumentSchema.nullable() }),
  z.strictObject({ status: z.literal("rejected"), reason: z.string() }),
]);

/** The methods of the workspace RPC, by the name they are served under. */
export const workspaceRpcSchemas = {
  load_workspace: { input: loadWorkspaceInputSchema, output: loadWorkspaceOutputSchema },
  save_workspace: { input: saveWorkspaceInputSchema, output: saveWorkspaceOutputSchema },
} as const;
