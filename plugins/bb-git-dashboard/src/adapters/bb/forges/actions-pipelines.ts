import { parse } from "yaml";
import { dispatchSpec } from "../../../core/ci/dispatch.ts";
import { isActive, type Job, type Run, type RunFilter } from "../../../core/ci/model.ts";
import type { Pipelines, Workflow } from "../../../core/ci/pipelines.ts";
import { githubState } from "../../../core/ci/state.ts";
import type { Account, Repo } from "../../../core/providers.ts";
import { forgePrefix, forgeRepositoryPath } from "../forge-provider.ts";
import { array, authorization, client, object, originOf, segment, text } from "../provider-http.ts";
import { fetchLog } from "./log-fetch.ts";

const size = 30;
const nullable = (value: unknown) => text(value) || null;

/** A forge link, kept only over https on the forge's own web origin. */
function linkOn(web: string, value: unknown) {
  try {
    const url = new URL(text(value));
    return url.protocol === "https:" && url.origin === web && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

function toRun(raw: unknown, web: string): Run {
  const row = object(raw);
  return {
    id: String(row.id ?? ""), number: Number.isSafeInteger(row.run_number) ? row.run_number as number : null,
    workflow: text(row.name) || text(row.path) || "Workflow", workflowId: nullable(row.path) ?? (row.workflow_id === undefined ? null : String(row.workflow_id)),
    title: text(row.display_title) || text(row.name), branch: nullable(row.head_branch), sha: nullable(row.head_sha), event: nullable(row.event),
    state: githubState(text(row.status), nullable(row.conclusion)), attempt: Number.isSafeInteger(row.run_attempt) && (row.run_attempt as number) > 0 ? row.run_attempt as number : 1,
    createdAt: text(row.created_at), updatedAt: nullable(row.updated_at), url: linkOn(web, row.html_url), actor: nullable(object(row.actor).login),
    startedAt: nullable(row.run_started_at),
  };
}

function toJob(raw: unknown, web: string): Job {
  const row = object(raw);
  return {
    id: String(row.id ?? ""), name: text(row.name), state: githubState(text(row.status), nullable(row.conclusion)),
    startedAt: nullable(row.started_at), completedAt: nullable(row.completed_at), url: linkOn(web, row.html_url),
    steps: array(row.steps).map(object).map(step => ({number: Number(step.number) || 0, name: text(step.name),
      state: githubState(text(step.status), nullable(step.conclusion))})),
  };
}

/** GitHub Actions and Gitea Actions: Gitea's Actions API mirrors GitHub's under `/api/v1`. */
export function actionsPipelines(account: Account, repo: Repo, token: string, send: typeof fetch = fetch): Pipelines {
  const gitea = account.kind === "gitea";
  const http = client(account, token, send);
  const api = originOf(account);
  const web = api === "https://api.github.com" ? "https://github.com" : api;
  const root = forgePrefix(account) + forgeRepositoryPath(repo);
  const get = async (path: string) => (await http(root + path)).payload;
  const write = (path: string, body?: unknown) => http(root + path, {method: "POST", body, unsupported: gitea}).then(() => undefined);
  const paging = (page: number, count = size) => (gitea ? "limit=" : "per_page=") + count + "&page=" + page;
  const list = async (page: number, status?: string) => {
    const payload = object(await get("/actions/runs?" + paging(page) + (status ? "&status=" + status : "")));
    const items = array(payload.workflow_runs).map(row => toRun(row, web));
    const total = Number(payload.total_count);
    return {items, more: Number.isFinite(total) ? total > page * size : items.length === size};
  };
  return {
    async runs(filter: RunFilter, page) {
      if (filter !== "active") return list(page, filter === "failed" ? "failure" : undefined);
      // The status filter is served from an index that can lag behind a run that just started, so the newest
      // runs are also read unfiltered and their active ones kept.
      const parts = await Promise.all([...["in_progress", "queued", "waiting"].map(status => list(page, status)),
        list(1).then(recent => ({items: recent.items.filter(item => isActive(item.state)), more: false}))]);
      // A run can change state between the requests and appear twice; keep its first copy.
      const unique = new Map(parts.flatMap(part => part.items).map(item => [item.id, item] as const).reverse());
      return {items: [...unique.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
        more: parts.some(part => part.more)};
    },
    run: async runId => toRun(await get("/actions/runs/" + segment(runId)), web),
    jobs: async runId => array(object(await get("/actions/runs/" + segment(runId) + "/jobs?" + paging(1, 100))).jobs).map(row => toJob(row, web)),
    log: (_runId, jobId) => fetchLog(new URL(root + "/actions/jobs/" + segment(jobId) + "/logs", originOf(account)), authorization(account, token), send),
    async notes(_runId, jobId) {
      // On GitHub a job is a check run with the same id; Gitea has no annotations API.
      if (gitea) return [];
      return array(await get("/check-runs/" + segment(jobId) + "/annotations")).map(object)
        .filter(row => row.annotation_level === "failure" && text(row.message))
        // ".github" marks an annotation on the workflow itself rather than on a file.
        .map(row => text(row.path) && text(row.path) !== ".github" ? text(row.path) + ":" + (Number(row.start_line) || 1) + " — " + text(row.message) : text(row.message))
        // The runner's closing "Process completed with exit code N" is kept only when nothing more specific exists.
        .filter((note, _, all) => !/^Process completed with exit code \d+\.?$/.test(note) || all.length === 1)
        .slice(0, 10);
    },
    async workflows() {
      return array(object(await get("/actions/workflows?" + paging(1, 100))).workflows).map(object)
        .map((row): Workflow => ({id: String(row.id ?? ""), name: text(row.name) || text(row.path), path: nullable(row.path)}));
    },
    async dispatchSpec(workflow, ref) {
      if (!workflow.path) return {dispatchable: false, inputs: []};
      const file = object(await get("/contents/" + workflow.path.split("/").map(segment).join("/") + "?ref=" + segment(ref)));
      if (file.encoding !== "base64") return {dispatchable: false, inputs: []};
      try { return dispatchSpec(parse(Buffer.from(text(file.content), "base64").toString("utf8"))); }
      catch { return {dispatchable: false, inputs: []}; }
    },
    dispatch: (workflow, ref, inputs) => write("/actions/workflows/" + segment(workflow.id) + "/dispatches", {ref, inputs}),
    rerun: (runId, failedOnly) => write("/actions/runs/" + segment(runId) + (failedOnly ? "/rerun-failed-jobs" : "/rerun")),
    cancel: runId => write("/actions/runs/" + segment(runId) + "/cancel"),
  };
}
