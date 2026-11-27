import { z } from "zod";
import { answer } from "../answer.ts";
import { id } from "../workspace.ts";
import { placementSchema } from "./placement.ts";
import { viewStateSchema } from "./view-state.ts";
import { reviewDiffFileSchema } from "./diff.ts";
import { ANCHOR_MAX_CHARS, BODY_MAX_CHARS, executionSchema, reviewRunSchema, reviewThreadSchema, severitySchema, sideSchema, targetRequestSchema, targetSchema, threadStatusSchema } from "./model.ts";

const reviewId = z.string().regex(/^[0-9a-f]{12}$/);
const body = z.string().min(1).max(BODY_MAX_CHARS);
/** The thread whose Review tab asked; null from the copy's own Review section. */
const viewer = z.object({viewerThreadId: id.nullable().optional()});
const runAnswer = answer({run: reviewRunSchema});
/** Why a comment's @reviewer could not start a reviewer; null when it was asked or nobody was mentioned. */
const reviewer = z.object({code: z.string(), next: z.string()}).nullable();
/** The line review of a working copy; only the app calls it. */
export const codeReviewContract = {
  /** `auto`: a first look, no view picked yet; an empty uncommitted view gives way to the branch's commits. */
  reviewView: {input: z.object({copyId: id, target: targetRequestSchema, ignoreWhitespace: z.boolean(), auto: z.boolean().optional()}),
    output: answer({sessionId: reviewId, target: targetSchema, files: z.array(reviewDiffFileSchema), truncated: z.boolean(),
      ignored: z.number().int().nonnegative().optional(), baseSha: z.string().nullable(), headSha: z.string().nullable(),
      threads: z.array(reviewThreadSchema), placements: z.record(z.string(), placementSchema),
      /** Where the copy is, to open its files in BB's preview. */
      copy: z.object({hostId: id, root: z.string().max(4096)}), colorBlind: z.boolean().optional()})},
  /** The Reviews page: every review with threads; an orphan's copy is gone. */
  reviewSummaries: {input: z.object({}), output: answer({reviews: z.array(z.object({sessionId: reviewId, copyId: id, copyName: z.string().nullable(),
    orphan: z.boolean(), targetKey: z.string(), view: z.string(), open: z.number().int(), total: z.number().int(), updatedAt: z.number()}))})},
  reviewDeleteOrphans: {input: z.object({sessionIds: z.array(reviewId).min(1).max(200)}), output: answer({deleted: z.number().int(), deletedThreads: z.number().int()})},
  /** A thread's Info row: its copy's open and total comment threads; null when it works on no copy. */
  reviewThreadCounts: {input: z.object({threadId: id}), output: answer({counts: z.object({copyId: id, open: z.number().int(), total: z.number().int()}).nullable()})},
  reviewCommits: {input: z.object({copyId: id}), output: answer({commits: z.array(z.object({sha: z.string(), subject: z.string()}))})},
  reviewSearchFiles: {input: z.object({copyId: id, query: z.string().max(200)}), output: answer({paths: z.array(z.string()), more: z.boolean()})},
  reviewFileEntry: {input: z.object({copyId: id, path: z.string().min(1).max(4096)}), output: answer({file: reviewDiffFileSchema})},
  reviewRevert: {input: z.object({sessionId: reviewId, path: z.string().min(1).max(4096), revision: z.string().regex(/^[0-9a-f]{16}$/),
    hunks: z.array(z.number().int().min(0).max(10_000)).max(10_000).nullable()}), output: answer({})},
  reviewViewState: {input: z.object({scope: z.string().max(140), sessionId: reviewId}), output: answer({state: viewStateSchema})},
  reviewSaveViewState: {input: z.object({scope: z.string().max(140), sessionId: reviewId, state: viewStateSchema}), output: answer({kept: z.boolean()})},
  reviewSetViewed: {input: z.object({sessionId: reviewId, path: z.string().min(1).max(4096), revision: z.string().max(64), viewed: z.boolean()}), output: answer({})},
  reviewCreateThread: {input: z.object({sessionId: reviewId, filePath: z.string().min(1).max(4096), side: sideSchema.nullable(),
    startLine: z.number().int().min(0), endLine: z.number().int().min(0), anchorContent: z.string().max(ANCHOR_MAX_CHARS).nullable(),
    severity: severitySchema.nullable(), body}).merge(viewer),
    output: answer({thread: reviewThreadSchema, reviewer})},
  reviewAddComment: {input: z.object({threadId: reviewId, body}).merge(viewer), output: answer({reviewer})},
  reviewEditComment: {input: z.object({commentId: reviewId, body}), output: answer({})},
  reviewDeleteComment: {input: z.object({commentId: reviewId}), output: answer({})},
  reviewSetStatus: {input: z.object({threadId: reviewId, status: threadStatusSchema}), output: answer({})},
  reviewSend: {input: z.object({sessionId: reviewId, threadId: id, threadIds: z.array(reviewId).min(1).max(200), note: z.string().max(BODY_MAX_CHARS)}),
    output: answer({count: z.number().int()})},
  reviewApply: {input: z.object({threadId: reviewId, commentId: reviewId}), output: answer({})},
  /** Threads of the copy's project working on this copy, to send comments to. */
  reviewTargets: {input: z.object({copyId: id}), output: answer({threads: z.array(z.object({id, title: z.string()}))})},
  /** Where the run pickers start, and where BB should read the provider catalog. */
  reviewRunDefaults: {input: z.object({copyId: id}).merge(viewer), output: answer({execution: executionSchema.nullable(), message: z.string().nullable(),
    permissionMode: z.enum(["auto", "accept-edits"]),
    place: z.discriminatedUnion("kind", [z.object({kind: z.literal("environment"), environmentId: id}), z.object({kind: z.literal("host"), hostId: id})]).nullable()})},
  reviewRuns: {input: z.object({sessionId: reviewId}), output: answer({runs: z.array(reviewRunSchema)})},
  reviewStartReview: {input: z.object({sessionId: reviewId, focuses: z.array(z.string().min(1).max(64)).max(8), instructions: z.string().max(4000),
    execution: executionSchema}).merge(viewer), output: runAnswer},
  reviewStartSummary: {input: z.object({sessionId: reviewId, execution: executionSchema}).merge(viewer), output: runAnswer},
  reviewStartExplain: {input: z.object({sessionId: reviewId, filePath: z.string().min(1).max(4096), side: sideSchema.nullable(),
    startLine: z.number().int().min(0), endLine: z.number().int().min(0), code: z.string().max(ANCHOR_MAX_CHARS).nullable()}).merge(viewer), output: runAnswer},
  reviewFix: {input: z.object({sessionId: reviewId, threadIds: z.array(reviewId).min(1).max(200), note: z.string().max(BODY_MAX_CHARS),
    execution: executionSchema}).merge(viewer), output: answer({run: reviewRunSchema, count: z.number().int()})},
  reviewCloseRun: {input: z.object({runId: reviewId}), output: answer({})},
  /** The patches of up to 25 files a view left deferred. */
  reviewPatches: {input: z.object({copyId: id, target: targetSchema, ignoreWhitespace: z.boolean(), files: z.array(reviewDiffFileSchema).min(1).max(25)}),
    output: answer({files: z.array(reviewDiffFileSchema)})},
  /** Keeps the copy watched for 90 seconds: changes to its files reload its Review. */
  reviewWatch: {input: z.object({copyId: id}), output: answer({})},
  /** Deletes every comment thread of the view and closes its AI runs. */
  reviewClear: {input: z.object({sessionId: reviewId}), output: answer({deletedThreads: z.number().int(), closedRuns: z.number().int()})},
};
