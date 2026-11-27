import { z } from "zod";
import { answer } from "../answer.ts";
import { id } from "../workspace.ts";
import { placementSchema } from "./placement.ts";
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
  reviewView: {input: z.object({copyId: id, target: targetRequestSchema, ignoreWhitespace: z.boolean()}),
    output: answer({sessionId: reviewId, target: targetSchema, files: z.array(reviewDiffFileSchema), truncated: z.boolean(),
      baseSha: z.string().nullable(), headSha: z.string().nullable(), threads: z.array(reviewThreadSchema), placements: z.record(z.string(), placementSchema)})},
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
};
