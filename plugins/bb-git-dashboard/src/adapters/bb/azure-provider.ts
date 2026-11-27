import { pull as pullSchema, repo as repoSchema, type Account, type Provider, type Pull, type Repo } from "../../core/providers.ts";
import { array, cloneUrl, object, originOf, segment, sha, text, type Http } from "./provider-http.ts";

const pageSize = 50;
const refPrefix = "refs/heads/";
const branchName = (value: unknown) => text(value).startsWith(refPrefix) ? text(value).slice(refPrefix.length) : "";
const values = (payload: unknown) => Array.isArray(payload) ? payload : array(object(payload).value);

function parsePull(value: unknown, repo: Repo): Pull {
  const row = object(value);
  const fork = object(row.forkSource);
  const forkRepo = object(fork.repository);
  const forkPath = [text(object(forkRepo.project).name), text(forkRepo.name)].filter(Boolean).join("/");
  const forkIdentity = forkPath || text(forkRepo.id) || "Unidentified fork";
  return pullSchema.parse({
    number: row.pullRequestId,
    title: text(row.title),
    body: text(row.description),
    state: text(row.status) || "unknown",
    head: {
      repo: row.forkSource ? forkIdentity : repo.path,
      branch: branchName(row.sourceRefName),
      sha: sha(object(row.lastMergeSourceCommit).commitId),
    },
    base: {repo: repo.path, branch: branchName(row.targetRefName), sha: sha(object(row.lastMergeTargetCommit).commitId)},
    updated: text(row.closedDate) || text(row.creationDate) || null,
    merged: row.status === "completed",
  });
}

export function azureProvider(account: Account, http: Http): Provider {
  originOf(account);
  const scope = "/" + segment(account.organization);
  function repoPath(repo: Repo) {
    if (repo.accountId !== account.id || [".", ".."].includes(repo.project) || [".", ".."].includes(repo.id)) {
      throw new Error("ACCESS_DENIED");
    }
    return scope + "/" + segment(repo.project) + "/_apis/git/repositories/" + segment(repo.id);
  }
  const endpoint = (path: string, options: Record<string, string> = {}) =>
    path + "?" + new URLSearchParams({"api-version":"7.1", ...options});
  const pullPath = (repo: Repo, number: number) => repoPath(repo) + "/pullRequests/" + number;
  const fetchPull = async (repo: Repo, number: number) => {
    const {payload} = await http(endpoint(pullPath(repo, number)));
    const raw = object(payload);
    const value = parsePull(raw, repo);
    if (value.number !== number) throw new Error("PROVIDER_REJECTED");
    return {raw, value};
  };
  async function branch(repo: Repo, name: string) {
    const ref = refPrefix + name;
    const refs = repoPath(repo) + "/refs";
    let cursor = "";
    for (let page = 0; page < 10; page++) {
      const options: Record<string, string> = {filter:"heads/" + name, "$top":"100"};
      if (cursor) options.continuationToken = cursor;
      const {payload, headers} = await http(endpoint(refs, options));
      const match = values(payload).map(object).find(row => row.name === ref);
      const commit = sha(match?.objectId);
      if (commit) return commit;
      cursor = headers.get("x-ms-continuationtoken") ?? "";
      if (!cursor) throw new Error("NO_REMOTE_BRANCH");
    }
    throw new Error("GIT_OUTPUT_LIMIT");
  }
  function azureRepo(row: Record<string, unknown>) {
    const project = text(object(row.project).name);
    const name = text(row.name);
    return repoSchema.parse({
      id:text(row.id), accountId:account.id, project, name, path:project + "/" + name,
      clone:cloneUrl(account,row.remoteUrl), branch:branchName(row.defaultBranch) || null, canPush:null,
    });
  }
  return {
    async repository(path) {
      const parts = path.split("/");
      if (parts.length !== 2 || parts.some(part => !part || part === "." || part === "..")) throw new Error("INVALID_INPUT");
      const {payload} = await http(endpoint(scope + "/" + segment(parts[0]) + "/_apis/git/repositories/" + segment(parts[1])));
      const row = object(payload);
      if (row.isDisabled === true) throw new Error("NOT_FOUND");
      return azureRepo(row);
    },
    async repositories(page) {
      const {payload} = await http(endpoint(scope + "/_apis/git/repositories"));
      const start = (page - 1) * pageSize;
      const catalog = values(payload).map(object).filter(row => row.isDisabled !== true);
      const items = catalog.slice(start, start + pageSize).map(azureRepo);
      return {items, more:start + pageSize < catalog.length, observedAt:new Date().toISOString()};
    },
    async pulls(repo, page) {
      const {payload} = await http(endpoint(repoPath(repo) + "/pullRequests", {
        "searchCriteria.status":"all", "$top":String(pageSize), "$skip":String((page - 1) * pageSize),
      }));
      const rows = values(payload);
      return {items:rows.map(row => parsePull(row, repo)), more:rows.length === pageSize};
    },
    async pull(repo, number) { return (await fetchPull(repo, number)).value; },
    async details(repo, number) {
      const path = pullPath(repo, number);
      const issues = ["Azure provides changed paths. A patch requires the Git objects from a checkout."];
      const capturing = async <T>(label: string, load: () => Promise<T>, fallback: T) => {
        try { return await load(); }
        catch (error) {
          const code = error instanceof Error && /^(PROVIDER_[A-Z_]+|GIT_OUTPUT_LIMIT)$/.test(error.message)
            ? error.message : "PROVIDER_UNAVAILABLE";
          issues.push(label + ": " + code);
          return fallback;
        }
      };
      const [{value}, threads, statuses, iterations] = await Promise.all([
        fetchPull(repo, number),
        capturing("Discussions", async () => values((await http(endpoint(path + "/threads"))).payload), []),
        capturing("PR statuses", async () => values((await http(endpoint(path + "/statuses"))).payload), []),
        capturing("PR iterations", async () => values((await http(endpoint(path + "/iterations"))).payload), []),
      ]);
      const comments = threads.flatMap(thread => array(object(thread).comments)).map(object)
        .filter(comment => comment.isDeleted !== true && comment.commentType !== "system" && text(comment.content))
        .slice(0, 150).map(comment => ({author:text(object(comment.author).displayName) || "Unknown", body:text(comment.content)}));
      const iteration = Math.max(0, ...iterations.map(raw => Number(object(raw).id) || 0));
      const latest = new Map<string, {name: string; state: string; timestamp: string}>();
      for (const row of statuses.map(object)) {
        if (row.iterationId && row.iterationId !== iteration) continue;
        const context = object(row.context);
        const name = [text(context.genre), text(context.name)].filter(Boolean).join("/");
        const timestamp = text(row.updatedDate) || text(row.creationDate);
        if (name && (!latest.has(name) || latest.get(name)!.timestamp <= timestamp)) {
          latest.set(name,{name,state:text(row.state) || "unknown",timestamp});
        }
      }
      const checks = [...latest.values()].map(({name,state}) => ({name,state}));
      const changes = iteration ? await capturing("Changed paths", async () => {
        const {payload} = await http(endpoint(path + "/iterations/" + iteration + "/changes", {"$top":"200","$compareTo":"0"}));
        const result = object(payload);
        if (result.nextTop || result.nextSkip) issues.push("Showing the first page of changed paths.");
        return array(result.changeEntries).map(object).flatMap(entry => {
          const name = text(object(entry.item).path);
          return name ? [(text(entry.changeType) || "change") + " " + name] : [];
        });
      }, []) : [];
      return {pull:value, diff:null, changes, comments, checks, issues};
    },
    branch,
    async createFile(repo, change) {
      // A push whose ref update names the base commit as the old value starts the new branch there.
      const {payload} = await http(endpoint(repoPath(repo) + "/pushes"), {method:"POST", body:{
        refUpdates:[{name:refPrefix + change.branch, oldObjectId:change.base}],
        commits:[{comment:change.message, changes:[{changeType:"add", item:{path:"/" + change.path}, newContent:{content:change.content, contentType:"rawtext"}}]}],
      }});
      const made = sha(object(array(object(payload).commits)[0]).commitId);
      if (!made) throw new Error("OUTCOME_UNKNOWN");
      return made;
    },
    async mutate(repo, action) {
      if (action.kind === "create") {
        if (action.body.length > 4000) throw new Error("INVALID_INPUT");
        if (await branch(repo, action.head) !== action.expected) throw new Error("STALE_HEAD");
        const {payload} = await http(endpoint(repoPath(repo) + "/pullRequests", {supportsIterations:"true"}), {
          method:"POST",
          body:{sourceRefName:refPrefix + action.head, targetRefName:refPrefix + action.base, title:action.title, description:action.body},
        });
        const number = object(payload).pullRequestId;
        if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1) throw new Error("OUTCOME_UNKNOWN");
        return {number, outcome:"completed"};
      }
      const {raw, value} = await fetchPull(repo, action.number);
      if (raw.forkSource) throw new Error("PROVIDER_UNSUPPORTED");
      if (value.head.sha !== action.expected || !value.head.branch || await branch(repo, value.head.branch) !== action.expected) {
        throw new Error("STALE_HEAD");
      }
      const path = pullPath(repo, action.number);
      if (action.kind === "comment") {
        await http(endpoint(path + "/threads"), {
          method:"POST", body:{comments:[{parentCommentId:0, content:action.body, commentType:1}], status:1},
        });
      } else if (action.kind === "review") {
        if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(action.reviewer)) throw new Error("INVALID_INPUT");
        await http(endpoint(path + "/reviewers/" + segment(action.reviewer)), {method:"PUT", body:{id:action.reviewer}});
      } else if (action.kind === "reopen") {
        if (value.state !== "abandoned") throw new Error("PROVIDER_REJECTED");
        const {payload} = await http(endpoint(path), {method:"PATCH", body:{status:"active"}});
        if (object(payload).status !== "active") return {number:action.number, outcome:"accepted"};
      } else {
        if (value.state !== "active" || raw.isDraft === true) throw new Error("PROVIDER_REJECTED");
        const {payload} = await http(endpoint(path), {
          method:"PATCH", body:{status:"completed", lastMergeSourceCommit:{commitId:action.expected}},
        });
        if (object(payload).status !== "completed") return {number:action.number, outcome:"accepted"};
      }
      return {number:action.number, outcome:"completed"};
    },
  };
}
