import { randomUUID } from "node:crypto";
import type { CiAction } from "../../core/ci/actions.ts";
import { describeAction } from "../../core/ci/actions.ts";
import { ciCapabilities, ciLimitation, type CiOperation } from "../../core/ci/capabilities.ts";
import { errorLine, errorExcerpt } from "../../core/ci/log.ts";
import { settle, type Run, type RunFilter } from "../../core/ci/model.ts";
import type { Pipelines } from "../../core/ci/pipelines.ts";
import type { Account, Repo } from "../../core/providers.ts";
import type { Copy } from "../../core/workspace.ts";
import { actionsPipelines } from "./forges/actions-pipelines.ts";
import { azurePipelines } from "./forges/azure-pipelines.ts";
import { gitlabPipelines } from "./forges/gitlab-pipelines.ts";

type Linked = {account: Account; token: string; repo: Repo};
export type CiDeps = {
  copy(copyId: string): Promise<Copy | undefined>;
  /** The copy's linked provider repository, origin checked; throws ACCOUNT_UNCONFIGURED when not linked. */
  linked(copy: Copy): Promise<Linked>;
  /** Every attached copy, for the overview across repositories. */
  copies?(): Promise<Copy[]>;
  send?: typeof fetch;
  now?: () => number;
};
export type OverviewRow = {copyId: string; repository: string; forge: Account["kind"]; runs: Run[]; error: string | null};
const operations: CiOperation[] = ["dispatch", "dispatchInputs", "rerunFailed", "rerunAll", "cancel", "liveLog"];
const previewTtl = 5 * 60_000;
const workflowTtl = 5 * 60_000;
const codeOf = (error: unknown) => error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : "PROVIDER_UNAVAILABLE";

export function pipelinesOf({account, token, repo}: Linked, send: typeof fetch = fetch): Pipelines {
  if (account.kind === "github" || account.kind === "gitea") return actionsPipelines(account, repo, token, send);
  if (account.kind === "azure") return azurePipelines(account, repo, token, send);
  return gitlabPipelines(account, repo, token, send);
}

/** CI/CD reads and confirmed writes for a working copy's linked repository. */
export function ciService(deps: CiDeps) {
  const previews = new Map<string, {copyId: string; target: string; action: CiAction; lines: string[]; expires: number}>();
  const targetOf = ({account, repo}: Linked) => account.id + "|" + repo.id;
  const now = deps.now ?? Date.now;
  /** Workflow lists change rarely; the form, the CLI and the run list share one read per five minutes. */
  const workflowCache = new Map<string, {value: Awaited<ReturnType<Pipelines["workflows"]>>; expires: number}>();
  async function cachedWorkflows(linked: Linked, api: Pipelines) {
    const key = targetOf(linked);
    const hit = workflowCache.get(key);
    if (hit && hit.expires > now()) return hit.value;
    const value = await api.workflows();
    workflowCache.set(key, {value, expires: now() + workflowTtl});
    return value;
  }

  async function context(copyId: string) {
    const copy = await deps.copy(copyId);
    if (!copy) throw new Error("NOT_FOUND");
    const linked = await deps.linked(copy);
    return {copy, linked, api: pipelinesOf(linked, deps.send)};
  }

  /** The failed job's log excerpt ending at its error line, for an agent. */
  async function excerpt(api: Pipelines, runId: string, jobId: string | null) {
    const jobs = await api.jobs(runId);
    // An agent gets the failed job's log; a selected job that did not fail is not what it should read.
    const job = jobs.find(item => item.id === jobId && item.state === "failure") ?? jobs.find(item => item.state === "failure") ?? null;
    if (!job) return {job: null, lines: [] as string[]};
    const log = await api.log(runId, job.id).catch(() => null);
    if (!log) return {job: job.name, lines: await api.notes(runId, job.id).catch(() => [] as string[])};
    const lines = log.text.split("\n");
    const at = errorLine(lines);
    const notes = await api.notes(runId, job.id).catch(() => [] as string[]);
    return {job: job.name, lines: [...(at === null ? lines.slice(-40) : errorExcerpt(lines, at)), ...(notes.length ? ["", "Annotations:", ...notes] : [])]};
  }

  return {
    context,
    excerpt,
    /** The latest runs of every linked repository, one copy per repository; copies without a link are left out. */
    async overview(copies: Copy[]) {
      const seen = new Set<string>();
      const rows: OverviewRow[] = [];
      for (let index = 0; index < copies.length; index += 4) {
        const batch = await Promise.all(copies.slice(index, index + 4).map(async copy => {
          const linked = await deps.linked(copy).catch(() => null);
          if (!linked) return null;
          const key = targetOf(linked);
          if (seen.has(key)) return null;
          seen.add(key);
          const row = {copyId: copy.id, repository: linked.repo.path, forge: linked.account.kind};
          try { return {...row, runs: (await pipelinesOf(linked, deps.send).runs("all", 1)).items, error: null}; }
          catch (error) { return {...row, runs: [], error: codeOf(error)}; }
        }));
        rows.push(...batch.filter(row => row !== null));
      }
      return {repositories: rows};
    },
    async runs(copyId: string, filter: RunFilter, page: number) {
      const {linked, api} = await context(copyId);
      const kind = linked.account.kind;
      const limitations = Object.fromEntries(operations.flatMap(operation => {
        const text = ciLimitation(kind, operation);
        return text ? [[operation, text]] : [];
      }));
      const allowed = ciCapabilities(kind);
      // A token known not to push cannot start a workflow; an unknown permission is left to the forge to refuse.
      if (allowed.dispatch && linked.repo.canPush === false) {
        allowed.dispatch = false;
        limitations.dispatch = "Your token cannot push to this repository, so it cannot start workflows.";
      }
      return {...await api.runs(filter, page), forge: kind, operations: allowed, limitations};
    },
    async run(copyId: string, runId: string) {
      const {api} = await context(copyId);
      const [run, jobs] = await Promise.all([api.run(runId), api.jobs(runId)]);
      return {run: settle(run, jobs, Date.now()), jobs};
    },
    async log(copyId: string, runId: string, jobId: string) {
      const {api} = await context(copyId);
      const log = await api.log(runId, jobId);
      const at = log ? errorLine(log.text.split("\n")) : null;
      // Annotations exist once a job failed; a running job's log is polled and needs no extra request.
      return {log, errorLine: at, notes: !log || at !== null ? await api.notes(runId, jobId).catch(() => [] as string[]) : []};
    },
    async workflows(copyId: string) {
      const {linked, api} = await context(copyId);
      return {workflows: await cachedWorkflows(linked, api), defaultBranch: linked.repo.branch};
    },
    async form(copyId: string, workflowId: string, ref: string) {
      const {api, linked} = await context(copyId);
      const workflow = (await cachedWorkflows(linked, api)).find(item => item.id === workflowId);
      if (!workflow) throw new Error("NOT_FOUND");
      return api.dispatchSpec(workflow, ref);
    },
    async prepare(copyId: string, action: CiAction) {
      const {api, linked} = await context(copyId);
      let target: string;
      if (action.kind === "dispatch") {
        const workflow = (await api.workflows()).find(item => item.id === action.workflowId);
        if (!workflow) throw new Error("NOT_FOUND");
        target = workflow.name;
      } else {
        const run = await api.run(action.runId);
        target = run.workflow + " #" + (run.number ?? run.id);
      }
      for (const [key, value] of previews) if (value.expires < Date.now()) previews.delete(key);
      if (previews.size >= 32) throw new Error("REPO_LIMIT");
      const id = randomUUID();
      const lines = describeAction(action, target);
      const expires = Date.now() + previewTtl;
      previews.set(id, {copyId, target: targetOf(linked), action, lines, expires});
      return {id, lines, expires: new Date(expires).toISOString()};
    },
    async confirm(previewId: string) {
      const preview = previews.get(previewId);
      previews.delete(previewId);
      if (!preview || preview.expires < Date.now()) throw new Error("PREVIEW_EXPIRED");
      const {api, linked} = await context(preview.copyId);
      // The copy may have been linked to another repository since the preview; never act on that one.
      if (targetOf(linked) !== preview.target) throw new Error("PREVIEW_EXPIRED");
      const {action} = preview;
      if (action.kind === "dispatch") {
        const workflow = (await api.workflows()).find(item => item.id === action.workflowId);
        if (!workflow) throw new Error("NOT_FOUND");
        await api.dispatch(workflow, action.ref, action.inputs);
      } else if (action.kind === "rerun") await api.rerun(action.runId, action.failedOnly);
      else await api.cancel(action.runId);
      return {done: true as const};
    },
  };
}
