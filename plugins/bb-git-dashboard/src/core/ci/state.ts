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

/**
 * GitLab pipeline and job status. A cancellation in progress still runs; `manual` waits for someone to start a job
 * (a deploy gate), so the pipeline has stopped rather than queued.
 */
export function gitlabState(status: string): CiState {
  if (["created", "waiting_for_resource", "preparing", "pending", "scheduled"].includes(status)) return "queued";
  if (status === "running" || status === "canceling") return "running";
  if (status === "success" || status === "skipped") return status;
  if (status === "failed") return "failure";
  if (status === "canceled") return "cancelled";
  return "neutral";
}

/** A GitLab job: `created` means its stage has not been reached yet, unlike a created pipeline, which is queued. */
export function gitlabJobState(status: string): CiState {
  return status === "created" ? "waiting" : gitlabState(status);
}
