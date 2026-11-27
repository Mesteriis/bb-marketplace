import { blockersOf, linkStacks, type Pr } from "../../../../core/pulls/model.ts";
import type { InboxTab, PullInbox } from "../../../../core/pulls/inbox.ts";
import type { Account } from "../../../../core/providers.ts";
import { array, client, object, segment, text, type Json } from "../../provider-http.ts";
import { inBatches } from "./shared.ts";

const maxProjects = 30;
const version = "7.1";
const branch = (ref: unknown) => text(ref).replace(/^refs\/heads\//, "");
/** Reviewer votes: 10 approved, 5 approved with suggestions, 0 none, -5 waiting for author, -10 rejected. */
const voteState: Record<number, string> = {10: "APPROVED", 5: "APPROVED_WITH_SUGGESTIONS", [-5]: "WAITING_FOR_AUTHOR", [-10]: "REJECTED"};

function toPr(account: Account, row: Json, me: string): Pr | null {
  const repository = object(row.repository);
  const project = text(object(repository.project).name), name = text(repository.name);
  if (!project || !name || !Number.isSafeInteger(row.pullRequestId)) return null;
  const reviewers = array(row.reviewers).map(object);
  const votes = reviewers.map(reviewer => Number(reviewer.vote) || 0);
  const mine = reviewers.find(reviewer => reviewer.id === me);
  const status = text(row.status), closed = text(row.closedDate) || null;
  const pr: Pr = {
    id: "azure:" + project + "/" + String(row.pullRequestId), number: row.pullRequestId as number, title: text(row.title),
    url: "https://dev.azure.com/" + [account.organization, project, "_git", name].map(segment).join("/") + "/pullrequest/" + String(row.pullRequestId),
    repo: project + "/" + name, author: text(object(row.createdBy).displayName) || "Unknown",
    baseRefName: branch(row.targetRefName), headRefName: branch(row.sourceRefName), onDefaultBranch: false, stackedOn: null,
    isDraft: row.isDraft === true, createdAt: text(row.creationDate), updatedAt: closed ?? text(row.creationDate),
    mergedAt: status === "completed" ? closed : null, closedAt: status === "abandoned" ? closed : null,
    additions: null, deletions: null, ci: "none", failingChecks: [], unresolvedThreads: 0,
    notes: votes.includes(-5) && !votes.includes(-10) ? ["Waiting for author"] : [],
    reviewDecision: votes.includes(-10) ? "CHANGES_REQUESTED"
      : reviewers.some(reviewer => reviewer.isRequired === true && (Number(reviewer.vote) || 0) < 5) ? "REVIEW_REQUIRED" : null,
    conflicts: row.mergeStatus === "conflicts", blockers: [],
    myReview: mine && voteState[Number(mine.vote)] ? {state: voteState[Number(mine.vote)], stale: false} : null,
  };
  return {...pr, blockers: blockersOf(pr)};
}

/**
 * The inbox of an Azure DevOps account: pull requests are listed per project, so the organization's projects are
 * read first. Build policies are not read, so there is no CI state and no watcher.
 */
export function azureInbox(account: Account, token: string, send: typeof fetch = fetch): PullInbox {
  const http = client(account, token, send);
  const org = "/" + segment(account.organization);
  const get = async (path: string, query: Record<string, string> = {}) =>
    object((await http(path + "?" + new URLSearchParams({...query, "api-version": version}))).payload);
  return {
    async list(tab) {
      if (tab === "assigned") return {items: [], counts: {}, notice: "Azure DevOps pull requests have reviewers, not assignees."};
      const me = text(object((await get(org + "/_apis/connectionData")).authenticatedUser).id);
      if (!me) throw new Error("PROVIDER_DENIED");
      const projects = array((await get(org + "/_apis/projects", {"$top": String(maxProjects + 1)})).value).map(row => text(object(row).name)).filter(Boolean);
      const reviewing = tab === "review" || tab === "reviewed";
      const criteria: Record<string, string> = {
        [reviewing ? "searchCriteria.reviewerId" : "searchCriteria.creatorId"]: me,
        "searchCriteria.status": tab === "merged" ? "completed" : tab === "closed" ? "abandoned" : "active",
        "$top": tab === "merged" || tab === "closed" ? "30" : "50",
      };
      const top = Number(criteria["$top"]);
      const lists = await inBatches(projects.slice(0, maxProjects), 4, project => get(org + "/" + segment(project) + "/_apis/git/pullrequests", criteria));
      let items = lists.flatMap(list => array(list.value).map(object).flatMap(row => toPr(account, row, me) ?? []));
      // My vote is 0 until I review; any other vote means I already did.
      if (reviewing) items = items.filter(pr => (tab === "reviewed") === (pr.myReview !== null));
      items.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
      // A project that filled its page, or projects left unread, make the length a lower bound, not a total.
      const complete = projects.length <= maxProjects && lists.every(list => array(list.value).length < top);
      const notes = [projects.length > maxProjects ? "Only the first " + maxProjects + " projects of " + account.organization + " are read." : "",
        "Azure build policies are not read, so these pull requests show no CI state."].filter(Boolean);
      return {items: linkStacks(items), counts: complete ? {[tab]: items.length} : {}, notice: notes.join(" ")};
    },
    watch: async () => null,
  };
}
