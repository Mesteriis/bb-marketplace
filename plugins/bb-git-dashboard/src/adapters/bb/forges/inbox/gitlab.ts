import { blockersOf, linkStacks, type Pr } from "../../../../core/pulls/model.ts";
import type { InboxTab, PullInbox } from "../../../../core/pulls/inbox.ts";
import { inboxTabs } from "../../../../core/pulls/inbox.ts";
import type { Account } from "../../../../core/providers.ts";
import { array, client, object, segment, text, type Json } from "../../provider-http.ts";
import { headerCount, inBatches, ownLink } from "./shared.ts";

const api = "/api/v4/merge_requests";
/** GitLab has no "reviewed by me" filter: Reviewed lists what you approved. */
const query = (tab: InboxTab, me: string): Record<string, string> => ({
  open: {scope: "created_by_me", state: "opened"}, review: {scope: "reviews_for_me", state: "opened"},
  reviewed: {scope: "all", state: "opened", "approved_by_usernames[]": me}, assigned: {scope: "assigned_to_me", state: "opened"},
  merged: {scope: "created_by_me", state: "merged"}, closed: {scope: "created_by_me", state: "closed"},
})[tab];
/** `detailed_merge_status` values without a common blocker. */
const notes: Record<string, string> = {
  need_rebase: "Needs rebase", ci_must_pass: "CI must pass", discussions_not_resolved: "Unresolved discussions",
  merge_request_blocked: "Blocked by another merge request", jira_association_missing: "Jira issue missing",
  status_checks_must_pass: "Status checks must pass", security_policy_pipeline_check: "Security policy",
  security_policy_violations: "Security policy", locked_paths: "Locked files", locked_lfs_files: "Locked files",
  title_regex: "Title does not match the rules", merge_time: "Merge not allowed yet", commits_status: "Source branch has no commits",
};

function toPr(account: Account, row: Json): Pr | null {
  const url = ownLink(account, row.web_url);
  const reference = text(object(row.references).full);
  const repo = reference.includes("!") ? reference.slice(0, reference.lastIndexOf("!")) : "";
  if (!url || !repo || !Number.isSafeInteger(row.iid)) return null;
  const status = text(row.detailed_merge_status);
  const pr: Pr = {
    id: "gitlab:" + String(row.id), number: row.iid as number, title: text(row.title), url, repo,
    author: text(object(row.author).username) || "ghost", baseRefName: text(row.target_branch), headRefName: text(row.source_branch),
    // The list does not name the project's default branch; stacks come from linkStacks.
    onDefaultBranch: false, stackedOn: null, isDraft: row.draft === true, createdAt: text(row.created_at), updatedAt: text(row.updated_at),
    mergedAt: text(row.merged_at) || null, closedAt: row.state === "merged" ? null : text(row.closed_at) || null,
    additions: null, deletions: null, ci: status === "ci_still_running" ? "pending" : "none", failingChecks: [], unresolvedThreads: 0,
    notes: notes[status] ? [notes[status]] : [],
    reviewDecision: status === "requested_changes" ? "CHANGES_REQUESTED" : status === "not_approved" ? "REVIEW_REQUIRED" : null,
    conflicts: row.has_conflicts === true || status === "conflict", blockers: [], myReview: null,
  };
  return {...pr, blockers: blockersOf(pr)};
}

/** The inbox of a GitLab account through the global merge request list. */
export function gitlabInbox(account: Account, token: string, send: typeof fetch = fetch): PullInbox {
  const http = client(account, token, send);
  const read = (tab: InboxTab, size: number) =>
    http(api + "?" + new URLSearchParams({...query(tab, account.username), order_by: "updated_at", per_page: String(size)}));
  const rows = (payload: unknown) => array(payload).map(object).flatMap(row => toPr(account, row) ?? []);
  return {
    async list(tab) {
      const [own, ...others] = await Promise.all([read(tab, tab === "merged" || tab === "closed" ? 30 : 50),
        ...inboxTabs.filter(name => name !== tab).map(name => read(name, 1).then(result => [name, result.headers] as const))]);
      const counts: Partial<Record<InboxTab, number>> = {};
      for (const [name, headers] of [[tab, own.headers] as const, ...others]) {
        const count = headerCount(headers, "x-total");
        if (count !== undefined) counts[name] = count;
      }
      return {items: linkStacks(rows(own.payload)), counts, notice: null};
    },
    async watch() {
      const open = array((await read("open", 50)).payload).map(object);
      const prs = await inBatches(open, 4, async row => {
        const pr = toPr(account, row);
        if (!pr) return null;
        const detail = object((await http("/api/v4/projects/" + segment(String(row.project_id)) + "/merge_requests/" + String(row.iid))).payload);
        const pipeline = object(detail.head_pipeline);
        return {id: pr.id, repo: pr.repo, number: pr.number, title: pr.title, url: pr.url,
          failing: pipeline.status === "failed" ? ["Pipeline #" + String(pipeline.id)] : [], lastComment: null};
      });
      return {viewer: account.username, prs: prs.flatMap(item => item ?? [])};
    },
  };
}
