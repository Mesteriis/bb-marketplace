import { catalogPage, pull, repo as repoSchema, type Account, type Provider, type Pull, type Repo } from "../../../core/providers.ts";
import { array, cloneUrl, object, segment, sha, text, type Http } from "../provider-http.ts";

const size = 40;
const api = "/api/v4";
/** A project by numeric id, or by its full path encoded as one segment. */
export const gitlabProject = (idOrPath: string) => api + "/projects/" + segment(idOrPath);

function pathOf(path: string) {
  const parts = path.split("/");
  if (parts.length < 2 || parts.some(part => !part || part === "." || part === "..")) throw new Error("INVALID_INPUT");
  return path;
}

export function gitlabRepo(account: Account, raw: unknown): Repo {
  const row = object(raw);
  return repoSchema.parse({
    id: String(row.id ?? ""), accountId: account.id, project: text(object(row.namespace).full_path), name: text(row.name),
    path: text(row.path_with_namespace), clone: cloneUrl(account, row.http_url_to_repo), branch: text(row.default_branch) || null, canPush: null,
  });
}

function toPull(raw: unknown, repo: Repo): Pull {
  const row = object(raw);
  const fork = row.source_project_id !== undefined && row.source_project_id !== row.target_project_id;
  const state = text(row.state);
  return pull.parse({
    number: row.iid, title: text(row.title), body: text(row.description), state: state === "opened" ? "open" : state,
    head: {repo: fork ? "project " + String(row.source_project_id) : repo.path, branch: text(row.source_branch), sha: sha(row.sha)},
    base: {repo: repo.path, branch: text(row.target_branch), sha: sha(object(row.diff_refs).base_sha)},
    updated: text(row.updated_at) || null, merged: state === "merged",
  });
}

/** GitLab REST v4: member projects, merge requests and their writes. */
export function gitlabProvider(account: Account, http: Http): Provider {
  const project = (repo: Repo) => gitlabProject(repo.id);
  const mr = (repo: Repo, number: number) => project(repo) + "/merge_requests/" + number;
  const getPull = async (repo: Repo, number: number) => toPull((await http(mr(repo, number))).payload, repo);
  const getBranch = async (repo: Repo, branch: string) => {
    const revision = sha(object(object((await http(project(repo) + "/repository/branches/" + segment(branch))).payload).commit).id);
    if (!revision) throw new Error("NO_REMOTE_BRANCH");
    return revision;
  };
  return {
    async repositories(page) {
      const {payload, headers} = await http(api + "/projects?membership=true&simple=true&order_by=last_activity_at&per_page=" + size + "&page=" + page);
      const rows = array(payload);
      return catalogPage.parse({items: rows.map(row => gitlabRepo(account, row)),
        more: Boolean(headers.get("x-next-page")) || rows.length === size, observedAt: new Date().toISOString()});
    },
    repository: async path => gitlabRepo(account, (await http(gitlabProject(pathOf(path)))).payload),
    async pulls(repo, page) {
      const {payload, headers} = await http(project(repo) + "/merge_requests?state=all&order_by=updated_at&per_page=" + size + "&page=" + page);
      return {items: array(payload).map(row => toPull(row, repo)), more: Boolean(headers.get("x-next-page"))};
    },
    pull: getPull,
    branch: getBranch,
    async details(repo, number) {
      const issues: string[] = [];
      const load = async (kind: string, path: string, unsupported = false) => {
        try { return (await http(path, {unsupported})).payload; }
        catch (error) { issues.push(kind + " · " + (error instanceof Error ? error.message : "PROVIDER_UNAVAILABLE")); return null; }
      };
      const [current, diffs, notes] = await Promise.all([
        http(mr(repo, number)).then(result => object(result.payload)),
        // `/diffs` arrived in GitLab 15.7; an older server answers 404.
        load("Diff", mr(repo, number) + "/diffs?per_page=100", true),
        load("Comments", mr(repo, number) + "/notes?sort=asc&per_page=50"),
      ]);
      const diff = diffs === null ? null : array(diffs).map(object).map(file => {
        const from = text(file.old_path), to = text(file.new_path);
        return "diff --git a/" + from + " b/" + to + "\n--- " + (file.new_file === true ? "/dev/null" : "a/" + from) + "\n+++ " +
          (file.deleted_file === true ? "/dev/null" : "b/" + to) + "\n" + text(file.diff);
      }).join("");
      const pipeline = object(current.head_pipeline);
      return {
        pull: toPull(current, repo), diff, changes: [], issues,
        comments: array(notes).map(object).filter(note => note.system !== true)
          .map(note => ({author: text(object(note.author).username) || "Unknown", body: text(note.body)})),
        checks: pipeline.id === undefined ? [] : [{name: "Pipeline #" + String(pipeline.id), state: text(pipeline.status)}],
      };
    },
    async mutate(repo, action) {
      if (action.kind === "create") {
        if (await getBranch(repo, action.head) !== action.expected) throw new Error("STALE_HEAD");
        const {payload} = await http(project(repo) + "/merge_requests", {method: "POST",
          body: {source_branch: action.head, target_branch: action.base, title: action.title, description: action.body}});
        const number = object(payload).iid;
        if (typeof number !== "number" || !Number.isInteger(number) || number < 1) throw new Error("OUTCOME_UNKNOWN");
        return {number, outcome: "completed"};
      }
      const raw = object((await http(mr(repo, action.number))).payload);
      const current = toPull(raw, repo);
      if (current.head.sha !== action.expected) throw new Error("STALE_HEAD");
      switch (action.kind) {
        case "comment":
          await http(mr(repo, action.number) + "/notes", {method: "POST", body: {body: action.body}});
          break;
        case "review": {
          const users = array((await http(api + "/users?username=" + segment(action.reviewer))).payload).map(object);
          const user = users.find(row => text(row.username).toLowerCase() === action.reviewer.toLowerCase());
          if (!user || !Number.isSafeInteger(user.id)) throw new Error("PROVIDER_REJECTED");
          // GitLab replaces the reviewer list, so the current reviewers are sent along.
          const existing = array(raw.reviewers).map(object).map(row => row.id).filter(Number.isSafeInteger) as number[];
          const {payload} = await http(mr(repo, action.number), {method: "PUT", body: {reviewer_ids: [...new Set([...existing, user.id as number])]}});
          // GitLab Free keeps one reviewer and drops the rest without an error.
          if (!array(object(payload).reviewers).some(row => object(row).id === user.id)) throw new Error("PROVIDER_UNSUPPORTED");
          break;
        }
        case "reopen":
          if (current.merged) throw new Error("PROVIDER_REJECTED");
          await http(mr(repo, action.number), {method: "PUT", body: {state_event: "reopen"}});
          break;
        case "merge": {
          const {payload} = await http(mr(repo, action.number) + "/merge", {method: "PUT", body: {sha: action.expected}});
          if (text(object(payload).state) !== "merged") throw new Error("OUTCOME_UNKNOWN");
          break;
        }
      }
      return {number: action.number, outcome: "completed"};
    },
  };
}
