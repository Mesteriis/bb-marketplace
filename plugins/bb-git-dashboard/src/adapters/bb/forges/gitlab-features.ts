import type { Repo } from "../../../core/providers.ts";
import type { FeatureList, RepositorySection } from "../../../core/repository-features.ts";
import { array, object, text, type Http } from "../provider-http.ts";
import { gitlabProject } from "./gitlab-provider.ts";

type Row = FeatureList["items"][number];

function link(value: unknown, repo: Repo) {
  try {
    const url = new URL(text(value));
    return url.origin === new URL(repo.clone).origin && !url.username && !url.password && !url.search && !url.hash ? url.href : null;
  } catch { return null; }
}

/** Pipelines, issues and CI/CD variables of a GitLab project. Variable values are never read out: they are usually secrets. */
export async function gitlabFeatures(repo: Repo, section: RepositorySection, http: Http): Promise<FeatureList> {
  const root = gitlabProject(repo.id);
  if (section === "actions") {
    const rows = array((await http(root + "/pipelines?per_page=30")).payload).map(object).filter(row => Number.isSafeInteger(row.id));
    return {notice: null, items: rows.map((row): Row => ({
      id: String(row.id), name: text(row.name) || "Pipeline #" + String(row.iid ?? row.id), status: text(row.status),
      detail: text(row.ref) || null, updated: text(row.updated_at) || text(row.created_at) || null, url: link(row.web_url, repo),
    }))};
  }
  if (section === "issues") {
    const rows = array((await http(root + "/issues?state=all&per_page=30")).payload).map(object).filter(row => Number.isSafeInteger(row.iid));
    return {notice: null, items: rows.map((row): Row => ({
      id: String(row.iid), name: "#" + row.iid + " " + text(row.title), status: text(row.state) === "opened" ? "open" : text(row.state),
      detail: array(row.labels).map(label => typeof label === "string" ? label : text(object(label).name)).filter(Boolean).join(", ") || null,
      updated: text(row.updated_at) || null, url: link(row.web_url, repo),
    }))};
  }
  let payload: unknown;
  try { payload = (await http(root + "/variables?per_page=100")).payload; }
  catch (error) {
    if (error instanceof Error && error.message === "PROVIDER_DENIED") return {items: [], notice: "CI/CD variables need the Maintainer role in this project."};
    throw error;
  }
  const rows = array(payload).map(object).filter(row => text(row.key));
  return {notice: "Values are not shown.", items: rows.map((row): Row => {
    const kind = row.variable_type === "file" ? "File" : "Variable";
    const scope = text(row.environment_scope) || "*";
    const flags = [row.protected === true && "protected", row.masked === true && "masked", scope !== "*" && "environment " + scope].filter(Boolean);
    return {id: kind + ":" + text(row.key) + ":" + scope, name: text(row.key), status: kind, detail: flags.join(", ") || null, updated: null, url: null};
  })};
}
