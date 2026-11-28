import { z } from "zod";
import { answer } from "../answer.ts";
import { issueAction } from "../issues/model.ts";
import { id } from "../workspace.ts";
import { prAction } from "./actions.ts";

const nullable = z.string().nullable();
const comment = z.object({id: z.string(), canDelete: z.boolean(), author: z.string(), avatarUrl: nullable, body: z.string(), createdAt: z.string(), url: z.string()});
const check = z.object({name: z.string(), workflow: nullable, status: z.enum(["failing", "pending", "passing", "skipped"]), conclusion: nullable,
  url: nullable, title: nullable, summary: nullable, annotations: z.array(z.object({path: z.string(), line: z.number().int().nullable(), level: nullable, message: z.string()}))});
export const prDetail = z.object({
  forge: z.enum(["github", "gitlab", "gitea", "azure"]), id: z.string(), headSha: nullable, viewer: z.string(), number: z.number().int(), title: z.string(),
  url: z.string(), repo: z.string(), author: z.string(), authorAvatarUrl: nullable, state: z.string(), isDraft: z.boolean(), headRefName: z.string(),
  baseRefName: z.string(), onDefaultBranch: z.boolean(), stackedOn: z.object({number: z.number().int(), title: z.string(), url: z.string()}).nullable(),
  changedFiles: z.number().int(), additions: z.number().int(), deletions: z.number().int(), pendingReviewId: nullable, reviewDecision: nullable,
  conflicts: z.boolean(), timeline: z.array(comment.extend({reviewState: nullable})),
  threads: z.array(z.object({id: z.string(), path: z.string(), side: z.enum(["LEFT", "RIGHT"]), startLine: z.number().int().nullable(), isPending: z.boolean(),
    line: z.number().int().nullable(), isResolved: z.boolean(), isOutdated: z.boolean(), resolvedBy: nullable, canToggleResolved: z.boolean(),
    diffHunk: nullable, comments: z.array(comment), awaitingReply: z.boolean()})),
  checks: z.array(check), reviewers: z.array(z.object({name: z.string(), avatarUrl: nullable, team: z.boolean(), state: z.string()})),
  labels: z.array(z.object({name: z.string(), color: nullable})), body: z.string(), canEdit: z.boolean(),
  commits: z.array(z.object({oid: z.string(), shortOid: z.string(), headline: z.string(), author: z.string(), avatarUrl: nullable, committedDate: z.string(),
    ci: z.enum(["failing", "pending", "passing", "skipped"]).nullable()})),
  commitCount: z.number().int(), myReviewOid: nullable, diffRefs: z.object({base: z.string(), head: z.string(), start: z.string()}).nullable().optional(), fromFork: z.boolean().optional(),
  notices: z.array(z.string().max(300)).max(10).optional(),
});
const file = z.object({path: z.string(), previousPath: nullable, status: z.string(), additions: z.number().int(), deletions: z.number().int(), patch: nullable});
const target = {accountId: id, repo: z.string().min(3).max(500), number: z.number().int().positive()};
const preview = answer({id, lines: z.array(z.string()), expires: z.string()});
export const agentSubject = z.discriminatedUnion("kind", [
  z.object({kind: z.literal("thread"), threadId: z.string().min(1).max(200)}),
  z.object({kind: z.literal("check"), name: z.string().min(1).max(300)}),
  z.object({kind: z.literal("all")}),
]);

export const reviewContract = {
  prDetail: {input: z.object(target), output: answer({detail: prDetail, capabilities: z.record(z.string(), z.boolean()),
    limitations: z.record(z.string(), z.string()), mergeMethods: z.array(z.enum(["merge", "squash", "rebase"]))})},
  prFiles: {input: z.object(target), output: answer({files: z.array(file)})},
  prPrepare: {input: z.object({...target, action: prAction, shown: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/).nullable().optional()}), output: preview},
  prConfirm: {input: z.object({previewId: id}), output: answer({outcome: z.enum(["completed", "accepted"])})},
  prAsk: {input: z.object({...target, subject: agentSubject}), output: answer({threadId: id, created: z.boolean()})},
  prLinkCandidates: {input: z.object(target), output: answer({threads: z.array(z.object({id, title: z.string(), project: z.string(), updatedAt: z.number()}))})},
  prLink: {input: z.object({...target, threadId: id}), output: answer({threadId: id})},
  prCompose: {input: z.object({...target, kind: z.enum(["ask", "explain"])}), output: answer({prompt: z.string(), projectId: id.nullable()})},
  /** Agents' unposted answers on the pull request's review threads (their forge ids), kept for the owner to post. */
  prDrafts: {input: z.object(target), output: answer({drafts: z.array(z.object({commentId: z.string(), threadId: z.string(), externalId: z.string(),
    draft: z.enum(["reply", "resolve"]), body: z.string(), authorName: z.string(), createdAt: z.number()}))})},
  prDraftEdit: {input: z.object({commentId: z.string().regex(/^[0-9a-f]{12}$/), body: z.string().min(1).max(20_000)}), output: answer({})},
  prDraftDrop: {input: z.object({commentId: z.string().regex(/^[0-9a-f]{12}$/)}), output: answer({})},
  /** Whether BB's My Jira plugin runs here (Jira keys then open in it), and its Jira site. Read-only. */
  prJira: {input: z.object({}), output: answer({plugin: z.boolean(), siteUrl: z.string().url().max(500).nullable()})},
  issueDetail: {input: z.object(target), output: answer({issue: z.object({number: z.number().int(), title: z.string(), body: z.string(), open: z.boolean(),
    author: z.string(), labels: z.array(z.string()), url: z.string(), createdAt: z.string(),
    comments: z.array(z.object({author: z.string(), body: z.string(), createdAt: z.string(), url: z.string()})), notice: z.string().nullable()})})},
  /** Ask an agent about an issue: a new thread's prompt (title and text fenced as data), opened in BB's composer. */
  issueCompose: {input: z.object(target), output: answer({prompt: z.string(), projectId: id.nullable()})},
  issuePrepare: {input: z.object({accountId: id, repo: z.string().min(3).max(500), action: issueAction}), output: preview},
  issueConfirm: {input: z.object({previewId: id}), output: answer({number: z.number().int()})},
};
