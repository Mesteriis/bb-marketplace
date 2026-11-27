import { parseAllDocuments } from "yaml";
import { gitlabDispatchSpec } from "../../../core/ci/dispatch.ts";
import type { Job, Run, RunFilter } from "../../../core/ci/model.ts";
import type { Pipelines, Workflow } from "../../../core/ci/pipelines.ts";
import { gitlabState } from "../../../core/ci/state.ts";
import type { Account, Repo } from "../../../core/providers.ts";
import { array, authorization, client, object, originOf, segment, text } from "../provider-http.ts";
import { fetchLog } from "./log-fetch.ts";
import { gitlabProject } from "./gitlab-provider.ts";

const size = 30;
/** 1000 jobs; GitLab lists the newest first, so a longer pipeline loses its oldest jobs. */
const maxJobPages = 10;
const nullable = (value: unknown) => text(value) || null;
const id = (value: unknown) => String(value ?? "");

function webLink(account: Account, value: unknown) {
  try {
    const url = new URL(text(value));
    return url.origin === originOf(account) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

function toRun(account: Account, raw: unknown): Run {
  const row = object(raw);
  const ref = text(row.ref);
  return {
    id: id(row.id), number: Number.isSafeInteger(row.iid) ? row.iid as number : null, workflow: "Pipeline", workflowId: "pipeline",
    title: text(row.name) || ref, branch: ref || null, sha: nullable(row.sha), event: nullable(row.source),
    state: gitlabState(text(row.status)), attempt: 1, createdAt: text(row.created_at), updatedAt: nullable(row.updated_at),
    url: webLink(account, row.web_url), actor: nullable(object(row.user).username),
  };
}

/** The file a project's pipelines come from; null when it lives in another project or at a URL. */
function configPath(value: unknown) {
  const path = text(value) || ".gitlab-ci.yml";
  return path.includes("@") || /^[a-z]+:/i.test(path) ? null : path;
}

/** The pipeline configuration, after an optional `spec:` header document. */
function configDocument(source: string) {
  const documents = parseAllDocuments(source);
  if (!Array.isArray(documents) || documents.some(document => document.errors.length)) throw new Error("INVALID_CONFIG");
  return documents.at(-1)?.toJS() ?? null;
}

/** GitLab CI/CD pipelines of one project. Jobs have no steps; a running job's trace is partial. */
export function gitlabPipelines(account: Account, repo: Repo, token: string, send: typeof fetch = fetch): Pipelines {
  const http = client(account, token, send);
  const project = gitlabProject(repo.id);
  const get = async (path: string) => (await http(project + path)).payload;
  const write = (path: string, body?: unknown) => http(project + path, {method: "POST", body}).then(() => undefined);
  const pipeline = (runId: string) => "/pipelines/" + segment(runId);
  const list = async (query: Record<string, string>, page: number) => {
    const {payload, headers} = await http(project + "/pipelines?" + new URLSearchParams({...query, per_page: String(size), page: String(page)}));
    return {items: array(payload).map(row => toRun(account, row)), more: Boolean(headers.get("x-next-page"))};
  };
  const start = (ref: string, variables: Record<string, string>) =>
    write("/pipeline", {ref, variables: Object.entries(variables).map(([key, value]) => ({key, value}))});
  return {
    async runs(filter: RunFilter, page) {
      if (filter === "failed") return list({status: "failed"}, page);
      if (filter !== "active") return list({}, page);
      // A pipeline moving from pending to running between the two reads is in both lists.
      const pages = await Promise.all(["running", "pending"].map(scope => list({scope}, page)));
      const items = [...new Map(pages.flatMap(part => part.items).map(item => [item.id, item])).values()]
        .sort((left, right) => Number(right.id) - Number(left.id));
      return {items, more: pages.some(part => part.more)};
    },
    run: async runId => toRun(account, await get(pipeline(runId))),
    async jobs(runId) {
      const rows: Record<string, unknown>[] = [];
      for (let page = 1; page <= maxJobPages; page++) {
        const {payload, headers} = await http(project + pipeline(runId) + "/jobs?per_page=100&page=" + page);
        rows.push(...array(payload).map(object));
        if (!headers.get("x-next-page")) break;
      }
      rows.sort((left, right) => Number(left.id) - Number(right.id));
      return rows.map((row): Job => ({
        id: id(row.id), name: [text(row.stage), text(row.name)].filter(Boolean).join(" · "), state: gitlabState(text(row.status)),
        startedAt: nullable(row.started_at), completedAt: nullable(row.finished_at), url: webLink(account, row.web_url), steps: [],
      }));
    },
    log: (_runId, jobId) =>
      fetchLog(new URL(project + "/jobs/" + segment(jobId) + "/trace", originOf(account)), authorization(account, token), send),
    async notes(_runId, jobId) {
      const job = object(await get("/jobs/" + segment(jobId)));
      const reason = text(job.failure_reason);
      return job.status === "failed" && reason ? ["Failure reason: " + reason.replaceAll("_", " ")] : [];
    },
    async workflows() {
      const configured = text(object(await get("")).ci_config_path);
      return [{id: "pipeline", name: configured || ".gitlab-ci.yml", path: configPath(configured)}];
    },
    async dispatchSpec(workflow: Workflow, ref) {
      if (!workflow.path) return {dispatchable: true, inputs: []};
      const file = workflow.path.replace(/^\/+/, "");
      // No file on this ref (Auto DevOps, a branch without CI) or an unreadable one: the pipeline still runs with its defaults.
      try {
        const source = (await http(project + "/repository/files/" + segment(file) + "/raw?ref=" + segment(ref), {raw: true, accept: "text/plain"})).payload;
        return gitlabDispatchSpec(configDocument(text(source)));
      } catch { return {dispatchable: true, inputs: []}; }
    },
    dispatch: (_workflow, ref, inputs) => start(ref, inputs),
    // GitLab has no "re-run everything": a new pipeline would run another commit without the original variables.
    async rerun(runId, failedOnly) {
      if (!failedOnly) throw new Error("PROVIDER_UNSUPPORTED");
      await write(pipeline(runId) + "/retry");
    },
    cancel: runId => write(pipeline(runId) + "/cancel"),
  };
}
