import type { DispatchSpec } from "./dispatch.ts";
import type { Job, Run, RunFilter } from "./model.ts";

export type Workflow = {id: string; name: string; path: string | null};
export type JobLog = {text: string; truncated: boolean} | null;

/** CI/CD of one repository on one forge. Every write is a single request; callers confirm it first. */
export interface Pipelines {
  runs(filter: RunFilter, page: number): Promise<{items: Run[]; more: boolean}>;
  run(runId: string): Promise<Run>;
  jobs(runId: string): Promise<Job[]>;
  /** Null while the forge has no log for the job yet (GitHub publishes it when the job ends). */
  log(runId: string, jobId: string): Promise<JobLog>;
  workflows(): Promise<Workflow[]>;
  dispatchSpec(workflow: Workflow, ref: string): Promise<DispatchSpec>;
  dispatch(workflow: Workflow, ref: string, inputs: Record<string, string>): Promise<void>;
  rerun(runId: string, failedOnly: boolean): Promise<void>;
  cancel(runId: string): Promise<void>;
}
