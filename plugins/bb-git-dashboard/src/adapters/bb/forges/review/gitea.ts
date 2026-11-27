import type { PrAction } from "../../../../core/pulls/actions.ts";
import type { Comment, PrDetail, Reviewer, Thread, TimelineEntry } from "../../../../core/pulls/detail.ts";
import type { PrFile } from "../../../../core/pulls/diff.ts";
import type { CheckStatus } from "../../../../core/pulls/github.ts";
import type { PullReview } from "../../../../core/pulls/review-port.ts";
import type { Account } from "../../../../core/providers.ts";
import { array, client, object, segment, sha, text, type Json } from "../../provider-http.ts";
import { inBatches } from "../inbox/shared.ts";
import { ownLinks, repoParts } from "./shared.ts";

const draftPrefix = /^\s*(?:WIP:|\[WIP\])\s*/i;
const reviewState: Record<string, string> = {APPROVED: "APPROVED", REQUEST_CHANGES: "CHANGES_REQUESTED", COMMENT: "COMMENTED"};
const reviewEvent = {COMMENT: "COMMENT", APPROVE: "APPROVED", REQUEST_CHANGES: "REQUEST_CHANGES"} as const;
const statusOf = (state: string): CheckStatus => ["failure", "error"].includes(state) ? "failing" : state === "success" ? "passing" : state === "pending" ? "pending" : "skipped";
const fileStatus = (status: string) => status === "changed" ? "modified" : status === "deleted" ? "removed" : status;

function commentOf(row: Json): Comment {
  return {id: String(row.id ?? ""), canDelete: false, author: text(object(row.user).login) || "ghost", avatarUrl: null, body: text(row.body),
    createdAt: text(row.created_at), url: text(row.html_url)};
}
/** Each file's hunks from a unified diff of the whole pull request, keyed by the new path. */
function patches(diff: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const part of diff.split(/^diff --git /m).slice(1)) {
    const name = /^a\/.+? b\/(.+)$/m.exec(part)?.[1];
    const hunk = part.indexOf("\n@@");
    if (name && hunk >= 0) result.set(name, part.slice(hunk + 1).replace(/\n+$/, ""));
  }
  return result;
}

/**
 * Gitea pull requests. Review comments have no thread object: comments on the same file, line and side form one
 * thread named by its first comment, which replies and resolution address. A range is anchored on its last line.
 */
export function giteaReview(account: Account, token: string, path: string, send: typeof fetch = fetch): PullReview {
  const [owner, name] = repoParts(path);
  const http = client(account, token, send);
  const repo = "/api/v1/repos/" + segment(owner) + "/" + segment(name);
  const get = async (target: string) => (await http(repo + target)).payload;
  return {
    async detail(number) {
      const [raw, comments, reviews, commits, viewer] = await Promise.all([
        get("/pulls/" + number).then(object), get("/issues/" + number + "/comments?limit=100").then(array),
        get("/pulls/" + number + "/reviews?limit=100").then(array), get("/pulls/" + number + "/commits?limit=100").then(array),
        http("/api/v1/user").then(result => text(object(result.payload).login)),
      ]);
      const head = sha(object(raw.head).sha);
      const author = text(object(raw.user).login) || "ghost";
      const reviewRows = reviews.map(object).filter(row => row.state !== "PENDING" && row.state !== "REQUEST_REVIEW");
      const lineComments = (await inBatches(reviewRows, 4, row => get("/pulls/" + number + "/reviews/" + segment(String(row.id)) + "/comments").then(array)))
        .flat().map(object).sort((left, right) => text(left.created_at).localeCompare(text(right.created_at)));
      const threads = new Map<string, Thread>();
      for (const row of lineComments) {
        const line = Number(row.position) || Number(row.original_position) || null;
        const key = text(row.path) + "\u0000" + line;
        const thread = threads.get(key);
        const resolved = object(row.resolver).login !== undefined;
        if (thread) { thread.comments.push(commentOf(row)); thread.isResolved = thread.isResolved || resolved; continue; }
        threads.set(key, {id: String(row.id), path: text(row.path), side: "RIGHT", startLine: null, isPending: false, line, isResolved: resolved,
          isOutdated: !!head && !!sha(row.commit_id) && row.commit_id !== head, resolvedBy: resolved ? text(object(row.resolver).login) : null,
          canToggleResolved: true, diffHunk: text(row.diff_hunk) || null, comments: [commentOf(row)], awaitingReply: false});
      }
      for (const thread of threads.values()) thread.awaitingReply = !thread.isResolved && thread.comments.at(-1)?.author !== author;
      const timeline: TimelineEntry[] = [
        ...(text(raw.body).trim() ? [{id: "", canDelete: false, author, avatarUrl: null, body: text(raw.body), createdAt: text(raw.created_at), url: text(raw.html_url), reviewState: null}] : []),
        ...comments.map(object).map(row => ({...commentOf(row), reviewState: null})),
        ...reviewRows.filter(row => text(row.body).trim() || row.state !== "COMMENT").map(row => ({id: "", canDelete: false,
          author: text(object(row.user).login) || "ghost", avatarUrl: null, body: text(row.body), createdAt: text(row.submitted_at), url: text(row.html_url),
          reviewState: reviewState[text(row.state)] ?? text(row.state)})),
      ].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
      const latest = new Map<string, string>();
      for (const row of reviewRows) {
        const who = text(object(row.user).login);
        if (who && who !== author && reviewState[text(row.state)]) latest.set(who, reviewState[text(row.state)]);
      }
      const requested = array(raw.requested_reviewers).map(row => text(object(row).login)).filter(Boolean);
      const reviewers: Reviewer[] = [...requested.filter(who => !latest.has(who)).map(who => ({name: who, avatarUrl: null, team: false, state: "REQUESTED"})),
        ...[...latest].map(([who, state]) => ({name: who, avatarUrl: null, team: false, state}))];
      const states = [...latest.values()];
      const status = head ? object(await get("/commits/" + head + "/status").catch(() => ({}))) : {};
      const merged = raw.merged === true;
      const detail: PrDetail = {
        forge: "gitea", id: String(raw.id ?? ""), headSha: head, viewer, number, title: text(raw.title), url: text(raw.html_url), repo: path, author,
        authorAvatarUrl: null, state: merged ? "MERGED" : raw.state === "open" ? "OPEN" : "CLOSED",
        isDraft: raw.draft === true || draftPrefix.test(text(raw.title)), headRefName: text(object(raw.head).ref), baseRefName: text(object(raw.base).ref),
        onDefaultBranch: text(object(raw.base).ref) === text(object(object(raw.base).repo).default_branch), stackedOn: null,
        changedFiles: Number(raw.changed_files) || 0, pendingReviewId: null, additions: Number(raw.additions) || 0, deletions: Number(raw.deletions) || 0,
        reviewDecision: states.includes("CHANGES_REQUESTED") ? "CHANGES_REQUESTED" : states.includes("APPROVED") ? "APPROVED" : requested.length ? "REVIEW_REQUIRED" : null,
        conflicts: raw.mergeable === false && !merged && raw.state === "open", timeline,
        threads: [...threads.values()].sort((left, right) => Number(left.isResolved) - Number(right.isResolved)),
        checks: array(status.statuses).map(object).map(row => ({name: text(row.context) || "status", workflow: null, status: statusOf(text(row.status)),
          conclusion: text(row.status) || null, url: text(row.target_url) || null, title: text(row.description) || null, summary: null, annotations: []})),
        reviewers, labels: array(raw.labels).map(object).map(row => ({name: text(row.name), color: /^[0-9a-f]{6}$/i.test(text(row.color)) ? text(row.color) : null})),
        body: text(raw.body), canEdit: true,
        commits: commits.map(object).map(row => ({oid: text(row.sha), shortOid: text(row.sha).slice(0, 7), headline: text(object(row.commit).message).split("\n")[0],
          author: text(object(object(row.commit).author).name) || "unknown", avatarUrl: null, committedDate: text(object(object(row.commit).author).date), ci: null})).reverse(),
        commitCount: commits.length, myReviewOid: null,
      };
      return ownLinks(account, detail);
    },
    async files(number) {
      const [rows, diff] = await Promise.all([get("/pulls/" + number + "/files?limit=1000").then(array),
        http(repo + "/pulls/" + number + ".diff", {raw: true, accept: "text/plain", maxBytes: 8 * 1024 * 1024}).then(result => text(result.payload))]);
      const hunks = patches(diff);
      return rows.map(object).map((row): PrFile => ({path: text(row.filename), previousPath: text(row.previous_filename) || null, status: fileStatus(text(row.status)),
        additions: Number(row.additions) || 0, deletions: Number(row.deletions) || 0, patch: hunks.get(text(row.filename)) ?? null}));
    },
    async act(number, action: PrAction, current) {
      const pull = "/pulls/" + number;
      const write = (method: "POST" | "PATCH", target: string, body?: unknown) => http(repo + target, {method, ...(body === undefined ? {} : {body})});
      const anchor = (value: {path: string; line: number; side: "LEFT" | "RIGHT"; body: string}) =>
        ({path: value.path, body: value.body, ...(value.side === "RIGHT" ? {new_position: value.line, old_position: 0} : {old_position: value.line, new_position: 0})});
      switch (action.kind) {
        case "comment": await write("POST", "/issues/" + number + "/comments", {body: action.body}); break;
        case "reply": await write("POST", pull + "/comments/" + segment(action.threadId) + "/replies", {body: action.body}); break;
        case "resolve": await write("POST", "/pulls/comments/" + segment(action.threadId) + (action.resolved ? "/resolve" : "/unresolve")); break;
        case "lineComment": await write("POST", pull + "/reviews", {event: "COMMENT", body: "", commit_id: current.headSha, comments: [anchor(action)]}); break;
        case "review": await write("POST", pull + "/reviews", {event: reviewEvent[action.event], body: action.body, commit_id: current.headSha, comments: action.comments.map(anchor)}); break;
        case "requestReviewer": await write("POST", pull + "/requested_reviewers", {reviewers: [action.reviewer]}); break;
        case "editTitle": await write("PATCH", pull, {title: current.isDraft ? "WIP: " + action.title.replace(draftPrefix, "") : action.title}); break;
        case "editBody": await write("PATCH", pull, {body: action.body}); break;
        // Gitea marks a draft by the title's WIP: prefix.
        case "draft": await write("PATCH", pull, {title: action.draft ? "WIP: " + current.title.replace(draftPrefix, "") : current.title.replace(draftPrefix, "")}); break;
        case "state": await write("PATCH", pull, {state: action.open ? "open" : "closed"}); break;
        case "merge": await write("POST", pull + "/merge", {Do: action.method, head_commit_id: current.headSha}); break;
      }
      return {outcome: "completed"};
    },
  };
}
