/**
 * The line review of a working copy: a session per copy and view, threads anchored to a file, a side and a line
 * range, and comments in each thread. Ported from diff-review's `shared/types.ts` (MIT, gpambrozio), whose model
 * follows diffity's (MIT, Kamran Ahmed): `GENERAL_PATH` marks a thread on the whole diff and `startLine` 0 one on a
 * whole file. Changed: a session belongs to a Makosh Git copy rather than a BB environment; the `files` and `pr`
 * views come later.
 */
import { z } from "zod";
import { rangeText, revisionSchema } from "./git-spec.ts";

/** The file path of a thread about the whole diff rather than one file. */
export const GENERAL_PATH = "__general__";
/** The longest comment body stored, in characters. */
export const BODY_MAX_CHARS = 20_000;
/** The longest anchor snippet stored with a thread, in characters. */
export const ANCHOR_MAX_CHARS = 20_000;

export const sideSchema = z.enum(["old", "new"]);
/** Which version of a file a line number counts in: `old` is the removed side, `new` the added one. */
export type Side = z.infer<typeof sideSchema>;
export const threadStatusSchema = z.enum(["open", "resolved", "dismissed"]);
export type ThreadStatus = z.infer<typeof threadStatusSchema>;
/** diffity's severities. A thread may have none. */
export const severitySchema = z.enum(["must-fix", "suggestion", "nit", "question"]);
export type Severity = z.infer<typeof severitySchema>;
export const authorTypeSchema = z.enum(["user", "agent"]);
/**
 * Where a thread stands with the agent it was last sent to: `sent` until the agent replies, resolves or dismisses
 * it (`answered`), or until that agent's turn ends without a word on it (`no_reply`).
 */
export const deliveryStateSchema = z.enum(["sent", "answered", "no_reply"]);
export type DeliveryState = z.infer<typeof deliveryStateSchema>;

const base = z.string().min(1).max(256);
const sha = z.string().regex(/^[0-9a-f]{7,64}$/i);
/** The view under review as asked for; the branch views may leave `base` out for the copy's default branch. */
export const targetRequestSchema = z.discriminatedUnion("kind", [
  z.object({kind: z.literal("uncommitted")}).strict(),
  z.object({kind: z.literal("staged")}).strict(),
  z.object({kind: z.literal("unstaged")}).strict(),
  z.object({kind: z.literal("branch"), base: base.optional()}).strict(),
  z.object({kind: z.literal("all"), base: base.optional()}).strict(),
  z.object({kind: z.literal("commit"), sha}).strict(),
  z.object({kind: z.literal("range"), from: revisionSchema, to: revisionSchema, symmetric: z.boolean()}).strict(),
  /** Any file of the working copy, changed or not, commented as it reads now. */
  z.object({kind: z.literal("files")}).strict(),
]);
export type TargetRequest = z.infer<typeof targetRequestSchema>;
/** A view with every part filled in; with the copy, the key of a review session. */
export const targetSchema = z.discriminatedUnion("kind", [
  z.object({kind: z.literal("uncommitted")}).strict(),
  z.object({kind: z.literal("staged")}).strict(),
  z.object({kind: z.literal("unstaged")}).strict(),
  z.object({kind: z.literal("branch"), base}).strict(),
  z.object({kind: z.literal("all"), base}).strict(),
  z.object({kind: z.literal("commit"), sha}).strict(),
  z.object({kind: z.literal("range"), from: revisionSchema, to: revisionSchema, symmetric: z.boolean()}).strict(),
  z.object({kind: z.literal("files")}).strict(),
]);
export type Target = z.infer<typeof targetSchema>;

export const commentSchema = z.object({
  id: z.string(), authorType: authorTypeSchema,
  /** Who wrote it: "You" for the owner, the provider's name for an agent. */
  authorName: z.string(), body: z.string(), createdAt: z.number(), editedAt: z.number().nullable(),
}).strict();
export type ReviewComment = z.infer<typeof commentSchema>;
export const deliverySchema = z.object({
  state: deliveryStateSchema, sendId: z.string(),
  /** The BB thread the comments went to. */
  threadId: z.string(), sentAt: z.number(),
}).strict();
export type Delivery = z.infer<typeof deliverySchema>;
export const reviewThreadSchema = z.object({
  id: z.string(), sessionId: z.string(),
  /** A path in the diff, or `GENERAL_PATH`. */
  filePath: z.string(),
  /** Null for a whole-diff or whole-file thread. */
  side: sideSchema.nullable(),
  /** 0 for a whole-diff or whole-file thread. */
  startLine: z.number().int().min(0), endLine: z.number().int().min(0),
  status: threadStatusSchema, severity: severitySchema.nullable(),
  /** The commented lines' text when the thread was made, to find them again after edits. */
  anchorContent: z.string().nullable(),
  createdAt: z.number(), updatedAt: z.number(),
  comments: z.array(commentSchema), delivery: deliverySchema.nullable(),
}).strict();
export type ReviewThread = z.infer<typeof reviewThreadSchema>;

/**
 * An AI run started from the review, in a BB thread of its own under the reviewed one: a `review` that leaves
 * comments and answers @reviewer, a `fix` that got comments sent to a new thread, a `summary` of the change, an
 * `explain`ed file or lines.
 */
export const runKindSchema = z.enum(["review", "fix", "summary", "explain"]);
export type RunKind = z.infer<typeof runKindSchema>;
export const runStatusSchema = z.enum(["running", "done", "failed", "closed"]);
export type RunStatus = z.infer<typeof runStatusSchema>;
export const reviewRunSchema = z.object({
  id: z.string(), sessionId: z.string(), kind: runKindSchema,
  /** The run's BB thread; null until BB gives it one, or when it could not start. */
  threadId: z.string().nullable(),
  /** A review run's focus, or what an explain run explains. */
  focus: z.string().nullable(),
  providerId: z.string(), model: z.string().nullable(), status: runStatusSchema,
  /** The agent's last message when its turn ended, or why the run could not start. */
  summary: z.string().nullable(),
  /** Files that changed in the copy while a read-only run ran; null before it ends. */
  changedFiles: z.array(z.string()).nullable(),
  createdAt: z.number(), finishedAt: z.number().nullable(),
}).strict();
export type ReviewRun = z.infer<typeof reviewRunSchema>;
/** The provider, model and reasoning a run's thread starts with, as BB's provider picker gives them. */
export const executionSchema = z.object({
  providerId: z.string().min(1).max(128), model: z.string().max(256),
  reasoningLevel: z.enum(["none", "low", "medium", "high", "xhigh", "max", "ultra", "ultracode"]),
  serviceTier: z.string().max(128).optional(),
}).strict();
export type Execution = z.infer<typeof executionSchema>;

/** The key a session is stored under for a view. */
export function targetKey(target: Target): string {
  switch (target.kind) {
    case "uncommitted": case "staged": case "unstaged": case "files": return target.kind;
    case "branch": return "branch:" + target.base;
    case "all": return "all:" + target.base;
    case "commit": return "commit:" + target.sha.toLowerCase();
    case "range": return "range:" + rangeText(target);
  }
}

/** How a view reads in a sentence: "uncommitted changes", "commit abc1234", … */
export function describeTarget(target: Target): string {
  switch (target.kind) {
    case "uncommitted": return "uncommitted changes";
    case "staged": return "staged changes (HEAD against the index)";
    case "unstaged": return "unstaged changes (the index against the working tree)";
    case "branch": return "committed changes since " + target.base;
    case "all": return "all changes since " + target.base + ", committed and not";
    case "commit": return "commit " + target.sha.slice(0, 7);
    case "range": return "the range " + rangeText(target);
    case "files": return "files of the working copy as they are";
  }
}

/** Where a thread points, for people and agents: "src/a.ts:12-14 (new side)", "src/a.ts (whole file)", … */
export function describeLocation(thread: Pick<ReviewThread, "filePath" | "side" | "startLine" | "endLine">): string {
  if (thread.filePath === GENERAL_PATH) return "the whole diff";
  if (thread.startLine === 0) return thread.filePath + " (whole file)";
  const lines = thread.startLine === thread.endLine ? String(thread.startLine) : thread.startLine + "-" + thread.endLine;
  return thread.filePath + ":" + lines + " (" + (thread.side === "old" ? "old side, removed lines" : "new side") + ")";
}

/** A session's view from its key, when no view was read since the server started. */
export function targetFromKey(key: string): Target {
  if (key === "uncommitted" || key === "staged" || key === "unstaged" || key === "files") return {kind: key};
  const [kind, rest] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
  if (kind === "branch" || kind === "all") return {kind, base: rest};
  if (kind === "commit") return {kind, sha: rest};
  const symmetric = rest.includes("...");
  const [from, to] = rest.split(symmetric ? "..." : "..");
  return {kind: "range", from, to, symmetric};
}
