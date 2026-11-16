// Made-up AI answers and fake ports for the page's tests (slice 3f).
import type { AiPollOutput, AiStartInput } from "../../core/contract.ts";
import type { AiResultView } from "../../core/model.ts";
import type { AiJobPorts } from "../ai-job.ts";

/** Model output that tries to be markup: it must stay text. */
export const HOSTILE = '<a href="https://evil.example.com">click</a> <b>bold</b> **stars** [link](https://evil.example.com)';

export const BASE = {
  provider: "provider-x",
  model: "model-y",
  cached: false,
  stale: false,
  notes: { hidden: 0, leftOut: 0, truncated: 0, unreadItems: 0 },
  citations: [
    { n: 1, messageId: "m-1", accountId: "acc-1", threadId: "th-1" },
    { n: 2, messageId: "m-2", accountId: "acc-1", threadId: "th-1" },
  ],
  createdAt: "2026-11-16T08:00:00.000Z",
};

export interface FakeAnswer {
  result?: AiResultView;
  /** Answer ai_start with this cached result instead of a job. */
  cached?: AiResultView;
  error?: AiPollOutput["error"];
  startError?: string;
  /** Polls that answer "running" first. */
  running?: number;
}

/** Ports whose start answers a job and whose poll answers `result` (or a failure); calls are recorded. */
export function fakePorts(answer: FakeAnswer) {
  const calls = { start: [] as AiStartInput[], poll: [] as string[], cancel: [] as string[] };
  const ports: AiJobPorts = {
    start: async (input) => {
      calls.start.push(input);
      if (answer.startError !== undefined) throw new Error(answer.startError);
      if (answer.cached !== undefined) return { cached: answer.cached };
      return { jobId: `job-${calls.start.length}` };
    },
    poll: async (jobId) => {
      calls.poll.push(jobId);
      if (calls.poll.length <= (answer.running ?? 0)) return { state: "running", phase: "reading" };
      if (answer.error !== undefined) return { state: "failed", error: answer.error, provider: "provider-x", model: "model-y" };
      return { state: "done", result: answer.result! };
    },
    cancel: async (jobId) => {
      calls.cancel.push(jobId);
      return { cancelled: true };
    },
  };
  return { ports, calls };
}
