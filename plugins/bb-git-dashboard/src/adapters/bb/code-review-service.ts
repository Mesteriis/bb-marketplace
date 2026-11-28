import { placeThread, type Placement } from "../../core/code-review/anchors.ts";
import { changeRevision, PATCH_BATCH, patchPaths, wholeFileEntry, withPatches, type ReviewDiff, type ReviewDiffFile } from "../../core/code-review/diff.ts";
import { ANCHOR_MAX_CHARS, BODY_MAX_CHARS, describeTarget, GENERAL_PATH, targetFromKey, targetKey, targetSchema, type Severity, type Side, type Target, type TargetRequest } from "../../core/code-review/model.ts";
import { contentLines, parsePatchLines } from "../../core/code-review/patch-lines.ts";
import { readViewState, viewStateSchema, type ViewState } from "../../core/code-review/view-state.ts";
import { sendPrompt } from "../../core/code-review/prompt.ts";
import { bodyParts, replaceLines } from "../../core/code-review/suggestion.ts";
import type { Copy } from "../../core/workspace.ts";
import type { ReviewStore } from "./review-store.ts";

export type CodeReviewDeps = {
  store: ReviewStore;
  copy(copyId: string): Promise<Copy | undefined>;
  /** Git on the copy's host; each throws its code. */
  host: {
    diff(copy: Copy, target: TargetRequest, ignoreWhitespace: boolean, options?: DiffOptions): Promise<{value: ReviewDiff; target: Target}>;
    read(copy: Copy, path: string): Promise<{text: string; sha256: string}>;
    write(copy: Copy, path: string, expected: string, text: string): Promise<{sha256: string}>;
    revert(copy: Copy, path: string, revision: string, hunks: number[] | null): Promise<void>;
    /** The copy's files whose path holds every word of `query`. */
    files(copy: Copy, query: string): Promise<{paths: string[]; more: boolean}>;
  };
  threads: {
    send(threadId: string, text: string): Promise<void>;
    /** How an agent's comments are signed: its thread's provider. */
    providerName(threadId: string): Promise<string>;
    /** When the thread's latest turn started, or null when unknown. */
    turnStart(threadId: string): Promise<number | null>;
    /** The Makosh Git copy of the thread's environment, or null. */
    copyOf(threadId: string): Promise<string | null>;
  };
  /** The copy's review changed: tabs reload it. */
  changed(copyId: string): void;
};
/** `anchorContent`: the commented lines' text as the owner's view showed them; the thread follows that text. */
export type NewThreadInput = {filePath: string; side: Side | null; startLine: number; endLine: number; anchorContent: string | null;
  severity: Severity | null; body: string};
export type AgentAction = "reply" | "resolve" | "dismiss";
/** `patches: false` lists the files only; `paths` limits the diff to those paths. */
export type DiffOptions = {patches?: boolean; paths?: readonly string[]};


/** Views whose new side is the working tree, where a suggestion can be written. */
const workingViews = new Set<Target["kind"]>(["uncommitted", "unstaged", "all", "files"]);
/** A pull request's mirrored threads live in a session of their own, keyed by the account and the pull request. */
const FORGE = "forge:";
const pullKey = (repo: string, number: number) => "pr:" + repo + "#" + number;
/** A forge review thread as a pull request's page reads it. */
export type PullThread = {id: string; path: string; side: "LEFT" | "RIGHT"; startLine: number | null; line: number | null; isResolved: boolean;
  comments: {author: string; body: string}[]};
const scopeOf = (scope: string) => /^(thread|copy):[A-Za-z0-9_-]{1,128}$/.test(scope) ? scope : fail("INVALID_INPUT");
const fail = (code: string): never => { throw new Error(code); };
function text(body: string) {
  const trimmed = body.trim();
  if (!trimmed || body.length > BODY_MAX_CHARS) fail("INVALID_INPUT");
  return body;
}

/**
 * The line review of working copies: views, threads and comments, sends to agents and their answers, and
 * suggestions applied to the working tree. Follows diff-review's ReviewService (MIT, gpambrozio).
 */
export function codeReviewService(deps: CodeReviewDeps) {
  const {store} = deps;

  function session(sessionId: string) {
    return store.sessionById(sessionId) ?? fail("NOT_FOUND");
  }
  function thread(threadId: string) {
    return store.thread(threadId) ?? fail("NOT_FOUND");
  }
  async function copyOf(copyId: string) {
    return await deps.copy(copyId) ?? fail("NOT_FOUND");
  }
  const changed = (sessionId: string) => deps.changed(session(sessionId).copyId);
  /** Each file whose patch was read, with whether its Viewed mark is at this very change; deferred ones are told later. */
  function markViewed(sessionId: string, files: ReviewDiffFile[]) {
    const marks = store.viewed(sessionId);
    return files.map(file => file.deferred ? file : {...file, viewed: marks.get(file.path) === changeRevision(file)});
  }

  /** The thread an agent named by a unique prefix of its id, among those sent to its own thread only. */
  function named(callerThreadId: string, prefix: string) {
    if (!/^[0-9a-f]{4,12}$/.test(prefix)) fail("INVALID_ID");
    const found = store.agentThreads(callerThreadId).filter(row => row.id.startsWith(prefix));
    if (found.length > 1) fail("AMBIGUOUS_ID");
    return found[0]?.id ?? fail("NOT_SENT_HERE");
  }

  return {
    /**
     * A view of the copy with its threads placed. With `auto` (a first look, no view picked yet) an empty uncommitted
     * view gives way to the branch's commits since its base, when there are any.
     */
    async view(copyId: string, request: TargetRequest, ignoreWhitespace: boolean, auto = false) {
      const copy = await copyOf(copyId);
      // The list first; then the patches of the first files and of the commented ones. The rest come in batches.
      let {value, target} = await deps.host.diff(copy, request, ignoreWhitespace, {patches: false});
      if (auto && request.kind === "uncommitted" && value.files.length === 0) {
        // A copy without a base branch has no branch view: the uncommitted one stands.
        const branch = await deps.host.diff(copy, {kind: "branch"}, ignoreWhitespace, {patches: false}).catch(() => null);
        if (branch && branch.value.files.length > 0) ({value, target} = branch);
      }
      const commented = new Set(store.threads(store.session(copy.id, targetKey(targetSchema.parse(target))).id).map(row => row.filePath));
      if (target.kind === "files") {
        // Any file: the files that have threads, each as it reads now; one that cannot be read leaves its threads outdated.
        const entries = await Promise.all([...commented].filter(path => path !== GENERAL_PATH).sort()
          .map(path => deps.host.read(copy, path).then(file => wholeFileEntry(path, file.text), () => null)));
        value = {...value, files: entries.filter(entry => entry !== null)};
      }
      const deferred = value.files.filter(file => file.deferred);
      const eager = [...deferred.slice(0, PATCH_BATCH), ...deferred.slice(PATCH_BATCH).filter(file => commented.has(file.path))];
      if (eager.length) {
        const read = await deps.host.diff(copy, target, ignoreWhitespace, {paths: patchPaths(eager)});
        value = {...value, files: withPatches(value.files, read.value.files)};
      }
      const key = targetKey(targetSchema.parse(target));
      const {id: sessionId} = store.session(copy.id, key);
      value = {...value, files: markViewed(sessionId, value.files)};
      const files = new Map(value.files.flatMap(file => file.patch === null ? [] : [[file.path, parsePatchLines(file.patch)] as const]));
      const threads = store.threads(sessionId);
      const placements: Record<string, Placement> = Object.fromEntries(threads.map(row => [row.id,
        placeThread(row, value.files.some(file => file.path === row.filePath) ? files.get(row.filePath) ?? {old: new Map(), new: new Map()} : undefined)]));
      return {sessionId, target, ...value, threads, placements, copy: {hostId: copy.hostId, root: copy.root}};
    },
    threads: (sessionId: string) => store.threads(sessionId),

    /** Reverts a file (or some hunks) of the uncommitted view, while its change is the one shown (`revision`). */
    async revert(sessionId: string, path: string, revision: string, hunks: number[] | null) {
      const owner = session(sessionId);
      if (owner.targetKey !== "uncommitted") fail("NOT_UNCOMMITTED");
      await deps.host.revert(await copyOf(owner.copyId), path, revision, hunks);
      changed(sessionId);
    },

    /** What a tab (`scope`: `thread:<id>` or `copy:<id>`) kept of a view: drafts, folds, scroll. */
    viewState(scope: string, sessionId: string): ViewState {
      session(sessionId);
      return readViewState(store.viewState(scopeOf(scope), sessionId));
    },
    saveViewState(scope: string, sessionId: string, state: ViewState) {
      session(sessionId);
      return {kept: store.saveViewState(scopeOf(scope), sessionId, state.savedAt, JSON.stringify(viewStateSchema.parse(state)))};
    },

    /** Every review with threads for the Reviews page: its copy (null when gone: an orphan), view and counts. */
    async summaries() {
      // A pull request's mirror is no working copy's review: its page shows it.
      const rows = store.summaries().filter(row => !row.copyId.startsWith(FORGE));
      const copies = new Map(await Promise.all([...new Set(rows.map(row => row.copyId))].map(async id => [id, await deps.copy(id).catch(() => undefined)] as const)));
      return rows.map(row => {
        const copy = copies.get(row.copyId);
        return {...row, orphan: !copy, view: describeTarget(targetFromKey(row.targetKey)),
          copyName: copy ? copy.repositoryName || copy.root.split(/[\\/]/).filter(Boolean).pop() || copy.root : null};
      });
    },
    /** Open and total threads of the copy a BB thread works on, for its Info row; null when it works on none. */
    async threadCounts(threadId: string) {
      const copyId = await deps.threads.copyOf(threadId).catch(() => null);
      return copyId ? {copyId, ...store.counts(copyId)} : null;
    },
    /** `bb git-dashboard review open`: the copy and view a thread's Review is to open on. */
    async requestOpen(threadId: string, target: TargetRequest, file: string | null) {
      const copyId = await deps.threads.copyOf(threadId).catch(() => null) ?? fail("NOT_FOUND");
      if (file !== null && (file.length > 4096 || !file.trim())) fail("INVALID_INPUT");
      return {copyId, target, file};
    },

    /**
     * Mirrors a pull request's review threads (as its page read them) into its own review session, so an agent they
     * are sent to answers them like any thread; its answers there are drafts. Returns each forge id's mirror.
     */
    mirrorPull(accountId: string, repo: string, number: number, threads: readonly PullThread[]) {
      const {id: sessionId} = store.session(FORGE + accountId, pullKey(repo, number));
      const ids: Record<string, string> = {};
      for (const thread of threads) {
        const line = thread.line ?? 0;
        ids[thread.id] = store.mirrorThread(sessionId, thread.id, {filePath: thread.path || GENERAL_PATH, side: line ? (thread.side === "LEFT" ? "old" : "new") : null,
          startLine: line ? thread.startLine ?? line : 0, endLine: line, resolved: thread.isResolved,
          comments: thread.comments.map(comment => ({author: comment.author, body: comment.body.slice(0, BODY_MAX_CHARS)}))});
      }
      // A thread the forge no longer has takes its mirror and drafts with it: nobody answers it any more.
      store.dropMirrorsExcept(sessionId, threads.map(thread => thread.id));
      return {sessionId, ids};
    },
    /** Records that mirrored threads went to an agent's thread, so it may answer them; undone when the message fails. */
    recordPullSend(sessionId: string, bbThreadId: string, threadIds: readonly string[]) {
      return store.recordSend(sessionId, bbThreadId, threadIds, "");
    },
    dropPullSend: (sendId: string) => store.dropSend(sendId),
    /** Agents' unposted answers on a pull request's threads, by forge thread id. */
    pullDrafts(accountId: string, repo: string, number: number) {
      return store.drafts(store.session(FORGE + accountId, pullKey(repo, number)).id);
    },
    editDraft(commentId: string, body: string) {
      const draft = store.comment(commentId);
      if (!draft?.draft) fail("NOT_FOUND");
      store.editDraft(commentId, text(body));
    },
    /** A draft discarded, or posted to the forge (the forge's copy shows from then on). */
    dropDraft(commentId: string) {
      if (!store.comment(commentId)?.draft) fail("NOT_FOUND");
      store.dropDraft(commentId);
    },

    /** Files of the copy for the Any file view's search. */
    async searchFiles(copyId: string, query: string) {
      if (query.length > 200) fail("INVALID_INPUT");
      return deps.host.files(await copyOf(copyId), query);
    },
    /** A file of the copy as the Any file view shows it. */
    async fileEntry(copyId: string, path: string) {
      return wholeFileEntry(path, (await deps.host.read(await copyOf(copyId), path)).text);
    },

    /** Marks a file Viewed at the change the view showed (`revision`, from `changeRevision`), or clears its mark. */
    setViewed(sessionId: string, path: string, revision: string, viewed: boolean) {
      session(sessionId);
      if (path.length > 4096 || (viewed && !/^[0-9a-f]{16}$/.test(revision))) fail("INVALID_INPUT");
      store.setViewed(sessionId, path, viewed ? revision : null);
    },

    /** The patches of some files of a view the list left deferred, as the host reads them now. */
    async patches(copyId: string, target: Target, ignoreWhitespace: boolean, files: readonly ReviewDiffFile[]) {
      const copy = await copyOf(copyId);
      if (files.length > PATCH_BATCH) fail("INVALID_INPUT");
      const read = await deps.host.diff(copy, target, ignoreWhitespace, {paths: patchPaths(files)});
      return {files: markViewed(store.session(copy.id, targetKey(target)).id, read.value.files)};
    },

    async createThread(sessionId: string, input: NewThreadInput) {
      session(sessionId);
      const body = text(input.body);
      const general = input.filePath === GENERAL_PATH;
      const wholeFile = !general && input.startLine === 0;
      if (!general && !wholeFile && (input.side === null || input.endLine < input.startLine)) fail("INVALID_INPUT");
      const anchorContent = general || wholeFile ? null : input.anchorContent;
      if (!general && !wholeFile && anchorContent === null) fail("LINE_NOT_IN_DIFF");
      if (anchorContent !== null && anchorContent.length > ANCHOR_MAX_CHARS) fail("INVALID_INPUT");
      const made = store.createThread({sessionId, filePath: input.filePath, side: general || wholeFile ? null : input.side,
        startLine: general ? 0 : input.startLine, endLine: general ? 0 : input.endLine, severity: input.severity, anchorContent, body});
      changed(sessionId);
      return made;
    },
    /** An AI run's comment: placed and checked by the run service, signed with the run's provider. */
    createAgentThread(sessionId: string, input: Omit<NewThreadInput, "anchorContent"> & {anchorContent: string | null}, authorName: string, runId: string | null = null) {
      session(sessionId);
      const made = store.createThread({sessionId, filePath: input.filePath, side: input.side, startLine: input.startLine, endLine: input.endLine,
        severity: input.severity, anchorContent: input.anchorContent, body: text(input.body)}, {type: "agent", name: authorName}, runId);
      changed(sessionId);
      return made;
    },
    addComment(threadId: string, body: string) {
      const row = thread(threadId);
      const comment = store.addComment(row.id, text(body));
      changed(row.sessionId);
      return comment;
    },
    editComment(commentId: string, body: string) {
      const comment = store.comment(commentId) ?? fail("NOT_FOUND");
      if (comment.authorType !== "user") fail("ACCESS_DENIED");
      store.editComment(commentId, text(body));
      changed(thread(comment.threadId).sessionId);
    },
    deleteComment(commentId: string) {
      const comment = store.comment(commentId) ?? fail("NOT_FOUND");
      if (comment.authorType !== "user") fail("ACCESS_DENIED");
      const {sessionId} = thread(comment.threadId);
      store.deleteComment(commentId);
      changed(sessionId);
    },
    setStatus(threadId: string, status: "open" | "resolved" | "dismissed") {
      const row = thread(threadId);
      store.setStatus(row.id, status);
      changed(row.sessionId);
    },

    /** Sends open threads of a session to a thread working on the same copy, as one prompt; a failed send is undone. */
    async send(sessionId: string, bbThreadId: string, threadIds: string[], note: string) {
      const owner = session(sessionId);
      if (await deps.threads.copyOf(bbThreadId) !== owner.copyId) fail("WRONG_WORKSPACE");
      const chosen = store.threads(sessionId).filter(row => threadIds.includes(row.id) && row.status === "open");
      if (!chosen.length) fail("NOTHING_TO_SEND");
      const target = targetFromKey(owner.targetKey);
      const recorded = store.recordSend(sessionId, bbThreadId, chosen.map(row => row.id), note);
      try {
        await deps.threads.send(bbThreadId, sendPrompt({target, threads: chosen, note}));
      } catch (error) {
        store.dropSend(recorded.id);
        throw error;
      }
      changed(sessionId);
      return {count: chosen.length};
    },

    /** The threads an agent may answer (sent to its thread, or its review run's session): the open ones, or with `all` every one. */
    sentTo(callerThreadId: string, all: boolean) {
      return store.agentThreads(callerThreadId).filter(row => all || row.status === "open");
    },

    /** An agent's reply, resolution or dismissal; allowed only on threads whose last send went to its thread. */
    async answer(callerThreadId: string, prefix: string, action: AgentAction, body: string) {
      const content = text(body);
      // What awaits BB comes first; the right is checked in the same transaction as the write.
      const authorName = await deps.threads.providerName(callerThreadId).catch(() => "Agent");
      const started = await deps.threads.turnStart(callerThreadId).catch(() => null);
      const id = named(callerThreadId, prefix);
      const written = store.answerAsAgent({threadId: id, callerThreadId, ackBefore: started, authorName, body: content,
        status: action === "reply" ? null : action === "resolve" ? "resolved" : "dismissed"});
      if (written === null) fail("NOT_SENT_HERE");
      const row = thread(id);
      changed(row.sessionId);
      return row;
    },

    /** After an agent's turn: threads sent before it began and still unanswered are marked no reply. */
    async turnEnded(bbThreadId: string) {
      const waiting = store.waitingOn(bbThreadId);
      if (!waiting.length) return;
      const started = await deps.threads.turnStart(bbThreadId).catch(() => null);
      if (started === null) return;
      const marked = store.markNoReply(waiting.filter(row => row.sentAt <= started));
      for (const sessionId of new Set(marked.map(row => row.sessionId))) changed(sessionId);
    },

    /**
     * Writes a comment's suggestion over its thread's lines in the working file, when the view's new side is the
     * working tree and the lines still read as they did; then resolves the thread.
     */
    async applySuggestion(threadId: string, commentId: string) {
      const row = thread(threadId);
      if (row.status !== "open") fail("NOT_OPEN");
      const owner = session(row.sessionId);
      const target = targetFromKey(owner.targetKey);
      if (!workingViews.has(target.kind) || row.side !== "new" || row.startLine === 0 || row.anchorContent === null) fail("NOT_WORKING_COPY");
      const comment = row.comments.find(item => item.id === commentId) ?? fail("NOT_FOUND");
      const block = bodyParts(comment.body).find(part => part.kind === "suggestion") ?? fail("NO_SUGGESTION");
      const copy = await copyOf(owner.copyId);
      const file = await deps.host.read(copy, row.filePath);
      // The new side of these views is the working file itself: the thread is placed against what it reads now.
      const place = placeThread(row, contentLines(file.text));
      if (place.state === "outdated") throw new Error("CHANGED");
      const next = replaceLines(file.text, place.startLine, place.endLine, row.anchorContent!, block.kind === "suggestion" ? block.code : "");
      if (next === null) fail("CHANGED");
      await deps.host.write(copy, row.filePath, file.sha256, next!);
      store.setStatus(row.id, "resolved");
      changed(row.sessionId);
    },
  };
}

export { targetFromKey } from "../../core/code-review/model.ts";
