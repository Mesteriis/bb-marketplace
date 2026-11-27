import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { failureFor, type Copy } from "../../core/workspace.ts";
import { RUN_PERMISSION_MODES } from "../../core/code-review/runs.ts";
import { RUN_METADATA_KEY } from "../../core/code-review/tool-names.ts";
import { codeReviewRuns, type RunPlace } from "./code-review-runs.ts";
import { codeReviewService, type DiffOptions } from "./code-review-service.ts";
import { hostContract, hostSignals } from "./host-contract.ts";
import { RunStore } from "./review-run-store.ts";
import { MAX_PATTERNS, patternLines } from "./review-ignore.ts";
import { REVIEW_MIGRATIONS, ReviewStore, type ReviewDb } from "./review-store.ts";

type Caller = {experimental_caller: {kind: string}};
export const codeReviewSignal = "code-review-changed";
/** `bb git-dashboard review open`: the window showing the thread opens its copy's Review on the view and file. */
export const codeReviewOpenSignal = "code-review-open";
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
  const host = bb.hosts.experimental_client({contract: hostContract, experimental_signals: hostSignals});
  /** The copies whose open Review watches them, by host and root: a change there reloads their Review. */
  const watched = new Map<string, Set<string>>();
  const watchKey = (hostId: string, root: string) => hostId + "\u0000" + root;
  host.experimental_onSignal("reviewCopyChanged", ({hostId, payload}) => {
    for (const copyId of watched.get(watchKey(hostId, payload.root)) ?? []) bb.realtime.publish(codeReviewSignal, {copyId});
  });
  const db = bb.storage.database() as unknown as ReviewDb & Parameters<typeof bb.storage.migrate>[0];
  bb.storage.migrate(db, REVIEW_MIGRATIONS);
  const store = new ReviewStore(db);
  const runStore = new RunStore(db);
  /** The ignore patterns of every diff a Review reads, from the settings as they are now. */
  const ignoreOf = async () => {
    const {ignorePatterns, readIgnoreFiles} = await settings.get();
    return {patterns: patternLines(ignorePatterns).slice(0, MAX_PATTERNS), readFiles: readIgnoreFiles};
  };
  const settings = bb.settings.define({
    ignorePatterns: {type: "string", label: "Line review: files to leave out", default: "", experimental_multiline: true,
      description: "Generated files, lockfiles and the like, one gitignore pattern per line (for example `*.lock` or `dist/`)."},
    colorBlindDiffs: {type: "boolean", label: "Line review: colours for colour blindness", default: false,
      description: "Show added lines in blue and removed lines in orange instead of green and red."},
    readIgnoreFiles: {type: "boolean", label: "Line review: read the copy's .diffityignore", default: true,
      description: "Also leave out what `.diffityignore` and `.git/info/diffityignore` list, as diffity and diff-review do."},
    aiProvider: {type: "string", label: "Line review: provider for AI runs", default: "claude-code",
      description: "The provider AI reviews, summaries and fixes in a new thread start with (each run can pick another): claude-code, codex, opencode, … A reviewer started by @reviewer and Explain use it too."},
    aiModel: {type: "string", label: "Line review: model for AI runs", default: "",
      description: "The model for that provider, as `bb provider models` lists it. Empty uses the provider's default."},
    aiPermissionMode: {type: "select", label: "Line review: permission mode for AI runs", default: "auto", options: [...RUN_PERMISSION_MODES],
      experimental_optionLabels: {auto: "Approve for me", "accept-edits": "Accept edits"},
      description: "How AI runs start. A provider without the chosen mode runs in full mode instead. A review is asked not to edit either way, and the review lists any file that changed while it ran."},
  });
  const at = (copy: Copy) => ({hostId: copy.hostId});
  const providerName = async (threadId: string) => {
    const {providerId} = await bb.sdk.threads.get({threadId}) as {providerId: string};
    return providerNames[providerId] ?? providerId;
  };
  const threadTurnStart = async (threadId: string) => {
    const events = await bb.sdk.threads.events.list({threadId, types: ["turn/started"], order: "desc", limit: "20"});
    // A sub-agent's turn carries the tool call that started it; only the thread's own turns count.
    const own = (events as {type: string; createdAt: number; data: {parentToolCallId?: string}}[])
      .find(event => event.type === "turn/started" && event.data.parentToolCallId === undefined);
    return own?.createdAt ?? null;
  };
  const service = codeReviewService({
    store, copy: copyOf,
    host: {
      diff: async (copy, target, ignoreWhitespace, options = {}) => {
        const result = value(await host.call("reviewDiff", {root: copy.root, identity: copy.identity, target, ignoreWhitespace, ignore: await ignoreOf(),
          ...options.patches === false ? {patches: false} : {}, ...options.paths ? {paths: [...options.paths]} : {}}, at(copy)));
        return {value: result.value, target: result.target};
      },
      read: async (copy, path) => {
        const {text, sha256} = value(await host.call("reviewFile", {root: copy.root, identity: copy.identity, path}, at(copy)));
        return {text, sha256};
      },
      files: async (copy, query) => {
        const {paths, more} = value(await host.call("reviewFiles", {root: copy.root, identity: copy.identity, query}, at(copy)));
        return {paths, more};
      },
      revert: async (copy, path, revision, hunks) => { value(await host.call("reviewRevert", {root: copy.root, identity: copy.identity, path, revision, hunks}, at(copy))); },
      write: async (copy, path, expected, text) =>
        ({sha256: value(await host.call("reviewWrite", {root: copy.root, identity: copy.identity, path, expected, text}, at(copy))).sha256}),
    },
    threads: {
      send: async (threadId, text) => { await bb.sdk.threads.send({threadId, mode: "queue-if-active", input: [{type: "text", text, mentions: []}]}); },
      providerName,
      turnStart: threadTurnStart,
      copyOf: threadCopy,
    },
    changed: copyId => bb.realtime.publish(codeReviewSignal, {copyId}),
  });

  const diff = async (copy: Copy, target: Parameters<typeof service.view>[1], options: DiffOptions = {}) => {
    const result = value(await host.call("reviewDiff", {root: copy.root, identity: copy.identity, target, ignoreWhitespace: false, ignore: await ignoreOf(),
      ...options.patches === false ? {patches: false} : {}, ...options.paths ? {paths: [...options.paths]} : {}}, at(copy)));
    return {value: result.value, target: result.target};
  };
  const routing = (place: RunPlace) => "environmentId" in place ? {environmentId: place.environmentId} : {hostId: place.hostId, projectId: place.projectId};
  const runs = codeReviewRuns({
    store, runs: runStore, review: service, copy: copyOf, diff,
    read: async (copy, path) => value(await host.call("reviewFile", {root: copy.root, identity: copy.identity, path}, at(copy))).text, settings: () => settings.get(), threadCopy, pluginId: bb.pluginId,
    changed: copyId => bb.realtime.publish(codeReviewSignal, {copyId}),
    log: message => bb.log.warn(message),
    bb: {
      thread: async threadId => {
        const thread = await bb.sdk.threads.get({threadId}) as {environmentId: string | null; originPluginId?: string | null};
        return {environmentId: thread.environmentId, originPluginId: thread.originPluginId ?? null};
      },
      metadata: async threadId => await bb.sdk.threads.getPluginMetadata({threadId}) as Record<string, unknown>,
      spawn: async request => {
        const {place, execution} = request;
        const spawned = await bb.sdk.threads.spawn({
          projectId: request.projectId, title: request.title, prompt: request.prompt,
          environment: "environmentId" in place ? {type: "reuse", environmentId: place.environmentId}
            : {type: "host", hostId: place.hostId, workspace: {type: "unmanaged", path: place.path}},
          providerId: execution.providerId,
          ...(execution.model ? {model: execution.model} : {}),
          ...(request.providerReasoning ? {} : {reasoningLevel: execution.reasoningLevel}),
          ...(execution.serviceTier ? {serviceTier: execution.serviceTier} : {}),
          permissionMode: request.permissionMode,
          ...("parentThreadId" in place ? {parentThreadId: place.parentThreadId} : {}),
          pluginMetadata: {[RUN_METADATA_KEY]: request.runId},
        });
        const record = spawned as {threadId?: string; id?: string};
        return record.threadId ?? record.id ?? (() => { throw new Error("OUTCOME_UNKNOWN"); })();
      },
      send: async (threadId, text) => { await bb.sdk.threads.send({threadId, mode: "queue-if-active", input: [{type: "text", text, mentions: []}]}); },
      archive: async threadId => { await bb.sdk.threads.archive({threadId}); },
      models: async (place, providerId) => {
        const options = await bb.sdk.providers.models({...routing(place), providerId});
        if (options.modelLoadError !== null) return {models: [], error: options.modelLoadError.detail ?? providerId + " could not list its models (" + options.modelLoadError.code + ")."};
        return {models: options.models.map(entry => ({id: entry.id, model: entry.model, isDefault: entry.isDefault, defaultReasoningEffort: entry.defaultReasoningEffort})), error: null};
      },
      permissionModes: async (place, providerId) => {
        const providers = await bb.sdk.providers.list("environmentId" in place ? {environmentId: place.environmentId} : {hostId: place.hostId});
        return providers.find(provider => provider.id === providerId)?.capabilities.permissionModes ?? null;
      },
      turnStart: threadTurnStart,
      providerName,
    },
  });

  // A turn that ends, well or badly, closes out what was sent to that thread and the runs it carries.
  const turnEnded = async (thread: {id: string}, lastText: string | null, failed: boolean) => {
    // Each step runs even when the one before failed: a run must not stay Running because a send could not be marked.
    for (const step of [() => runs.bindIfPending(thread.id), () => service.turnEnded(thread.id), () => runs.turnEnded(thread.id, lastText, failed)]) {
      await step().catch(error => bb.log.warn("Could not close out the review sends and runs of " + thread.id + ": " + String(error)));
    }
  };
  bb.events.on("thread.idle", ({thread, lastAssistantText}) => { void turnEnded(thread, lastAssistantText, false); });
  bb.events.on("thread.failed", ({thread, error}) => { void turnEnded(thread, error, true); });

  /** The comment is saved either way; a reviewer that cannot start is reported with it. */
  const reviewerNote = async (thread: NonNullable<ReturnType<typeof store.thread>>, body: string, viewerThreadId: string | null | undefined) => {
    const code = await runs.onUserComment(thread, body, viewerThreadId ?? null).catch((error: unknown) => error instanceof Error ? error.message : "GIT_REJECTED");
    if (code === null) return null;
    const {code: known, next} = failureFor(new Error(code), "GIT_REJECTED");
    return {code: known, next};
  };
  const handle = <I, O extends object>(action: (input: I) => O | Promise<O>) => async (input: I, context: Caller) => {
    if (context.experimental_caller.kind !== "client") return failureFor(undefined, "ACCESS_DENIED");
    try { return {ok: true as const, ...await action(input)}; }
    catch (error) { return failureFor(error, "GIT_REJECTED"); }
  };
  const handlers = {
    reviewView: handle(async ({copyId, target, ignoreWhitespace, auto}: {copyId: string; target: Parameters<typeof service.view>[1]; ignoreWhitespace: boolean; auto?: boolean}) =>
      ({...await service.view(copyId, target, ignoreWhitespace, auto === true), colorBlind: (await settings.get()).colorBlindDiffs})),
    reviewCreateThread: handle(async ({sessionId, viewerThreadId, ...input}: {sessionId: string; viewerThreadId?: string | null} & Parameters<typeof service.createThread>[1]) => {
      const thread = await service.createThread(sessionId, input);
      return {thread, reviewer: await reviewerNote(thread, input.body, viewerThreadId)};
    }),
    reviewAddComment: handle(async ({threadId, body, viewerThreadId}: {threadId: string; body: string; viewerThreadId?: string | null}) => {
      service.addComment(threadId, body);
      const thread = store.thread(threadId);
      return {reviewer: thread ? await reviewerNote(thread, body, viewerThreadId) : null};
    }),
    reviewEditComment: handle(({commentId, body}: {commentId: string; body: string}) => { service.editComment(commentId, body); return {}; }),
    reviewDeleteComment: handle(({commentId}: {commentId: string}) => { service.deleteComment(commentId); return {}; }),
    reviewSetStatus: handle(({threadId, status}: {threadId: string; status: "open" | "resolved" | "dismissed"}) => { service.setStatus(threadId, status); return {}; }),
    reviewSend: handle(({sessionId, threadId, threadIds, note}: {sessionId: string; threadId: string; threadIds: string[]; note: string}) =>
      service.send(sessionId, threadId, threadIds, note)),
    reviewApply: handle(async ({threadId, commentId}: {threadId: string; commentId: string}) => { await service.applySuggestion(threadId, commentId); return {}; }),
    reviewRunDefaults: handle(async ({copyId, viewerThreadId}: {copyId: string; viewerThreadId?: string | null}) => runs.defaults(copyId, viewerThreadId ?? null)),
    reviewRuns: handle(({sessionId}: {sessionId: string}) => ({runs: runs.list(sessionId)})),
    reviewStartReview: handle(async ({viewerThreadId, ...input}: Omit<Parameters<typeof runs.startReview>[0], "threadId"> & {viewerThreadId?: string | null}) =>
      ({run: await runs.startReview({...input, threadId: viewerThreadId ?? null})})),
    reviewStartSummary: handle(async ({viewerThreadId, ...input}: Omit<Parameters<typeof runs.startSummary>[0], "threadId"> & {viewerThreadId?: string | null}) =>
      ({run: await runs.startSummary({...input, threadId: viewerThreadId ?? null})})),
    reviewStartExplain: handle(async ({viewerThreadId, ...input}: Omit<Parameters<typeof runs.startExplain>[0], "threadId"> & {viewerThreadId?: string | null}) =>
      ({run: await runs.startExplain({...input, threadId: viewerThreadId ?? null})})),
    reviewFix: handle(async ({viewerThreadId, ...input}: Omit<Parameters<typeof runs.fixInNewThread>[0], "threadId"> & {viewerThreadId?: string | null}) =>
      runs.fixInNewThread({...input, threadId: viewerThreadId ?? null})),
    reviewSummaries: handle(async () => ({reviews: await service.summaries()})),
    reviewDeleteOrphans: handle(({sessionIds}: {sessionIds: string[]}) => runs.deleteOrphans(sessionIds)),
    reviewThreadCounts: handle(async ({threadId}: {threadId: string}) => ({counts: await service.threadCounts(threadId)})),
    reviewCommits: handle(async ({copyId}: {copyId: string}) => {
      const copy = await copyOf(copyId);
      if (!copy) throw new Error("NOT_FOUND");
      return {commits: value(await host.call("reviewCommits", {root: copy.root, identity: copy.identity}, at(copy))).commits};
    }),
    reviewSearchFiles: handle(({copyId, query}: {copyId: string; query: string}) => service.searchFiles(copyId, query)),
    reviewFileEntry: handle(async ({copyId, path}: {copyId: string; path: string}) => ({file: await service.fileEntry(copyId, path)})),
    reviewRevert: handle(async ({sessionId, path, revision, hunks}: {sessionId: string; path: string; revision: string; hunks: number[] | null}) => {
      await service.revert(sessionId, path, revision, hunks); return {};
    }),
    reviewViewState: handle(({scope, sessionId}: {scope: string; sessionId: string}) => ({state: service.viewState(scope, sessionId)})),
    reviewSaveViewState: handle(({scope, sessionId, state}: {scope: string; sessionId: string; state: Parameters<typeof service.saveViewState>[2]}) =>
      service.saveViewState(scope, sessionId, state)),
    reviewSetViewed: handle(({sessionId, path, revision, viewed}: {sessionId: string; path: string; revision: string; viewed: boolean}) => {
      service.setViewed(sessionId, path, revision, viewed); return {};
    }),
    reviewPatches: handle(({copyId, target, ignoreWhitespace, files}: {copyId: string; target: Parameters<typeof service.patches>[1]; ignoreWhitespace: boolean;
      files: Parameters<typeof service.patches>[3]}) => service.patches(copyId, target, ignoreWhitespace, files)),
    reviewWatch: handle(async ({copyId}: {copyId: string}) => {
      const copy = await copyOf(copyId);
      if (!copy) throw new Error("NOT_FOUND");
      value(await host.call("reviewWatch", {root: copy.root, identity: copy.identity}, at(copy)));
      const key = watchKey(copy.hostId, copy.root);
      watched.set(key, (watched.get(key) ?? new Set()).add(copy.id));
      return {};
    }),
    reviewClear: handle(({sessionId}: {sessionId: string}) => runs.clearReview(sessionId)),
    reviewCloseRun: handle(async ({runId}: {runId: string}) => { await runs.close(runId); return {}; }),
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
  /** Asks the BB window showing `threadId` to open its copy's Review; the CLI's `review open`. */
  const requestOpen = async (threadId: string, target: Parameters<typeof service.requestOpen>[1], file: string | null) => {
    const opened = await service.requestOpen(threadId, target, file);
    bb.realtime.publish(codeReviewOpenSignal, {threadId, ...opened});
    return {...opened, route: "plugins/" + bb.pluginId + "/git/" + opened.copyId + "/review"};
  };
  return {handlers, service, runs, requestOpen};
}
