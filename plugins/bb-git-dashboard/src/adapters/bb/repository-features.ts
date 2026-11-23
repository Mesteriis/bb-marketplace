import type { Account, Repo } from "../../core/providers.ts";
import type { FeatureList, RepositorySection } from "../../core/repository-features.ts";
import { forgePrefix, forgeRepositoryPath } from "./forge-provider.ts";
import { array, object, segment, text, type Http } from "./provider-http.ts";

type Row = FeatureList["items"][number];

function link(value:unknown, repo:Repo) {
  try {
    const url = new URL(text(value));
    return url.origin === new URL(repo.clone).origin && !url.username && !url.password && !url.search && !url.hash ? url.href : null;
  } catch { return null; }
}

export async function repositoryFeatures(account:Account, repo:Repo, section:RepositorySection, http:Http):Promise<FeatureList> {
  const read = async (path:string) => (await http(path)).payload;
  if (account.kind === "azure") {
    if (section === "issues") return {items:[],notice:"Azure Boards are scoped to the Azure DevOps project."};
    if (section === "variables") return {items:[],notice:"Azure variable groups are scoped to the Azure DevOps project."};
    const query = new URLSearchParams({repositoryId:repo.id,repositoryType:"TfsGit","$top":"30","api-version":"7.1"});
    const payload = object(await read("/" + segment(account.organization) + "/" + segment(repo.project) + "/_apis/build/builds?" + query));
    const items = array(payload.value).map(object).filter(row => Number.isSafeInteger(row.id)).map((row):Row => ({
      id:String(row.id), name:[text(object(row.definition).name),text(row.buildNumber)].filter(Boolean).join(" · "),
      status:text(row.result) || text(row.status), detail:text(row.sourceBranch).replace(/^refs\/heads\//,"") || null,
      updated:text(row.finishTime) || text(row.startTime) || text(row.queueTime) || null,
      url:link(object(object(row._links).web).href, repo),
    }));
    return {items,notice:null};
  }
  const github = account.kind === "github";
  const root = forgePrefix(account) + forgeRepositoryPath(repo);
  const page = github ? "per_page=30" : "page=1&limit=30";
  if (section === "actions") {
    const payload = object(await read(root + (github ? "/actions/runs?" : "/actions/tasks?") + page));
    const items = array(payload.workflow_runs).map(object).filter(row => Number.isSafeInteger(row.id)).map((row):Row => ({
      id:String(row.id), name:text(row.display_title) || text(row.name) || "Run #" + row.id,
      status:text(row.conclusion) || text(row.status), detail:text(row.head_branch) || null,
      updated:text(row.updated_at) || text(row.created_at) || null,
      url:link(github ? row.html_url : row.url, repo),
    }));
    return {items,notice:null};
  }
  if (section === "issues") {
    const payload = await read(root + "/issues?state=all&" + page);
    const items = array(payload).map(object).filter(row => !row.pull_request && Number.isSafeInteger(row.number)).map((row):Row => ({
      id:String(row.number), name:"#" + row.number + " " + text(row.title), status:text(row.state),
      detail:array(row.labels).map(label => text(object(label).name)).filter(Boolean).join(", ") || null,
      updated:text(row.updated_at) || null, url:link(row.html_url, repo),
    }));
    return {items,notice:null};
  }
  const lists = await Promise.allSettled([read(root + "/actions/variables?" + page),read(root + "/actions/secrets?" + page)]);
  if (lists[0].status === "rejected" && lists[1].status === "rejected") throw lists[0].reason;
  const items = lists.flatMap((result,index) => {
    if (result.status === "rejected") return [];
    const secret = index === 1;
    const kind = secret ? "Secret" : "Variable";
    const rows = github ? object(result.value)[secret ? "secrets" : "variables"] : result.value;
    return array(rows).map(object).filter(row => text(row.name)).map((row):Row => ({
      id:kind + ":" + text(row.name), name:text(row.name), status:kind,
      detail:secret ? null : text(github ? row.value : row.data), updated:text(row.updated_at) || null, url:null,
    }));
  });
  const notice = lists[0].status === "rejected" ? "Variable names and values are unavailable from this account." :
    lists[1].status === "rejected" ? "Secret names are unavailable from this account." : null;
  return {items,notice};
}
