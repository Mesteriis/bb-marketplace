import type { Job, Run, RunFilter } from "../../../core/ci/model.ts";
import type { Pipelines, Workflow } from "../../../core/ci/pipelines.ts";
import { azureState } from "../../../core/ci/state.ts";
import type { Account, Repo } from "../../../core/providers.ts";
import { array, authorization, client, object, originOf, segment, text } from "../provider-http.ts";
import { fetchLog } from "./log-fetch.ts";

const size = 30;
const nullable = (value: unknown) => text(value) || null;
const branchOf = (ref: unknown) => text(ref).replace(/^refs\/heads\//, "") || null;
const values = (payload: unknown) => array(object(payload).value);

function webLink(value: unknown) {
  try {
    const url = new URL(text(value));
    return url.origin === "https://dev.azure.com" && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

function toRun(raw: unknown): Run {
  const row = object(raw);
  const definition = object(row.definition);
  return {
    id: String(row.id ?? ""), number: null, workflow: text(definition.name) || "Pipeline",
    workflowId: definition.id === undefined ? null : String(definition.id), title: text(row.buildNumber),
    branch: branchOf(row.sourceBranch), sha: nullable(row.sourceVersion), event: nullable(row.reason),
    state: azureState(text(row.status), nullable(row.result)), attempt: 1, createdAt: text(row.queueTime),
    updatedAt: nullable(row.finishTime) ?? nullable(row.startTime), url: webLink(object(object(row._links).web).href),
    actor: nullable(object(row.requestedFor).displayName),
  };
}

/** Azure Pipelines builds of one Azure Repos repository. Runtime parameters are not supported. */
export function azurePipelines(account: Account, repo: Repo, token: string, send: typeof fetch = fetch): Pipelines {
  const http = client(account, token, send);
  const root = "/" + segment(account.organization) + "/" + segment(repo.project) + "/_apis/build";
  const endpoint = (path: string, query: Record<string, string> = {}) =>
    root + path + "?" + new URLSearchParams({...query, "api-version": "7.1"});
  const get = async (path: string, query?: Record<string, string>) => (await http(endpoint(path, query))).payload;
  const build = (runId: string) => "/builds/" + segment(runId);
  const timeline = async (runId: string) => array(object(await get(build(runId) + "/timeline")).records).map(object);
  const queue = (body: Record<string, unknown>) => http(endpoint("/builds"), {method: "POST", body}).then(() => undefined);
  return {
    async runs(filter: RunFilter, page) {
      const query: Record<string, string> = {repositoryId: repo.id, repositoryType: "TfsGit", "$top": String(size * page), queryOrder: "queueTimeDescending"};
      if (filter === "active") query.statusFilter = "inProgress,notStarted,cancelling";
      if (filter === "failed") query.resultFilter = "failed";
      const rows = values(await get("/builds", query));
      return {items: rows.slice(size * (page - 1)).map(toRun), more: rows.length === size * page};
    },
    run: async runId => toRun(await get(build(runId))),
    async jobs(runId) {
      const records = await timeline(runId);
      return records.filter(record => record.type === "Job").map((record): Job => ({
        id: text(record.id), name: text(record.name), state: azureState(text(record.state), nullable(record.result)),
        startedAt: nullable(record.startTime), completedAt: nullable(record.finishTime), url: null,
        steps: records.filter(step => step.type === "Task" && step.parentId === record.id)
          .sort((left, right) => Number(left.order) - Number(right.order))
          .map((step, index) => ({number: index + 1, name: text(step.name), state: azureState(text(step.state), nullable(step.result))})),
      }));
    },
    async log(runId, jobId) {
      const record = (await timeline(runId)).find(row => row.id === jobId);
      const logId = object(record?.log).id;
      if (!Number.isSafeInteger(logId)) return null;
      return fetchLog(new URL(endpoint(build(runId) + "/logs/" + logId), originOf(account)), authorization(account, token), send);
    },
    notes: async () => [],
    async workflows() {
      return values(await get("/definitions", {repositoryId: repo.id, repositoryType: "TfsGit"})).map(object)
        .map((row): Workflow => ({id: String(row.id ?? ""), name: text(row.name), path: nullable(row.path)}));
    },
    dispatchSpec: async () => ({dispatchable: true, inputs: []}),
    async dispatch(workflow, ref, inputs) {
      if (Object.keys(inputs).length) throw new Error("PROVIDER_UNSUPPORTED");
      await queue({definition: {id: Number(workflow.id)}, sourceBranch: ref.startsWith("refs/") ? ref : "refs/heads/" + ref});
    },
    async rerun(runId, failedOnly) {
      if (failedOnly) {
        await http(endpoint(build(runId), {retry: "true"}), {method: "PATCH", body: {}});
        return;
      }
      const previous = object(await get(build(runId)));
      await queue({definition: {id: Number(object(previous.definition).id)}, sourceBranch: text(previous.sourceBranch), sourceVersion: text(previous.sourceVersion)});
    },
    cancel: runId => http(endpoint(build(runId)), {method: "PATCH", body: {status: "cancelling"}}).then(() => undefined),
  };
}
