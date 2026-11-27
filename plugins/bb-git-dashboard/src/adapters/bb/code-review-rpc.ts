import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { failureFor, type Copy } from "../../core/workspace.ts";
import { codeReviewService } from "./code-review-service.ts";
import { hostContract } from "./host-contract.ts";
import { REVIEW_MIGRATIONS, ReviewStore, type ReviewDb } from "./review-store.ts";

type Caller = {experimental_caller: {kind: string}};
export const codeReviewSignal = "code-review-changed";
/** How agents sign their comments, by their thread's provider; diff-review's names. */
const providerNames: Record<string, string> = {"claude-code": "Claude Code", codex: "Codex", opencode: "OpenCode", gemini: "Gemini"};

/** Turns a host answer into its value, or throws its code. */
function value<T extends {ok: boolean}>(result: T): Extract<T, {ok: true}> {
  if (!result.ok) throw new Error((result as unknown as {code: string}).code);
  return result as Extract<T, {ok: true}>;
}

/**
 * The line review on the server: its SQLite store, the service, the app's RPC handlers, and the end of agent turns.
 * `threadCopy` is the copy a thread's environment holds, or null.
 */
export function codeReviewHandlers(bb: BbPluginApi, copyOf: (copyId: string) => Promise<Copy | undefined>,
  threadCopy: (threadId: string) => Promise<string | null>) {
  const host = bb.hosts.experimental_client({contract: hostContract});
  const db = bb.storage.database() as unknown as ReviewDb & Parameters<typeof bb.storage.migrate>[0];
  bb.storage.migrate(db, REVIEW_MIGRATIONS);
  const store = new ReviewStore(db);
  const at = (copy: Copy) => ({hostId: copy.hostId});
  const service = codeReviewService({
    store, copy: copyOf,
    host: {
      diff: async (copy, target, ignoreWhitespace) => {
        const result = value(await host.call("reviewDiff", {root: copy.root, identity: copy.identity, target, ignoreWhitespace}, at(copy)));
        return {value: result.value, target: result.target};
      },
      read: async (copy, path) => {
        const {text, sha256} = value(await host.call("reviewFile", {root: copy.root, identity: copy.identity, path}, at(copy)));
        return {text, sha256};
      },
      write: async (copy, path, expected, text) =>
        ({sha256: value(await host.call("reviewWrite", {root: copy.root, identity: copy.identity, path, expected, text}, at(copy))).sha256}),
    },
    threads: {
      send: async (threadId, text) => { await bb.sdk.threads.send({threadId, mode: "queue-if-active", input: [{type: "text", text, mentions: []}]}); },
      providerName: async threadId => {
        const {providerId} = await bb.sdk.threads.get({threadId}) as {providerId: string};
        return providerNames[providerId] ?? providerId;
      },
      turnStart: async threadId => {
        const events = await bb.sdk.threads.events.list({threadId, types: ["turn/started"], order: "desc", limit: "20"});
        // A sub-agent's turn carries the tool call that started it; only the thread's own turns count.
        const own = (events as {type: string; createdAt: number; data: {parentToolCallId?: string}}[])
          .find(event => event.type === "turn/started" && event.data.parentToolCallId === undefined);
        return own?.createdAt ?? null;
      },
      copyOf: threadCopy,
    },
    changed: copyId => bb.realtime.publish(codeReviewSignal, {copyId}),
  });

  const turnEnded = ({thread}: {thread: {id: string}}) => { service.turnEnded(thread.id).catch(() => { /* the next turn retries */ }); };
  bb.events.on("thread.idle", turnEnded);
  bb.events.on("thread.failed", turnEnded);

  const handle = <I, O extends object>(action: (input: I) => O | Promise<O>) => async (input: I, context: Caller) => {
    if (context.experimental_caller.kind !== "client") return failureFor(undefined, "ACCESS_DENIED");
    try { return {ok: true as const, ...await action(input)}; }
    catch (error) { return failureFor(error, "GIT_REJECTED"); }
  };
  const handlers = {
    reviewView: handle(({copyId, target, ignoreWhitespace}: {copyId: string; target: Parameters<typeof service.view>[1]; ignoreWhitespace: boolean}) =>
      service.view(copyId, target, ignoreWhitespace)),
    reviewCreateThread: handle(async ({sessionId, ...input}: {sessionId: string} & Parameters<typeof service.createThread>[1]) =>
      ({thread: await service.createThread(sessionId, input)})),
    reviewAddComment: handle(({threadId, body}: {threadId: string; body: string}) => { service.addComment(threadId, body); return {}; }),
    reviewEditComment: handle(({commentId, body}: {commentId: string; body: string}) => { service.editComment(commentId, body); return {}; }),
    reviewDeleteComment: handle(({commentId}: {commentId: string}) => { service.deleteComment(commentId); return {}; }),
    reviewSetStatus: handle(({threadId, status}: {threadId: string; status: "open" | "resolved" | "dismissed"}) => { service.setStatus(threadId, status); return {}; }),
    reviewSend: handle(({sessionId, threadId, threadIds, note}: {sessionId: string; threadId: string; threadIds: string[]; note: string}) =>
      service.send(sessionId, threadId, threadIds, note)),
    reviewApply: handle(async ({threadId, commentId}: {threadId: string; commentId: string}) => { await service.applySuggestion(threadId, commentId); return {}; }),
    reviewTargets: handle(async ({copyId}: {copyId: string}) => {
      const copy = await copyOf(copyId);
      if (!copy?.projectId) return {threads: []};
      const rows = (await bb.sdk.threads.list({projectId: copy.projectId, archived: false, limit: 30})) as {id: string; title?: string | null}[];
      const threads: {id: string; title: string}[] = [];
      for (let index = 0; index < rows.length; index += 6) {
        const batch = await Promise.all(rows.slice(index, index + 6).map(async row =>
          await threadCopy(row.id).catch(() => null) === copyId ? {id: row.id, title: row.title || row.id} : null));
        threads.push(...batch.filter(row => row !== null));
      }
      return {threads};
    }),
  };
  return {handlers, service};
}
