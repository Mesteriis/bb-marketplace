import { CommanderError } from "./errors.ts";
import type { JobState } from "./model.ts";

export type JobEvent =
  | "start" | "conflict" | "decide" | "item_done" | "all_done" | "fail"
  | "cancel" | "cancel_done" | "process_lost" | "reconciled_done" | "reconciled_unknown" | "resume";

const transitions: Record<JobState, Partial<Record<JobEvent, JobState>>> = {
  pending: { start: "running", cancel: "cancel_requested" },
  running: {
    conflict: "awaiting_decision", item_done: "running", all_done: "completed",
    fail: "failed", cancel: "cancel_requested", process_lost: "interrupted",
  },
  awaiting_decision: { decide: "running", cancel: "cancel_requested", process_lost: "interrupted" },
  cancel_requested: { cancel_done: "cancelled", process_lost: "interrupted" },
  interrupted: { reconciled_done: "completed", reconciled_unknown: "unknown", resume: "running" },
  cancelled: {},
  completed: {},
  failed: {},
  unknown: {},
};

export function transition(state: JobState, event: JobEvent): JobState {
  const next = transitions[state][event];
  if (!next) throw new CommanderError("internal", "Invalid job state transition");
  return next;
}
