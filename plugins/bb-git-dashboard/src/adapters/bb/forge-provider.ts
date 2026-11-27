import { catalogPage, pull, repo, type Account, type Provider, type Repo } from "../../core/providers.ts";
import { array, cloneUrl, object, segment, sha, text, type Http } from "./provider-http.ts";

const size = 40;
const name = (user: unknown) => text(object(user).login) || text(object(user).username) || "Unknown";
export function forgeRepositoryPath(repo: Repo) {
  const parts = repo.path.split("/");
  if (parts.length !== 2 || parts.some(part => !part || part === "." || part === "..")) throw new Error("INVALID_INPUT");
  return "/repos/" + parts.map(segment).join("/");
}
export function forgePrefix(account: Account) {
  if (account.kind === "gitea") return "/api/v1";
  if (account.kind === "gitlab") return "/api/v4";
  return ["github.com","api.github.com"].includes(new URL(account.origin).hostname) ? "" : "/api/v3";
}
function normalized(raw: unknown) {
  const value = object(raw);
  const ref = (side: unknown) => {
    const item = object(side);
    return {repo:text(object(item.repo).full_name) || text(item.label), branch:text(item.ref), sha:sha(item.sha)};
  };
  return pull.parse({
    number:value.number, title:text(value.title), body:text(value.body), state:text(value.state),
    head:ref(value.head), base:ref(value.base), updated:text(value.updated_at) || null,
    merged:value.merged === true || Boolean(value.merged_at),
  });
}

export function forgeProvider(account: Account, request: Http): Provider {
  const github = account.kind === "github";
  const prefix = forgePrefix(account);
  const http: Http = (path, options) => request(prefix + path, options);
  const pagination = (page: number) => (github ? "per_page=" : "limit=") + size + "&page=" + page;
  const next = (headers: Headers, length: number) => /rel="next"/.test(headers.get("link") ?? "") || length === size;
  const getPull = async (repo: Repo, number: number) => normalized((await http(forgeRepositoryPath(repo) + "/pulls/" + number)).payload);
  const getBranch = async (repo: Repo, branch: string) => {
    const {payload} = await http(forgeRepositoryPath(repo) + "/branches/" + segment(branch));
    const commit = object(object(payload).commit);
    const revision = sha(github ? commit.sha : commit.id);
    if (!revision) throw new Error("NO_REMOTE_BRANCH");
    return revision;
  };

  function forgeRepo(raw: unknown) {
    const value = object(raw);
    const full = text(value.full_name);
    const slug = full.split("/");
    return repo.parse({
      id:String(value.id ?? ""), accountId:account.id, project:slug[0] ?? "", name:text(value.name),
      path:full, clone:cloneUrl(account,value.clone_url), branch:text(value.default_branch) || null,
      canPush:typeof object(value.permissions).push === "boolean" ? object(value.permissions).push : null,
    });
  }

  return {
    async repository(path) {
      const root = forgeRepositoryPath({path} as Repo);
      return forgeRepo((await http(root)).payload);
    },
    async repositories(page) {
      const {payload,headers} = await http("/user/repos?" + pagination(page));
      const rows = array(payload);
      const items = rows.map(raw => forgeRepo(raw));
      return catalogPage.parse({items, more:next(headers,rows.length), observedAt:new Date().toISOString()});
    },
    async pulls(repo, page) {
      const {payload,headers} = await http(forgeRepositoryPath(repo) + "/pulls?state=all&" + pagination(page));
      const items = array(payload).map(normalized);
      return {items, more:next(headers,items.length)};
    },
    pull:getPull,
    branch:getBranch,
    async details(repo, number) {
      const current = await getPull(repo,number);
      const root = forgeRepositoryPath(repo);
      const pr = root + "/pulls/" + number;
      const checks = current.head.sha && current.head.repo
        ? "/repos/" + current.head.repo.split("/").map(segment).join("/") + "/commits/" + current.head.sha : null;
      const issues: string[] = [];
      const load = async (kind: string, request: Promise<{payload: unknown}>) => {
        try { return (await request).payload; } catch (error) {
          issues.push(kind + " · " + (error instanceof Error ? error.message : "PROVIDER_UNAVAILABLE"));
          return null;
        }
      };
      const [patch, comments, reviews, inline, statuses, runs] = await Promise.all([
        load("Diff", http(github ? pr : pr + ".diff", {raw:true, ...(github ? {accept:"application/vnd.github.diff"} : {})})),
        load("Comments", http(root + "/issues/" + number + "/comments?" + pagination(1))),
        load("Reviews", http(pr + "/reviews?" + pagination(1))),
        github ? load("Review comments", http(pr + "/comments?" + pagination(1))) : Promise.resolve([]),
        checks ? load("Commit statuses", http(checks + "/status?" + pagination(1))) : Promise.resolve(null),
        github && checks ? load("Check runs", http(checks + "/check-runs?" + pagination(1))) : Promise.resolve(null),
      ]);
      return {
        pull:current, diff:typeof patch === "string" ? patch : null, changes:[], issues,
        comments:[...array(comments), ...array(reviews), ...array(inline)].map(raw => {
          const item = object(raw);
          return {author:name(item.user), body:text(item.body) || text(item.state)};
        }),
        checks:[
          ...array(object(statuses).statuses).map(raw => ({name:text(object(raw).context),state:text(object(raw).state)})),
          ...array(object(runs).check_runs).map(raw => ({name:text(object(raw).name),state:text(object(raw).conclusion) || text(object(raw).status)})),
        ],
      };
    },
    async createFile(repo, change) {
      const root = forgeRepositoryPath(repo);
      const file = root + "/contents/" + change.path.split("/").map(segment).join("/");
      const content = Buffer.from(change.content).toString("base64");
      if (github) await http(root + "/git/refs",{method:"POST",body:{ref:"refs/heads/" + change.branch,sha:change.base}});
      const {payload} = await http(file,github ? {method:"PUT",body:{message:change.message,content,branch:change.branch}}
        : {method:"POST",body:{message:change.message,content,branch:change.baseBranch,new_branch:change.branch}});
      const commit = object(object(payload).commit);
      const made = sha(commit.sha);
      if (!made) throw new Error("OUTCOME_UNKNOWN");
      // Gitea starts the branch at the base branch's head, which may have moved since the base was read.
      const parents = array(commit.parents).map(parent => sha(object(parent).sha));
      if (!github && parents.length && !parents.includes(change.base)) throw new Error("STALE_HEAD");
      return made;
    },
    async mutate(repo, action) {
      const root = forgeRepositoryPath(repo);
      if (action.kind === "create") {
        if (await getBranch(repo, action.head) !== action.expected) throw new Error("STALE_HEAD");
        const {payload} = await http(root + "/pulls",{method:"POST",body:{head:action.head,base:action.base,title:action.title,body:action.body}});
        const number = object(payload).number;
        if (typeof number !== "number" || !Number.isInteger(number) || number < 1) throw new Error("OUTCOME_UNKNOWN");
        return {number,outcome:"completed"};
      }
      const current = await getPull(repo,action.number);
      if (current.head.sha !== action.expected) throw new Error("STALE_HEAD");
      const pr = root + "/pulls/" + action.number;
      switch (action.kind) {
        case "comment":
          await http(root + "/issues/" + action.number + "/comments",{method:"POST",body:{body:action.body}});
          break;
        case "review":
          await http(pr + "/requested_reviewers",{method:"POST",body:{reviewers:[action.reviewer]}});
          break;
        case "reopen":
          if (current.merged) throw new Error("PROVIDER_REJECTED");
          await http(pr,{method:"PATCH",body:{state:"open"}});
          break;
        case "merge": {
          const {payload} = await http(pr + "/merge",github
            ? {method:"PUT",body:{sha:action.expected}}
            : {method:"POST",body:{Do:"merge",head_commit_id:action.expected}});
          if (github && object(payload).merged !== true) throw new Error("PROVIDER_REJECTED");
          if (!github && !(await getPull(repo,action.number).catch(() => null))?.merged) throw new Error("OUTCOME_UNKNOWN");
          break;
        }
      }
      return {number:action.number,outcome:"completed"};
    },
  };
}
