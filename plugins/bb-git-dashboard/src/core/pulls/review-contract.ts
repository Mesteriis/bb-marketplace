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
  issueDetail: {input: z.object(target), output: answer({issue: z.object({number: z.number().int(), title: z.string(), body: z.string(), open: z.boolean(),
    author: z.string(), labels: z.array(z.string()), url: z.string(), createdAt: z.string(),
    comments: z.array(z.object({author: z.string(), body: z.string(), createdAt: z.string(), url: z.string()})), notice: z.string().nullable()})})},
  issuePrepare: {input: z.object({accountId: id, repo: z.string().min(3).max(500), action: issueAction}), output: preview},
  issueConfirm: {input: z.object({previewId: id}), output: answer({number: z.number().int()})},
};
