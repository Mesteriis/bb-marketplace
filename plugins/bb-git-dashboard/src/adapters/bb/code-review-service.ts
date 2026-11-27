import { placeThread, type Placement } from "../../core/code-review/anchors.ts";
import type { ReviewDiff } from "../../core/code-review/diff.ts";
import { ANCHOR_MAX_CHARS, BODY_MAX_CHARS, GENERAL_PATH, targetKey, targetSchema, type Severity, type Side, type Target, type TargetRequest } from "../../core/code-review/model.ts";
import { contentLines, parsePatchLines } from "../../core/code-review/patch-lines.ts";
import { sendPrompt } from "../../core/code-review/prompt.ts";
import { bodyParts, replaceLines } from "../../core/code-review/suggestion.ts";
import type { Copy } from "../../core/workspace.ts";
import type { ReviewStore } from "./review-store.ts";

export type CodeReviewDeps = {
  store: ReviewStore;
  copy(copyId: string): Promise<Copy | undefined>;
  /** Git on the copy's host; each throws its code. */
  host: {
    diff(copy: Copy, target: TargetRequest, ignoreWhitespace: boolean): Promise<{value: ReviewDiff; target: Target}>;
    read(copy: Copy, path: string): Promise<{text: string; sha256: string}>;
    write(copy: Copy, path: string, expected: string, text: string): Promise<{sha256: string}>;
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

/** Views whose new side is the working tree, where a suggestion can be written. */
const workingViews = new Set<Target["kind"]>(["uncommitted", "unstaged", "all"]);
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
      let {value, target} = await deps.host.diff(copy, request, ignoreWhitespace);
      if (auto && request.kind === "uncommitted" && value.files.length === 0) {
        // A copy without a base branch has no branch view: the uncommitted one stands.
        const branch = await deps.host.diff(copy, {kind: "branch"}, ignoreWhitespace).catch(() => null);
        if (branch && branch.value.files.length > 0) ({value, target} = branch);
      }
      const key = targetKey(targetSchema.parse(target));
      const {id: sessionId} = store.session(copy.id, key);
      const files = new Map(value.files.flatMap(file => file.patch === null ? [] : [[file.path, parsePatchLines(file.patch)] as const]));
      const threads = store.threads(sessionId);
      const placements: Record<string, Placement> = Object.fromEntries(threads.map(row => [row.id,
        placeThread(row, value.files.some(file => file.path === row.filePath) ? files.get(row.filePath) ?? {old: new Map(), new: new Map()} : undefined)]));
      return {sessionId, target, ...value, threads, placements};
    },
    threads: (sessionId: string) => store.threads(sessionId),

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
    createAgentThread(sessionId: string, input: Omit<NewThreadInput, "anchorContent"> & {anchorContent: string | null}, authorName: string) {
      session(sessionId);
      const made = store.createThread({sessionId, filePath: input.filePath, side: input.side, startLine: input.startLine, endLine: input.endLine,
        severity: input.severity, anchorContent: input.anchorContent, body: text(input.body)}, {type: "agent", name: authorName});
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

/** A session's view from its key, when no view was read since the server started. */
export function targetFromKey(key: string): Target {
  if (key === "uncommitted" || key === "staged" || key === "unstaged") return {kind: key};
  const [kind, rest] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
  if (kind === "branch" || kind === "all") return {kind, base: rest};
  if (kind === "commit") return {kind, sha: rest};
  const symmetric = rest.includes("...");
  const [from, to] = rest.split(symmetric ? "..." : "..");
  return {kind: "range", from, to, symmetric};
}
