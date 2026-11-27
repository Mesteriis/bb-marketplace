import { z } from "zod";
import { answer } from "../answer.ts";
import { id } from "../workspace.ts";
import { placementSchema } from "./placement.ts";
import { reviewDiffFileSchema } from "./diff.ts";
import { BODY_MAX_CHARS, reviewThreadSchema, severitySchema, sideSchema, targetRequestSchema, targetSchema, threadStatusSchema } from "./model.ts";

const reviewId = z.string().regex(/^[0-9a-f]{12}$/);
const body = z.string().min(1).max(BODY_MAX_CHARS);
/** The line review of a working copy; only the app calls it. */
export const codeReviewContract = {
  reviewView: {input: z.object({copyId: id, target: targetRequestSchema, ignoreWhitespace: z.boolean()}),
    output: answer({sessionId: reviewId, target: targetSchema, files: z.array(reviewDiffFileSchema), truncated: z.boolean(),
      baseSha: z.string().nullable(), headSha: z.string().nullable(), threads: z.array(reviewThreadSchema), placements: z.record(z.string(), placementSchema)})},
  reviewCreateThread: {input: z.object({sessionId: reviewId, filePath: z.string().min(1).max(4096), side: sideSchema.nullable(),
    startLine: z.number().int().min(0), endLine: z.number().int().min(0), severity: severitySchema.nullable(), body}),
    output: answer({thread: reviewThreadSchema})},
  reviewAddComment: {input: z.object({threadId: reviewId, body}), output: answer({})},
  reviewEditComment: {input: z.object({commentId: reviewId, body}), output: answer({})},
  reviewDeleteComment: {input: z.object({commentId: reviewId}), output: answer({})},
  reviewSetStatus: {input: z.object({threadId: reviewId, status: threadStatusSchema}), output: answer({})},
  reviewSend: {input: z.object({sessionId: reviewId, threadId: id, threadIds: z.array(reviewId).min(1).max(200), note: z.string().max(BODY_MAX_CHARS)}),
    output: answer({count: z.number().int()})},
  reviewApply: {input: z.object({threadId: reviewId, commentId: reviewId}), output: answer({})},
  /** Threads of the copy's project working on this copy, to send comments to. */
  reviewTargets: {input: z.object({copyId: id}), output: answer({threads: z.array(z.object({id, title: z.string()}))})},
};
