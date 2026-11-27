import { expect, test } from "vitest";
import { transition, type JobEvent } from "./job-machine.ts";
import type { JobState } from "./model.ts";

test.each<[JobState, JobEvent, JobState]>([
  ["pending", "start", "running"],
  ["running", "conflict", "awaiting_decision"],
  ["awaiting_decision", "decide", "running"],
  ["running", "item_done", "running"],
  ["running", "all_done", "completed"],
  ["running", "fail", "failed"],
  ["pending", "cancel", "cancel_requested"],
  ["running", "cancel", "cancel_requested"],
  ["awaiting_decision", "cancel", "cancel_requested"],
  ["cancel_requested", "cancel_done", "cancelled"],
  ["running", "process_lost", "interrupted"],
  ["cancel_requested", "process_lost", "interrupted"],
  ["awaiting_decision", "process_lost", "interrupted"],
  ["interrupted", "reconciled_done", "completed"],
  ["interrupted", "reconciled_unknown", "unknown"],
  ["interrupted", "resume", "running"],
  ["interrupted", "restore_conflict", "awaiting_decision"],
  ["interrupted", "cancel_done", "cancelled"],
  ["running", "outcome_unknown", "unknown"],
  ["cancel_requested", "outcome_unknown", "unknown"],
])("%s + %s → %s", (state, event, expected) => {
  expect(transition(state, event)).toBe(expected);
});

test.each<[JobState, JobEvent]>([
  ["pending", "all_done"],
  ["running", "decide"],
  ["completed", "start"],
])("rejects %s + %s", (state, event) => {
  expect(() => transition(state, event)).toThrow(expect.objectContaining({ code: "internal" }));
});
