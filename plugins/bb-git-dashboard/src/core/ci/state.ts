import type { CiState } from "./model.ts";

/** GitHub run and job `status` with `conclusion`. */
export function githubState(status: string, conclusion: string | null): CiState {
  if (status !== "completed") return status === "in_progress" ? "running" : "queued";
  if (conclusion === "success") return "success";
  if (conclusion === "failure" || conclusion === "timed_out" || conclusion === "startup_failure") return "failure";
  if (conclusion === "cancelled") return "cancelled";
  if (conclusion === "skipped") return "skipped";
  return "neutral";
}

/** Gitea Actions run and job status. */
export function giteaState(status: string): CiState {
  if (status === "waiting" || status === "blocked") return "queued";
  if (status === "running") return "running";
  if (status === "success" || status === "failure" || status === "cancelled" || status === "skipped") return status;
  return "neutral";
}

/** Azure Pipelines build `status` with `result`, also used for timeline records (`state`/`result`). */
export function azureState(status: string, result: string | null): CiState {
  if (status === "notStarted" || status === "postponed" || status === "pending") return "queued";
  if (status !== "completed") return "running";
  if (result === "succeeded") return "success";
  if (result === "partiallySucceeded" || result === "failed") return "failure";
  if (result === "canceled") return "cancelled";
  if (result === "skipped") return "skipped";
  return "neutral";
}
