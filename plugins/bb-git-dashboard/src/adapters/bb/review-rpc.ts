import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { agentPlan, linkCandidates, projectsOfRepo, spawnHost, type AgentThread } from "../../core/pulls/agent-target.ts";
import type { FixSubject } from "../../core/pulls/detail.ts";
import { answerNote, findingsPrompt, fixPrompt, prPrompts } from "../../core/pulls/prompt.ts";
import type { codeReviewService } from "./code-review-service.ts";
import type { agentSubject } from "../../core/pulls/review-contract.ts";
import type { Account } from "../../core/providers.ts";
import { failureFor } from "../../core/workspace.ts";
import { reviewService } from "./review-service.ts";

type Caller = {experimental_caller: {kind: string}};
type Target = {accountId: string; repo: string; number: number};

/** Pull request and issue RPC for the app, and Fix with agent: the pull request's branch thread, else a new thread in its project. */
export function reviewHandlers(bb: BbPluginApi, deps: {credential(id: string): Promise<{account: Account; token: string}>;
  /** The line review's mirror of pull request threads: what Fix with agent sends, and the agents' draft answers. */
  mirror: Pick<ReturnType<typeof codeReviewService>, "mirrorPull" | "recordPullSend" | "dropPullSend" | "pullDrafts" | "editDraft" | "dropDraft">}) {
  const service = reviewService(deps);
  const handle = <I, O extends object>(action: (input: I) => Promise<O>) => async (input: I, context: Caller) => {
    if (context.experimental_caller.kind !== "client") return failureFor(undefined, "ACCESS_DENIED");
    try { return {ok: true as const, ...await action(input)}; }
    catch (error) {
      // A code is the answer; anything else is a fault worth a line in the log (its text never reaches the page).
      if (!(error instanceof Error && /^[A-Z_]+$/.test(error.message))) bb.log.warn("Pull request request failed: " + (error instanceof Error ? error.message : String(error)).slice(0, 300));
      return failureFor(error, "PROVIDER_UNAVAILABLE");
    }
  };
  async function ask({accountId, repo, number, subject}: Target & {subject: z.infer<typeof agentSubject>}) {
    const {account} = await deps.credential(accountId);
    const {detail} = await service.detail(accountId, repo, number);
    const failed = detail.checks.filter(check => check.status === "failing");
    const subjects: FixSubject[] = subject.kind === "thread" ? detail.threads.filter(thread => thread.id === subject.threadId).map(thread => ({kind: "thread" as const, thread}))
      : subject.kind === "check" ? failed.filter(check => check.name === subject.name).map(check => ({kind: "check" as const, check}))
      : [...detail.threads.filter(thread => !thread.isResolved).map(thread => ({kind: "thread" as const, thread})), ...failed.map(check => ({kind: "check" as const, check}))];
    if (!subjects.length) throw new Error("NOT_FOUND");
    // The review threads are mirrored first, so the agent can answer them by id; its answers come back as drafts here.
    const sent = subjects.flatMap(item => item.kind === "thread" ? [item.thread] : []);
    const {sessionId, ids} = deps.mirror.mirrorPull(accountId, repo, number, detail.threads);
    const text = (subject.kind === "all" ? findingsPrompt(detail, subjects) : fixPrompt(detail, subjects[0]))
      + answerNote(sent.map(thread => ({id: ids[thread.id], path: thread.path, line: thread.line})));
    const mirrored = sent.map(thread => ids[thread.id]);
    const projects = await bb.sdk.projects.list();
    const projectIds = projectsOfRepo(account.kind, repo, projects);
    const threads = (await Promise.all(projectIds.map(projectId => bb.sdk.threads.list({projectId, archived: false, limit: 100})))).flat();
    const plan = agentPlan(detail, projectIds, threads as unknown as AgentThread[]);
    if ("error" in plan) throw new Error(plan.error);
    if ("send" in plan) {
      const recorded = mirrored.length ? deps.mirror.recordPullSend(sessionId, plan.send, mirrored) : null;
      // A message that does not arrive grants nothing.
      await bb.sdk.threads.send({threadId: plan.send, mode: "queue-if-active", input: [{type: "text", text, mentions: []}]})
        .catch((error: unknown) => { if (recorded) deps.mirror.dropPullSend(recorded.id); throw error; });
      return {threadId: plan.send, created: false};
    }
    // A managed worktree started from the head branch, so the project's own checkout is left alone; on the machine
    // that holds the project's working copy (BB requires the host for any workspace but a personal one).
    const project = projects.find(item => item.id === plan.spawn.projectId);
    const hostId = spawnHost(project, project?.sources.length ? [] : await bb.sdk.environments.list({projectId: plan.spawn.projectId, limit: 50}));
    if (!hostId) throw new Error("HOST_UNAVAILABLE");
    const spawned = await bb.sdk.threads.spawn({projectId: plan.spawn.projectId, prompt: text, title: "Fix " + repo + " #" + number,
      environment: {type: "host", hostId, workspace: {type: "managed-worktree",
        baseBranch: plan.spawn.baseBranch ? {kind: "named", name: plan.spawn.baseBranch} : {kind: "default"}}}}) as {threadId?: string; id?: string};
    const threadId = spawned.threadId ?? spawned.id;
    if (!threadId) throw new Error("OUTCOME_UNKNOWN");
    if (mirrored.length) deps.mirror.recordPullSend(sessionId, threadId, mirrored);
    return {threadId, created: true};
  }
  return {
    prDetail: handle(({accountId, repo, number}: Target) => service.detail(accountId, repo, number)),
    prFiles: handle(({accountId, repo, number}: Target) => service.files(accountId, repo, number)),
    prPrepare: handle(({accountId, repo, number, action, shown}: Target & {action: Parameters<typeof service.prepare>[3]; shown?: string | null}) =>
      service.prepare(accountId, repo, number, action, shown)),
    prConfirm: handle(({previewId}: {previewId: string}) => service.confirm(previewId)),
    prAsk: handle(ask),
    /** Threads to link the pull request to: its branch thread first, then its project's, then the rest. */
    prLinkCandidates: handle(async ({accountId, repo, number}: Target) => {
      const {account} = await deps.credential(accountId);
      const {detail} = await service.detail(accountId, repo, number);
      const projects = await bb.sdk.projects.list();
      const projectIds = projectsOfRepo(account.kind, repo, projects);
      const threads = await bb.sdk.threads.list({archived: false, limit: 200}) as unknown as AgentThread[];
      const plan = agentPlan(detail, projectIds, threads);
      return {threads: linkCandidates(threads, projects, {thread: "send" in plan ? {id: plan.send} : null, projectId: projectIds[0] ?? null})};
    }),
    /** Link to thread: the pull request goes to a thread as context, asking for nothing. */
    prLink: handle(async ({accountId, repo, number, threadId}: Target & {threadId: string}) => {
      const {detail} = await service.detail(accountId, repo, number);
      await bb.sdk.threads.send({threadId, mode: "queue-if-active", input: [{type: "text", text: prPrompts.link(detail), mentions: []}]});
      return {threadId};
    }),
    /** Ask a question / Explain this PR: a new thread's prompt, opened in BB's composer in the pull request's project. */
    prCompose: handle(async ({accountId, repo, number, kind}: Target & {kind: "ask" | "explain"}) => {
      const {account} = await deps.credential(accountId);
      const {detail} = await service.detail(accountId, repo, number);
      const projectId = projectsOfRepo(account.kind, repo, await bb.sdk.projects.list())[0] ?? null;
      return {prompt: prPrompts[kind](detail), projectId};
    }),
    /** Agents' unposted answers on the pull request's threads; posting goes through prPrepare like any reply. */
    prDrafts: handle(async ({accountId, repo, number}: Target) => ({drafts: deps.mirror.pullDrafts(accountId, repo, number)})),
    prDraftEdit: handle(async ({commentId, body}: {commentId: string; body: string}) => { deps.mirror.editDraft(commentId, body); return {}; }),
    prDraftDrop: handle(async ({commentId}: {commentId: string}) => { deps.mirror.dropDraft(commentId); return {}; }),
    prJira: handle(async () => {
      try {
        const status = await bb.sdk.plugins.callRpc({pluginId: "my-jira", method: "auth_status", input: null, signal: AbortSignal.timeout(5_000),
          outputSchema: z.object({site: z.object({url: z.string()}).nullable()}).passthrough()});
        const site = status.site?.url ?? "";
        return {plugin: true, siteUrl: /^https:\/\/[^\s]{1,490}$/.test(site) ? site : null};
      } catch {
        // Not installed or not running: keys go to the Jira site the pull request links to, if any.
        return {plugin: false, siteUrl: null};
      }
    }),
    issueDetail: handle(({accountId, repo, number}: Target) => service.issueDetail(accountId, repo, number)),
    issuePrepare: handle(({accountId, repo, action}: {accountId: string; repo: string; action: Parameters<typeof service.issuePrepare>[2]}) =>
      service.issuePrepare(accountId, repo, action)),
    issueConfirm: handle(({previewId}: {previewId: string}) => service.issueConfirm(previewId)),
  };
}
