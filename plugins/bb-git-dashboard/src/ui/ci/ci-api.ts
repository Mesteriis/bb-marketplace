import type { CiAction } from "../../core/ci/actions.ts";
import type { DispatchSpec } from "../../core/ci/dispatch.ts";
import { queuedMinutes, type Job, type Run, type RunFilter } from "../../core/ci/model.ts";
import type { JobLog, Workflow } from "../../core/ci/pipelines.ts";
import type { CiOperation } from "../../core/ci/capabilities.ts";

export type RunsPage = {items: Run[]; more: boolean; forge: "github" | "gitlab" | "gitea" | "azure";
  operations: Record<CiOperation, boolean>; limitations: Record<string, string>};
export type ThreadRef = {id: string; title: string};

/** Everything the CI section asks of the host; the entry point implements it over RPC. */
export type CiApi = {
  runs(copyId: string, filter: RunFilter, page: number): Promise<RunsPage>;
  run(copyId: string, runId: string): Promise<{run: Run; jobs: Job[]}>;
  log(copyId: string, runId: string, jobId: string): Promise<{log: JobLog; errorLine: number | null; notes: string[]}>;
  workflows(copyId: string): Promise<{workflows: Workflow[]; defaultBranch: string | null}>;
  form(copyId: string, workflowId: string, ref: string): Promise<DispatchSpec>;
  prepare(copyId: string, action: CiAction): Promise<{id: string; lines: string[]; expires: string}>;
  confirm(previewId: string): Promise<void>;
  threads(copyId: string): Promise<{threads: ThreadRef[]; subscribed: string[]}>;
  ask(copyId: string, runId: string, jobId: string | null): Promise<{threadId: string; created: boolean}>;
  send(copyId: string, runId: string, jobId: string | null, threadIds: string[]): Promise<{sent: string[]; failed: {threadId: string; code: string}[]}>;
  subscribe(copyId: string, threadIds: string[]): Promise<{subscribed: string[]}>;
  openThread(threadId: string): void;
};

export const message = (error: unknown) => error instanceof Error ? error.message : "Request failed.";
export const stateLabel: Record<Run["state"], string> = {
  queued: "Queued", running: "Running", success: "Succeeded", failure: "Failed", cancelled: "Cancelled", skipped: "Skipped", neutral: "Neutral",
};

/** The state as shown: a queued run says how long the forge has kept it waiting. */
export function stateText(run: Run, now = Date.now()) {
  const minutes = queuedMinutes(run, now);
  return minutes !== null && minutes >= 1 ? "Queued for " + minutes + " min" : stateLabel[run.state];
}
