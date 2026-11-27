import { z } from "zod";

export const ciState = z.enum(["queued", "running", "success", "failure", "cancelled", "skipped", "neutral"]);
export type CiState = z.infer<typeof ciState>;
const terminal = new Set<CiState>(["success", "failure", "cancelled", "skipped", "neutral"]);
export const isTerminal = (state: CiState) => terminal.has(state);

export const run = z.object({
  id: z.string(), number: z.number().int().nullable(), workflow: z.string(), workflowId: z.string().nullable(),
  title: z.string(), branch: z.string().nullable(), sha: z.string().nullable(), event: z.string().nullable(),
  state: ciState, attempt: z.number().int().min(1), createdAt: z.string(), updatedAt: z.string().nullable(),
  url: z.string().nullable(), actor: z.string().nullable(),
});
export type Run = z.infer<typeof run>;
export const step = z.object({number: z.number().int(), name: z.string(), state: ciState});
export const job = z.object({
  id: z.string(), name: z.string(), state: ciState, startedAt: z.string().nullable(), completedAt: z.string().nullable(),
  url: z.string().nullable(), steps: z.array(step),
});
export type Job = z.infer<typeof job>;
export const runFilter = z.enum(["active", "failed", "all"]);
export type RunFilter = z.infer<typeof runFilter>;

const settleAfter = 60_000;

/** A run some forges keep reporting as running after all of its jobs finished: settle it from the jobs. */
export function settle(value: Run, jobs: Job[], now: number): Run {
  if (isTerminal(value.state) || !jobs.length || !jobs.every(item => isTerminal(item.state))) return value;
  const finished = Math.max(...jobs.map(item => Date.parse(item.completedAt ?? "") || Infinity));
  if (!Number.isFinite(finished) || now - finished < settleAfter) return value;
  const state: CiState = jobs.some(item => item.state === "failure") ? "failure"
    : jobs.some(item => item.state === "cancelled") ? "cancelled" : "success";
  return {...value, state};
}

/** Whole minutes a queued run has waited since it was queued or re-queued; null when it is not queued. */
export function queuedMinutes(value: Run, now: number): number | null {
  if (value.state !== "queued") return null;
  const since = Date.parse(value.updatedAt ?? value.createdAt);
  return Number.isFinite(since) ? Math.max(0, Math.floor((now - since) / 60_000)) : null;
}
