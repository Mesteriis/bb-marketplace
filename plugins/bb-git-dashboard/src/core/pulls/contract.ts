import { z } from "zod";
import { answer } from "../answer.ts";

export const inboxTab = z.enum(["open", "review", "reviewed", "assigned", "merged", "closed"]);
const kind = z.enum(["github", "gitlab", "gitea", "azure"]);
const stack = z.object({number: z.number().int(), title: z.string(), url: z.string()});
export const inboxPr = z.object({
  id: z.string(), number: z.number().int(), title: z.string(), url: z.string(), repo: z.string(), author: z.string(),
  baseRefName: z.string(), headRefName: z.string(), onDefaultBranch: z.boolean(), stackedOn: stack.nullable(), isDraft: z.boolean(),
  createdAt: z.string(), updatedAt: z.string(), mergedAt: z.string().nullable(), closedAt: z.string().nullable(),
  additions: z.number().int().nullable(), deletions: z.number().int().nullable(), ci: z.enum(["passing", "failing", "pending", "none"]),
  failingChecks: z.array(z.object({name: z.string(), workflow: z.string().nullable(), url: z.string().nullable()})),
  unresolvedThreads: z.number().int(), notes: z.array(z.string()), reviewDecision: z.string().nullable(), conflicts: z.boolean(),
  blockers: z.array(z.string()), myReview: z.object({state: z.string(), stale: z.boolean()}).nullable(), forge: kind, accountId: z.string(),
});
export const inboxAlert = z.object({id: z.string(), kind: z.enum(["ci", "comment", "test"]), repo: z.string(), number: z.number().int(),
  url: z.string(), headline: z.string(), detail: z.string(), at: z.string(), seen: z.boolean(), accountId: z.string()});
const alerts = {alerts: z.array(inboxAlert), unseen: z.number().int(), toasts: z.boolean(), badge: z.boolean()};

const group = z.object({account: z.object({id: z.string(), label: z.string(), kind}), items: z.array(inboxPr), total: z.number().int().nullable(),
  notice: z.string().nullable(), error: z.string().nullable()});

export const inboxContract = {
  inboxList: {input: z.object({tab: inboxTab}), output: answer({
    tab: inboxTab, counts: z.partialRecord(inboxTab, z.number().int()),
    groups: z.array(group),
  })},
  /** Merged or closed with the whole history the forge reads (GitHub: up to 1 000), for search on those tabs. */
  inboxHistory: {input: z.object({tab: z.enum(["merged", "closed"])}), output: answer({tab: inboxTab, groups: z.array(group)})},
  inboxAlerts: {input: z.object({}), output: answer(alerts)},
  inboxSeen: {input: z.object({}), output: answer(alerts)},
  inboxTest: {input: z.object({}), output: answer({...alerts, push: z.object({sent: z.boolean(), message: z.string()})})},
};
