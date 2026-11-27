import { partial } from "../../../../core/partial.ts";
import type { PrAction } from "../../../../core/pulls/actions.ts";
import type { Comment, PrDetail, Reviewer, Thread, TimelineEntry } from "../../../../core/pulls/detail.ts";
import type { PrFile } from "../../../../core/pulls/diff.ts";
import type { CheckStatus } from "../../../../core/pulls/github.ts";
import type { PullReview } from "../../../../core/pulls/review-port.ts";
import type { Account } from "../../../../core/providers.ts";
import { array, client, object, segment, sha, text, type Json } from "../../provider-http.ts";
import { inOrder, ownLinks, repoParts } from "./shared.ts";

const version = "7.1";
const resolvedStatuses = new Set(["fixed", "wontFix", "closed", "byDesign"]);
const voteState: Record<number, string> = {10: "APPROVED", 5: "APPROVED_WITH_SUGGESTIONS", [-5]: "WAITING_FOR_AUTHOR", [-10]: "REJECTED"};
const strategy = {merge: "noFastForward", squash: "squash", rebase: "rebase"} as const;
const branch = (ref: unknown) => text(ref).replace(/^refs\/heads\//, "");
const relative = (value: unknown) => text(value).replace(/^\/+/, "");
const statusOf = (state: string): CheckStatus => state === "succeeded" ? "passing" : ["failed", "error"].includes(state) ? "failing" : state === "pending" ? "pending" : "skipped";
const changeStatus = (type: string) => type.includes("rename") ? "renamed" : type.includes("add") ? "added" : type.includes("delete") ? "removed" : "modified";

function commentOf(row: Json): Comment {
  return {id: String(row.id ?? ""), canDelete: false, author: text(object(row.author).displayName) || "Unknown", avatarUrl: null, body: text(row.content),
    createdAt: text(row.publishedDate), url: ""};
}

/**
 * Azure Repos pull requests: threads with their status, reviewer votes, statuses and the latest iteration's changed
 * files. Azure returns no line diff, so line comments and patches are not offered; completing a pull request is
 * asynchronous, so a merge is accepted rather than finished.
 */
export function azureReview(account: Account, token: string, path: string, send: typeof fetch = fetch): PullReview {
  const [project, name] = repoParts(path);
  const http = client(account, token, send);
  const org = "/" + segment(account.organization);
  const base = (number: number) => org + "/" + segment(project) + "/_apis/git/repositories/" + segment(name) + "/pullrequests/" + number;
  const url = (target: string) => target + "?api-version=" + version;
  const get = async (target: string) => object((await http(url(target))).payload);
  const me = async () => object((await get(org + "/_apis/connectionData")).authenticatedUser);
  return {
    async detail(number) {
      // Only the pull request itself is required; each other part degrades to a notice on its own.
      const [raw, ...parts] = await Promise.all([get(base(number)),
        partial(get(base(number) + "/threads"), {} as Json, code => "Threads could not be read (" + code + ")."),
        partial(get(base(number) + "/statuses"), {} as Json, code => "Statuses could not be read (" + code + ")."),
        partial(get(base(number) + "/commits"), {} as Json, code => "Commits could not be read (" + code + ")."),
        partial(me(), {} as Json, code => "Your Azure DevOps identity could not be read (" + code + "); the forge may refuse some review choices."),
      ] as const);
      const [{value: threads}, {value: statuses}, {value: commits}, {value: viewer}] = parts;
      const notices = parts.flatMap(part => part.notice ? [part.notice] : []);
      const author = text(object(raw.createdBy).displayName) || "Unknown";
      const lineThreads: Thread[] = [];
      const timeline: TimelineEntry[] = text(raw.description).trim()
        ? [{id: "", canDelete: false, author, avatarUrl: null, body: text(raw.description), createdAt: text(raw.creationDate), url: "", reviewState: null}] : [];
      for (const thread of array(threads.value).map(object)) {
        if (thread.isDeleted === true) continue;
        const comments = array(thread.comments).map(object).filter(row => row.commentType !== "system" && row.isDeleted !== true).map(commentOf);
        if (!comments.length) continue;
        const context = object(thread.threadContext);
        const file = relative(context.filePath);
        if (!file) { timeline.push(...comments.map(comment => ({...comment, reviewState: null}))); continue; }
        const right = context.rightFileStart !== undefined && context.rightFileStart !== null;
        const start = Number(object(right ? context.rightFileStart : context.leftFileStart).line) || null;
        const end = Number(object(right ? context.rightFileEnd : context.leftFileEnd).line) || start;
        const resolved = resolvedStatuses.has(text(thread.status));
        lineThreads.push({id: String(thread.id), path: file, side: right ? "RIGHT" : "LEFT", startLine: start !== end ? start : null, isPending: false,
          line: end, isResolved: resolved, isOutdated: false, resolvedBy: null, canToggleResolved: true, diffHunk: null, comments,
          awaitingReply: !resolved && comments.at(-1)?.author !== author});
      }
      timeline.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
      const reviewers: Reviewer[] = array(raw.reviewers).map(object).map(row => ({name: text(row.displayName) || "Unknown", avatarUrl: null,
        team: row.isContainer === true, state: voteState[Number(row.vote)] ?? "REQUESTED"}));
      const votes = array(raw.reviewers).map(row => Number(object(row).vote) || 0);
      const status = text(raw.status);
      const detail: PrDetail = {
        forge: "azure", id: String(raw.pullRequestId ?? number), headSha: sha(object(raw.lastMergeSourceCommit).commitId), viewer: text(viewer.providerDisplayName) || text(viewer.id), notices,
        number, title: text(raw.title), url: "https://dev.azure.com" + org + "/" + segment(project) + "/_git/" + segment(name) + "/pullrequest/" + number,
        repo: path, author, authorAvatarUrl: null, state: status === "active" ? "OPEN" : status === "completed" ? "MERGED" : "CLOSED", isDraft: raw.isDraft === true,
        headRefName: branch(raw.sourceRefName), baseRefName: branch(raw.targetRefName), onDefaultBranch: false, stackedOn: null, changedFiles: 0,
        pendingReviewId: null, additions: 0, deletions: 0,
        reviewDecision: votes.includes(-10) ? "CHANGES_REQUESTED" : votes.some(vote => vote >= 5) ? "APPROVED"
          : array(raw.reviewers).some(row => object(row).isRequired === true) ? "REVIEW_REQUIRED" : null,
        conflicts: raw.mergeStatus === "conflicts", timeline, threads: lineThreads.sort((left, right) => Number(left.isResolved) - Number(right.isResolved)),
        checks: array(statuses.value).map(object).map(row => ({name: text(object(row.context).name) || "status", workflow: text(object(row.context).genre) || null,
          status: statusOf(text(row.state)), conclusion: text(row.state) || null, url: text(row.targetUrl) || null, title: text(row.description) || null, summary: null, annotations: []})),
        reviewers, labels: array(raw.labels).map(row => ({name: text(object(row).name), color: null})), body: text(raw.description), canEdit: true,
        commits: array(commits.value).map(object).map(row => ({oid: text(row.commitId), shortOid: text(row.commitId).slice(0, 8), headline: text(row.comment).split("\n")[0],
          author: text(object(row.author).name) || "unknown", avatarUrl: null, committedDate: text(object(row.author).date), ci: null})),
        commitCount: array(commits.value).length, myReviewOid: null, fromFork: raw.forkSource !== undefined && raw.forkSource !== null,
      };
      return ownLinks(account, detail);
    },
    async files(number) {
      const iterations = array((await get(base(number) + "/iterations")).value).map(row => Number(object(row).id)).filter(Number.isSafeInteger);
      if (!iterations.length) return [];
      const changes = await get(base(number) + "/iterations/" + Math.max(...iterations) + "/changes");
      return array(changes.changeEntries).map(object).map((row): PrFile => ({path: relative(object(row.item).path),
        previousPath: relative(row.originalPath) || null, status: changeStatus(text(row.changeType)), additions: 0, deletions: 0, patch: null}))
        .filter(file => file.path);
    },
    async act(number, action: PrAction, current) {
      const pr = base(number);
      const write = (method: "POST" | "PATCH" | "PUT", target: string, body: unknown) => http(url(target), {method, body});
      const vote = async (value: number) => write("PUT", pr + "/reviewers/" + segment(text((await me()).id)), {vote: value});
      switch (action.kind) {
        case "comment": await write("POST", pr + "/threads", {comments: [{parentCommentId: 0, content: action.body, commentType: 1}], status: "active"}); break;
        case "reply": await write("POST", pr + "/threads/" + segment(action.threadId) + "/comments", {parentCommentId: 1, content: action.body, commentType: 1}); break;
        case "resolve": await write("PATCH", pr + "/threads/" + segment(action.threadId), {status: action.resolved ? "fixed" : "active"}); break;
        case "lineComment": case "draft": throw new Error("PROVIDER_UNSUPPORTED");
        case "review":
          if (action.comments.length) throw new Error("PROVIDER_UNSUPPORTED");
          await inOrder([
            ...(action.body.trim() ? [() => write("POST", pr + "/threads", {comments: [{parentCommentId: 0, content: action.body, commentType: 1}], status: "active"})] : []),
            ...(action.event !== "COMMENT" ? [() => vote(action.event === "APPROVE" ? 10 : -10)] : []),
          ]);
          break;
        case "requestReviewer": await write("PUT", pr + "/reviewers/" + segment(action.reviewer), {vote: 0}); break;
        case "editTitle": await write("PATCH", pr, {title: action.title}); break;
        case "editBody":
          // Azure keeps at most 4000 characters of a description; a longer one is refused rather than cut.
          if (action.body.length > 4000) throw new Error("INVALID_INPUT");
          await write("PATCH", pr, {description: action.body});
          break;
        case "state": await write("PATCH", pr, {status: action.open ? "active" : "abandoned"}); break;
        case "merge":
          await write("PATCH", pr, {status: "completed", lastMergeSourceCommit: {commitId: current.headSha}, completionOptions: {mergeStrategy: strategy[action.method]}});
          return {outcome: "accepted"};
      }
      return {outcome: "completed"};
    },
  };
}
