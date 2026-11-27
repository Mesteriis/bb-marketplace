import { z } from "zod";
import { failure, id } from "../workspace.ts";
import { ciAction } from "./actions.ts";
import { dispatchSpecSchema } from "./dispatch.ts";
import { job, run, runFilter } from "./model.ts";

const operations = z.object({dispatch: z.boolean(), dispatchInputs: z.boolean(), rerunFailed: z.boolean(), rerunAll: z.boolean(), cancel: z.boolean(), liveLog: z.boolean()});
const runId = z.string().min(1).max(200);
/** The plugin's answer envelope: a failure with a code, or the value with `ok: true`. */
const answer = <T extends z.ZodRawShape>(shape: T) => z.discriminatedUnion("ok", [failure, z.object({ok: z.literal(true), ...shape})]);
export const ciContract = {
  ciRuns: {input: z.object({copyId: id, filter: runFilter, page: z.number().int().min(1).max(50)}),
    output: answer({items: z.array(run), more: z.boolean(), forge: z.enum(["github", "gitlab", "gitea", "azure"]),
      operations, limitations: z.record(z.string(), z.string())})},
  ciRun: {input: z.object({copyId: id, runId}), output: answer({run, jobs: z.array(job)})},
  ciLog: {input: z.object({copyId: id, runId, jobId: runId}),
    output: answer({log: z.object({text: z.string(), truncated: z.boolean()}).nullable(), errorLine: z.number().int().nullable()})},
  ciWorkflows: {input: z.object({copyId: id}),
    output: answer({workflows: z.array(z.object({id: z.string(), name: z.string(), path: z.string().nullable()})), defaultBranch: z.string().nullable()})},
  ciForm: {input: z.object({copyId: id, workflowId: runId, ref: z.string().min(1).max(250)}), output: answer(dispatchSpecSchema.shape)},
  ciPrepare: {input: z.object({copyId: id, action: ciAction}), output: answer({id, lines: z.array(z.string()), expires: z.string()})},
  ciConfirm: {input: z.object({previewId: id}), output: answer({done: z.literal(true)})},
  ciThreads: {input: z.object({copyId: id}), output: answer({threads: z.array(z.object({id, title: z.string()})), subscribed: z.array(id)})},
  ciAsk: {input: z.object({copyId: id, runId, jobId: runId.nullable()}), output: answer({threadId: id, created: z.boolean()})},
  ciSend: {input: z.object({copyId: id, runId, jobId: runId.nullable(), threadIds: z.array(id).min(1).max(20)}),
    output: answer({sent: z.array(id), failed: z.array(z.object({threadId: id, code: z.string()}))})},
  ciSubscribe: {input: z.object({copyId: id, threadIds: z.array(id).max(20)}), output: answer({subscribed: z.array(id)})},
};
