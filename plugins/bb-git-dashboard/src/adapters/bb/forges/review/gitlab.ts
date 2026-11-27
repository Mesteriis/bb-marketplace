import type { PrAction } from "../../../../core/pulls/actions.ts";
import type { Comment, PrDetail, Reviewer, Thread, TimelineEntry } from "../../../../core/pulls/detail.ts";
import type { PrFile } from "../../../../core/pulls/diff.ts";
import type { CheckStatus } from "../../../../core/pulls/github.ts";
import type { PullReview } from "../../../../core/pulls/review-port.ts";
import type { Account } from "../../../../core/providers.ts";
import { array, client, object, segment, sha, text, type Json } from "../../provider-http.ts";
import { gitlabProject } from "../gitlab-provider.ts";
import { ownLinks, repoParts } from "./shared.ts";

const maxPages = 20;
const draftPrefix = /^\s*(?:\[Draft\]|\(Draft\)|Draft:)\s*/i;
const pipelineStatus = (status: string): CheckStatus =>
  status === "failed" ? "failing" : status === "success" ? "passing" : ["skipped", "canceled", "manual"].includes(status) ? "skipped" : "pending";

function note(row: Json): Comment {
  return {id: String(row.id ?? ""), canDelete: false, author: text(object(row.author).username) || "ghost", avatarUrl: null, body: text(row.body),
    createdAt: text(row.created_at), url: ""};
}
function countLines(diff: string) {
  let additions = 0, deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions++;
    else if (line.startsWith("-") && !line.startsWith("---")) deletions++;
  }
  return {additions, deletions};
}

/**
 * GitLab merge requests: detail from the merge request, its discussions, approvals and commits; line comments as
 * diff discussions anchored with the merge request's diff refs. A range is anchored on its last line.
 */
export function gitlabReview(account: Account, token: string, path: string, send: typeof fetch = fetch): PullReview {
  repoParts(path, true);
  const http = client(account, token, send);
  const mr = (number: number) => gitlabProject(path) + "/merge_requests/" + number;
  async function pages(target: string) {
    const rows: Json[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const {payload, headers} = await http(target + (target.includes("?") ? "&" : "?") + "per_page=100&page=" + page);
      rows.push(...array(payload).map(object));
      if (!headers.get("x-next-page")) break;
    }
    return rows;
  }
  return {
    async detail(number) {
      const [raw, discussions, approvals, commits, viewer] = await Promise.all([
        http(mr(number)).then(result => object(result.payload)), pages(mr(number) + "/discussions"),
        http(mr(number) + "/approvals").then(result => object(result.payload)).catch(() => ({} as Json)),
        pages(mr(number) + "/commits"), http("/api/v4/user").then(result => text(object(result.payload).username)),
      ]);
      const refs = object(raw.diff_refs);
      const head = sha(raw.sha) ?? sha(refs.head_sha);
      const author = text(object(raw.author).username) || "ghost";
      const threads: Thread[] = [];
      const timeline: TimelineEntry[] = text(raw.description).trim()
        ? [{id: "", canDelete: false, author, avatarUrl: null, body: text(raw.description), createdAt: text(raw.created_at), url: "", reviewState: null}] : [];
      for (const discussion of discussions) {
        const notes = array(discussion.notes).map(object).filter(row => row.system !== true);
        if (!notes.length) continue;
        const first = notes[0], position = object(first.position);
        if (first.type !== "DiffNote" || !text(position.new_path || position.old_path)) {
          timeline.push(...notes.map(row => ({...note(row), reviewState: null})));
          continue;
        }
        const right = position.new_line !== null && position.new_line !== undefined;
        const range = object(object(position.line_range).start);
        const startLine = Number(right ? range.new_line : range.old_line) || null;
        const line = Number(right ? position.new_line : position.old_line) || null;
        const comments = notes.map(note);
        const resolved = notes.every(row => row.resolvable !== true || row.resolved === true);
        threads.push({id: text(discussion.id), path: text(position.new_path) || text(position.old_path), side: right ? "RIGHT" : "LEFT",
          startLine: startLine !== line ? startLine : null, isPending: false, line, isResolved: resolved,
          isOutdated: !!head && !!sha(position.head_sha) && position.head_sha !== head, resolvedBy: null,
          canToggleResolved: first.resolvable === true, diffHunk: null, comments, awaitingReply: !resolved && comments.at(-1)?.author !== author});
      }
      timeline.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
      const approvedBy = array(approvals.approved_by).map(row => text(object(object(row).user).username)).filter(Boolean);
      const requested: Reviewer[] = array(raw.reviewers).map(row => text(object(row).username)).filter(name => name && !approvedBy.includes(name))
        .map(name => ({name, avatarUrl: null, team: false, state: "REQUESTED"}));
      const pipeline = object(raw.head_pipeline);
      const status = text(raw.detailed_merge_status);
      const detail: PrDetail = {
        forge: "gitlab", id: String(raw.id ?? ""), headSha: head, viewer, number, title: text(raw.title), url: text(raw.web_url), repo: path, author,
        authorAvatarUrl: null, state: raw.state === "opened" ? "OPEN" : raw.state === "merged" ? "MERGED" : "CLOSED", isDraft: raw.draft === true,
        headRefName: text(raw.source_branch), baseRefName: text(raw.target_branch), onDefaultBranch: false, stackedOn: null, changedFiles: 0,
        pendingReviewId: null, additions: 0, deletions: 0,
        reviewDecision: status === "requested_changes" ? "CHANGES_REQUESTED" : status === "not_approved" ? "REVIEW_REQUIRED" : approvedBy.length ? "APPROVED" : null,
        conflicts: raw.has_conflicts === true || status === "conflict", timeline,
        threads: threads.sort((left, right) => Number(left.isResolved) - Number(right.isResolved)),
        checks: pipeline.id === undefined ? [] : [{name: "Pipeline #" + String(pipeline.id), workflow: null, status: pipelineStatus(text(pipeline.status)),
          conclusion: text(pipeline.status) || null, url: text(pipeline.web_url) || null, title: null, summary: null, annotations: []}],
        reviewers: [...requested, ...approvedBy.filter(name => name !== author).map(name => ({name, avatarUrl: null, team: false, state: "APPROVED"}))],
        labels: array(raw.labels).map(label => ({name: typeof label === "string" ? label : text(object(label).name), color: null})),
        body: text(raw.description), canEdit: true,
        commits: commits.map(row => ({oid: text(row.id), shortOid: text(row.short_id), headline: text(row.title), author: text(row.author_name) || "unknown",
          avatarUrl: null, committedDate: text(row.committed_date), ci: null})),
        commitCount: commits.length, myReviewOid: null,
        diffRefs: sha(refs.base_sha) && sha(refs.start_sha) && head ? {base: refs.base_sha as string, head, start: refs.start_sha as string} : null,
      };
      return ownLinks(account, detail);
    },
    async files(number) {
      return (await pages(mr(number) + "/diffs")).map((row): PrFile => {
        const diff = text(row.diff);
        const patch = row.too_large === true || row.collapsed === true || !diff ? null : diff;
        return {path: text(row.new_path), previousPath: row.renamed_file === true ? text(row.old_path) : null,
          status: row.new_file === true ? "added" : row.deleted_file === true ? "removed" : row.renamed_file === true ? "renamed" : "modified",
          ...(patch ? countLines(patch) : {additions: 0, deletions: 0}), patch};
      });
    },
    async act(number, action: PrAction, current) {
      const target = mr(number);
      const position = (value: {path: string; line: number; side: "LEFT" | "RIGHT"; contextLine?: number | null}) => {
        const refs = current.diffRefs;
        if (!refs) throw new Error("STALE_HEAD");
        const lines = value.contextLine ? (value.side === "RIGHT" ? {new_line: value.line, old_line: value.contextLine} : {old_line: value.line, new_line: value.contextLine})
          : value.side === "RIGHT" ? {new_line: value.line} : {old_line: value.line};
        return {position_type: "text", base_sha: refs.base, start_sha: refs.start, head_sha: refs.head, new_path: value.path, old_path: value.path, ...lines};
      };
      switch (action.kind) {
        case "comment": await http(target + "/notes", {method: "POST", body: {body: action.body}}); break;
        case "reply": await http(target + "/discussions/" + segment(action.threadId) + "/notes", {method: "POST", body: {body: action.body}}); break;
        case "resolve": await http(target + "/discussions/" + segment(action.threadId), {method: "PUT", body: {resolved: action.resolved}}); break;
        case "lineComment": await http(target + "/discussions", {method: "POST", body: {body: action.body, position: position(action)}}); break;
        case "review":
          if (action.event === "REQUEST_CHANGES") throw new Error("PROVIDER_UNSUPPORTED");
          for (const comment of action.comments) await http(target + "/discussions", {method: "POST", body: {body: comment.body, position: position(comment)}});
          if (action.body.trim()) await http(target + "/notes", {method: "POST", body: {body: action.body}});
          if (action.event === "APPROVE") await http(target + "/approve", {method: "POST", body: {sha: current.headSha}});
          break;
        case "requestReviewer": {
          const users = array((await http("/api/v4/users?username=" + segment(action.reviewer))).payload).map(object);
          const user = users.find(row => text(row.username).toLowerCase() === action.reviewer.toLowerCase());
          if (!user || !Number.isSafeInteger(user.id)) throw new Error("PROVIDER_REJECTED");
          const existing = array(object((await http(target)).payload).reviewers).map(row => object(row).id).filter(Number.isSafeInteger) as number[];
          await http(target, {method: "PUT", body: {reviewer_ids: [...new Set([...existing, user.id as number])]}});
          break;
        }
        case "editTitle": await http(target, {method: "PUT", body: {title: current.isDraft ? "Draft: " + action.title.replace(draftPrefix, "") : action.title}}); break;
        case "editBody": await http(target, {method: "PUT", body: {description: action.body}}); break;
        // GitLab has no draft field to write: the state is the title's Draft: prefix.
        case "draft": await http(target, {method: "PUT", body: {title: action.draft ? "Draft: " + current.title.replace(draftPrefix, "") : current.title.replace(draftPrefix, "")}}); break;
        case "state": await http(target, {method: "PUT", body: {state_event: action.open ? "reopen" : "close"}}); break;
        case "merge": {
          if (action.method === "rebase") throw new Error("PROVIDER_UNSUPPORTED");
          const {payload} = await http(target + "/merge", {method: "PUT", body: {sha: current.headSha, ...(action.method === "squash" ? {squash: true} : {})}});
          if (text(object(payload).state) !== "merged") throw new Error("OUTCOME_UNKNOWN");
          break;
        }
      }
      return {outcome: "completed"};
    },
  };
}
