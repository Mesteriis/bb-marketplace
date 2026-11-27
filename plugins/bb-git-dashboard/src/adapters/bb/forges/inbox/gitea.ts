import { blockersOf, linkStacks, type CiState, type FailingCheck, type Pr } from "../../../../core/pulls/model.ts";
import type { InboxTab, PullInbox } from "../../../../core/pulls/inbox.ts";
import type { Account } from "../../../../core/providers.ts";
import { array, client, object, segment, sha, text, type Json } from "../../provider-http.ts";
import { headerCount, inBatches, ownLink } from "./shared.ts";

const search = "/api/v1/repos/issues/search";
const flags: Record<InboxTab, [string, "open" | "closed"]> = {
  open: ["created", "open"], review: ["review_requested", "open"], reviewed: ["reviewed", "open"], assigned: ["assigned", "open"],
  merged: ["created", "closed"], closed: ["created", "closed"],
};
const draftTitle = /^\s*(?:WIP:|\[WIP\]|Draft:)/i;
const failed = new Set(["failure", "error"]);
const repoPath = (repo: string) => "/api/v1/repos/" + repo.split("/").map(segment).join("/");

function toPr(account: Account, row: Json): Pr | null {
  const url = ownLink(account, row.html_url);
  const repo = text(object(row.repository).full_name);
  const meta = object(row.pull_request);
  if (!url || repo.split("/").length !== 2 || !Number.isSafeInteger(row.number)) return null;
  const merged = meta.merged === true;
  return {
    id: "gitea:" + String(row.id), number: row.number as number, title: text(row.title), url, repo,
    author: text(object(row.user).login) || "ghost", baseRefName: "", headRefName: "", onDefaultBranch: true, stackedOn: null,
    isDraft: meta.draft === true || draftTitle.test(text(row.title)), createdAt: text(row.created_at), updatedAt: text(row.updated_at),
    mergedAt: merged ? text(meta.merged_at) || text(row.closed_at) || null : null, closedAt: merged ? null : text(row.closed_at) || null,
    additions: null, deletions: null, ci: "none", failingChecks: [], unresolvedThreads: 0, notes: [], reviewDecision: null,
    conflicts: false, blockers: [], myReview: null,
  };
}

/** The inbox of a Gitea account through the cross-repository issue search. */
export function giteaInbox(account: Account, token: string, send: typeof fetch = fetch): PullInbox {
  const http = client(account, token, send);
  const read = (tab: InboxTab, limit: number) => {
    const [flag, state] = flags[tab];
    return http(search + "?" + new URLSearchParams({type: "pulls", state, [flag]: "true", limit: String(limit), page: "1"}));
  };
  /** Branches, conflicts and the head's combined status: the search result has none of them. */
  async function detail(pr: Pr) {
    const pull = object((await http(repoPath(pr.repo) + "/pulls/" + pr.number)).payload);
    const head = object(pull.head), base = object(pull.base);
    const headSha = sha(head.sha);
    const status = headSha ? object((await http(repoPath(pr.repo) + "/commits/" + headSha + "/status")).payload) : {};
    const statuses = array(status.statuses).map(object);
    const failingChecks: FailingCheck[] = statuses.filter(item => failed.has(text(item.status)))
      .map(item => ({name: text(item.context) || "status", workflow: null, url: ownLink(account, item.target_url)}));
    const state = text(status.state);
    const ci: CiState = failingChecks.length || failed.has(state) ? "failing" : state === "pending" ? "pending" : state === "success" ? "passing" : "none";
    const next: Pr = {...pr, baseRefName: text(base.ref), headRefName: text(head.ref),
      onDefaultBranch: !text(base.ref) || text(base.ref) === text(object(base.repo).default_branch),
      additions: Number.isSafeInteger(pull.additions) ? pull.additions as number : null,
      deletions: Number.isSafeInteger(pull.deletions) ? pull.deletions as number : null,
      conflicts: pull.mergeable === false, ci, failingChecks};
    return {...next, blockers: blockersOf(next)};
  }
  const rows = (payload: unknown) => array(payload).map(object).flatMap(row => toPr(account, row) ?? []);
  return {
    async list(tab) {
      const closedTab = tab === "merged" || tab === "closed";
      const counted: InboxTab[] = ["open", "review", "reviewed", "assigned"];
      const [own, ...others] = await Promise.all([read(tab, closedTab ? 30 : 50),
        ...counted.filter(name => name !== tab).map(name => read(name, 1).then(result => [name, result.headers] as const))]);
      const counts: Partial<Record<InboxTab, number>> = {};
      for (const [name, headers] of closedTab ? others : [[tab, own.headers] as const, ...others]) {
        const count = headerCount(headers, "x-total-count");
        if (count !== undefined) counts[name] = count;
      }
      let items = rows(own.payload);
      if (closedTab) return {items: items.filter(pr => (tab === "merged") === (pr.mergedAt !== null)), counts, notice: null};
      items = await inBatches(items, 4, detail);
      return {items: linkStacks(items), counts, notice: null};
    },
    async watch() {
      const open = await inBatches(rows((await read("open", 50)).payload), 4, detail);
      return {viewer: account.username, prs: open.map(pr => ({id: pr.id, repo: pr.repo, number: pr.number, title: pr.title, url: pr.url,
        failing: pr.failingChecks.map(check => check.name), lastComment: null}))};
    },
  };
}
