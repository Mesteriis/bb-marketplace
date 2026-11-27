/**
 * AI runs of the line review: threads the plugin starts in the reviewed working copy, visible in BB's sidebar so
 * the owner can watch, steer and approve them. Follows diff-review's RunService (MIT, gpambrozio); see
 * THIRD_PARTY_NOTICES.md.
 *
 * - review: an AI review with optional focuses, leaving comments with `git_review_comment`. BB cannot make a thread
 *   read-only, so the copy's uncommitted changes are fingerprinted before and after and the files it changed are
 *   listed on the run. The latest open review run of a view is its reviewer: an owner's comment with @reviewer goes
 *   to its thread as a new turn, or starts one.
 * - summary and explain: a review run's cousins that leave one comment.
 * - fix: "Fix in a new thread", the chosen threads sent to a new thread instead of an existing one.
 *
 * A run's thread starts in the thread under review's environment when that thread works on the copy, else on the
 * copy's path in its BB project. Rights come from the store (`agentMay`), never from the thread's metadata.
 */
import type { ReviewDiff } from "../../core/code-review/diff.ts";
import { mentionsReviewer } from "../../core/code-review/mentions.ts";
import { describeLocation, GENERAL_PATH, type Execution, type ReviewRun, type ReviewThread, type RunKind, type Severity, type Side,
  type Target, type TargetRequest } from "../../core/code-review/model.ts";
import { linesText, parsePatchLines } from "../../core/code-review/patch-lines.ts";
import { explainPrompt, fixPrompt, reviewerPrompt, reviewPrompt, summaryPrompt, type RangeCommits } from "../../core/code-review/run-prompts.ts";
import { changedFiles, fingerprint, ranges, readsOnly, reasoningLevel, runPermissionMode, spawnPermissionMode, SUMMARY_MAX_CHARS,
  type RunPermissionMode } from "../../core/code-review/runs.ts";
import { RUN_METADATA_KEY } from "../../core/code-review/tool-names.ts";
import { CodedError, type Copy } from "../../core/workspace.ts";
import { pendingRunThread, type RunStore } from "./review-run-store.ts";
import { targetFromKey, type codeReviewService } from "./code-review-service.ts";
import type { ReviewStore } from "./review-store.ts";

/** Where BB reads providers and starts a run's thread: the reviewed thread's environment, or the copy's host. */
export type RunPlace = {environmentId: string; projectId: string; parentThreadId: string} | {hostId: string; projectId: string; path: string};
export type RunSettings = {aiProvider: string; aiModel: string; aiPermissionMode: string};
export type SpawnRequest = {projectId: string; title: string; prompt: string; place: RunPlace; execution: Execution;
  /** Leave the reasoning to the provider's default: a question to the reviewer has no picker. */
  providerReasoning: boolean; permissionMode: RunPermissionMode | "full"; runId: string};
export type ModelOption = {id: string; model: string; isDefault: boolean; defaultReasoningEffort: string};

export type RunDeps = {
  store: ReviewStore;
  runs: RunStore;
  review: Pick<ReturnType<typeof codeReviewService>, "createAgentThread">;
  copy(copyId: string): Promise<Copy | undefined>;
  /** The view's diff on the copy's host; throws its code. */
  diff(copy: Copy, target: TargetRequest): Promise<{value: ReviewDiff; target: Target}>;
  settings(): Promise<RunSettings>;
  bb: {
    thread(threadId: string): Promise<{environmentId: string | null; originPluginId: string | null}>;
    metadata(threadId: string): Promise<Record<string, unknown>>;
    /** Starts the thread and gives its id. */
    spawn(request: SpawnRequest): Promise<string>;
    send(threadId: string, text: string): Promise<void>;
    archive(threadId: string): Promise<void>;
    /** The provider's models where the run would start, or why there are none. */
    models(place: RunPlace, providerId: string): Promise<{models: ModelOption[]; error: string | null}>;
    /** The permission modes the provider supports there; null when BB does not say. */
    permissionModes(place: RunPlace, providerId: string): Promise<readonly string[] | null>;
    turnStart(threadId: string): Promise<number | null>;
    providerName(threadId: string): Promise<string>;
  };
  threadCopy(threadId: string): Promise<string | null>;
  pluginId: string;
  changed(copyId: string): void;
  log(message: string): void;
};
export type AgentCommentInput = {filePath: string; side: Side | null; startLine: number; endLine: number; severity: Severity | null; body: string};

const fail = (code: string): never => { throw new Error(code); };
const FALLBACK_PROVIDER = "claude-code";
const plural = (count: number, word: string) => count + " " + word + (count === 1 ? "" : "s");

export function codeReviewRuns(deps: RunDeps) {
  const {store, runs} = deps;
  /** Each view's latest question to its reviewer: the next waits for it, so two never race. */
  const asking = new Map<string, Promise<unknown>>();

  function session(sessionId: string) {
    return store.sessionById(sessionId) ?? fail("NOT_FOUND");
  }
  const changed = (sessionId: string) => { const found = store.sessionById(sessionId); if (found) deps.changed(found.copyId); };

  /** The reviewed thread's environment when it works on the copy, else the copy's path in its project. */
  async function placeOf(copy: Copy, threadId: string | null): Promise<RunPlace> {
    if (threadId !== null && await deps.threadCopy(threadId).catch(() => null) === copy.id) {
      const thread = await deps.bb.thread(threadId).catch(() => null);
      if (thread?.environmentId && copy.projectId) return {environmentId: thread.environmentId, projectId: copy.projectId, parentThreadId: threadId};
    }
    if (!copy.projectId) fail("RUN_PLACE_REQUIRED");
    return {hostId: copy.hostId, projectId: copy.projectId!, path: copy.root};
  }

  /** The view as the host reads it now, with the commits a range compares. */
  async function view(sessionId: string) {
    const owner = session(sessionId);
    const copy = await deps.copy(owner.copyId) ?? fail("NOT_FOUND");
    const target = targetFromKey(owner.targetKey);
    const commits: RangeCommits | null = target.kind === "range" ? await deps.diff(copy, target).then(({value}) =>
      value.baseSha && value.headSha ? {baseSha: value.baseSha, headSha: value.headSha} : null) : null;
    return {owner, copy, target, commits};
  }

  async function copyFingerprint(copy: Copy) {
    return fingerprint((await deps.diff(copy, {kind: "uncommitted"})).value);
  }

  async function settingsExecution(): Promise<Execution> {
    const settings = await deps.settings();
    return {providerId: settings.aiProvider.trim() || FALLBACK_PROVIDER, model: settings.aiModel.trim(), reasoningLevel: "medium"};
  }

  /**
   * Starts a run's thread so that no call of it finds the run without its rights: the row and the sends of the
   * threads it answers (`grants`) are written before BB is asked, pointing at `pendingRunThread` until BB names the
   * thread. A thread that calls in first is bound by its metadata (`bindIfPending`). A run closed while BB started
   * it has its thread archived at once; a start that fails leaves a failed run saying why, with its sends taken back.
   */
  async function spawn(input: {sessionId: string; copy: Copy; threadId: string | null; kind: RunKind; focus: string | null;
    execution: Execution | null; title: string; prompt: string; grants?: {threadIds: readonly string[]; note: string}}): Promise<ReviewRun> {
    const known = input.execution;
    const place = await placeOf(input.copy, input.threadId);
    const run = runs.create({sessionId: input.sessionId, kind: input.kind, focus: input.focus, providerId: known?.providerId ?? "",
      model: known?.model || null, parentThreadId: "parentThreadId" in place ? place.parentThreadId : null, baseline: null});
    const grant = input.grants ? store.recordSend(input.sessionId, pendingRunThread(run.id), input.grants.threadIds, input.grants.note) : null;
    try {
      const execution = known ?? await settingsExecution();
      const permissionMode = spawnPermissionMode(runPermissionMode((await deps.settings()).aiPermissionMode),
        await deps.bb.permissionModes(place, execution.providerId).catch(() => null));
      const baseline = readsOnly(input.kind) ? JSON.stringify(await copyFingerprint(input.copy)) : null;
      runs.prepare(run.id, {baseline, providerId: execution.providerId, model: execution.model || null,
        parentThreadId: "parentThreadId" in place ? place.parentThreadId : null});
      if (runs.run(run.id)?.status === "closed") {
        if (grant) store.dropSend(grant.id);
        changed(input.sessionId);
        return runs.run(run.id)!;
      }
      const threadId = await deps.bb.spawn({projectId: place.projectId, title: input.title, prompt: input.prompt, place, execution,
        providerReasoning: known === null, permissionMode, runId: run.id});
      runs.bind(run.id, threadId);
      if (runs.run(run.id)?.status === "closed") await archive(threadId);
    } catch (error) {
      if (grant) store.dropSend(grant.id);
      const code = error instanceof Error ? error.message : String(error);
      runs.finish(run.id, "failed", "Could not start the thread: " + code.slice(0, 500), null);
    }
    changed(input.sessionId);
    return runs.run(run.id)!;
  }

  async function archive(threadId: string) {
    // The owner may have archived or deleted it already; the run closes either way.
    await deps.bb.archive(threadId).catch(error => deps.log("Could not archive " + threadId + ": " + String(error)));
  }

  function openThreads(sessionId: string, ids: readonly string[]) {
    const chosen = store.threads(sessionId).filter(row => ids.includes(row.id) && row.status === "open");
    if (!chosen.length) fail("NOTHING_TO_SEND");
    return chosen;
  }

  /** Queues the thread as a new turn of the view's reviewer, or starts a reviewer when the view has none. */
  async function sendToReviewer(reviewThreadId: string, viewerThreadId: string | null): Promise<ReviewRun | null> {
    const asked = store.thread(reviewThreadId) ?? fail("NOT_FOUND");
    const reviewer = runs.reviewer(asked.sessionId);
    // A question still queued behind a turn the reviewer has not started is read by that turn: not sent again.
    if (reviewer?.threadId && asked.delivery?.state === "sent" && asked.delivery.threadId === reviewer.threadId) {
      const started = await deps.bb.turnStart(reviewer.threadId).catch(() => null);
      if (started !== null && asked.delivery.sentAt > started) return null;
    }
    const {copy, target, commits} = await view(asked.sessionId);
    const thread = store.thread(reviewThreadId) ?? fail("NOT_FOUND");
    if (reviewer?.threadId && runs.run(reviewer.id)?.status !== "closed") {
      const send = store.recordSend(thread.sessionId, reviewer.threadId, [thread.id], "");
      try {
        await deps.bb.send(reviewer.threadId, reviewerPrompt(target, thread, true, commits));
        runs.restart(reviewer.id);
        changed(thread.sessionId);
        return runs.run(reviewer.id);
      } catch (error) {
        // Its thread is gone (archived or deleted outside the review): that run closes and a new one starts.
        store.dropSend(send.id);
        runs.close(reviewer.id);
        deps.log("Reviewer run " + reviewer.id + " could not take a question (" + String(error) + "); starting a new one.");
      }
    }
    return spawn({sessionId: thread.sessionId, copy, threadId: viewerThreadId, kind: "review", focus: null, execution: null,
      title: "Reviewer: " + describeLocation(thread), prompt: reviewerPrompt(target, thread, false, commits),
      grants: {threadIds: [thread.id], note: ""}});
  }

  /** The lines a comment on `path` may be on: the view's patch of that file, as the host reads it now. */
  async function linesOf(sessionId: string, path: string) {
    const owner = session(sessionId);
    const copy = await deps.copy(owner.copyId) ?? fail("NOT_FOUND");
    const {value} = await deps.diff(copy, targetFromKey(owner.targetKey));
    const file = value.files.find(item => item.path === path);
    if (!file) {
      const shown = value.files.slice(0, 40).map(item => item.path);
      throw new CodedError("FILE_NOT_IN_DIFF", "Files in the diff: " + (shown.join(", ") || "none") + (value.files.length > shown.length ? ", …" : "") + ".");
    }
    if (file.patch === null) throw new CodedError("LINE_NOT_IN_DIFF", path + " has no line diff here (binary or too large); comment on the whole file with startLine 0.");
    return parsePatchLines(file.patch);
  }

  /** Asks the view's reviewer about a thread, one question per view at a time. */
  function askReviewer(reviewThreadId: string, viewerThreadId: string | null = null): Promise<ReviewRun | null> {
    const {sessionId} = store.thread(reviewThreadId) ?? fail("NOT_FOUND");
    const next = (asking.get(sessionId) ?? Promise.resolve()).catch(() => undefined).then(() => sendToReviewer(reviewThreadId, viewerThreadId));
    asking.set(sessionId, next);
    void next.finally(() => { if (asking.get(sessionId) === next) asking.delete(sessionId); }).catch(() => undefined);
    return next;
  }

  return {
    /** Where the run pickers start: the settings' provider and model when it lists that model, else its default. */
    async defaults(copyId: string, threadId: string | null) {
      const settings = await deps.settings();
      const permissionMode = runPermissionMode(settings.aiPermissionMode);
      const copy = await deps.copy(copyId) ?? fail("NOT_FOUND");
      let place: RunPlace;
      try { place = await placeOf(copy, threadId); }
      catch { return {execution: null, message: "Attach this working copy to a BB project to start AI runs.", permissionMode, place: null}; }
      const providerId = settings.aiProvider.trim() || FALLBACK_PROVIDER;
      const options = await deps.bb.models(place, providerId);
      const routing = "environmentId" in place ? {kind: "environment" as const, environmentId: place.environmentId} : {kind: "host" as const, hostId: place.hostId};
      if (options.error !== null) return {execution: null, message: options.error, permissionMode, place: routing};
      const wanted = settings.aiModel.trim();
      const model = options.models.find(entry => wanted !== "" && (entry.model === wanted || entry.id === wanted))
        ?? options.models.find(entry => entry.isDefault) ?? options.models[0];
      if (!model) return {execution: null, message: providerId + " lists no models here.", permissionMode, place: routing};
      return {execution: {providerId, model: model.model, reasoningLevel: reasoningLevel(model.defaultReasoningEffort)} satisfies Execution,
        message: null, permissionMode, place: routing};
    },

    /** The runs of a view not yet closed, newest first. */
    list: (sessionId: string) => runs.open(session(sessionId).id),

    async startReview(input: {sessionId: string; threadId: string | null; focuses: readonly string[]; instructions: string; execution: Execution}) {
      const {owner, copy, target, commits} = await view(input.sessionId);
      const focus = input.focuses.length ? input.focuses.join(", ") : null;
      return spawn({sessionId: owner.id, copy, threadId: input.threadId, kind: "review", focus, execution: input.execution,
        title: "Review: " + (focus ?? "changes"), prompt: reviewPrompt({target, commits, focus, instructions: input.instructions})});
    },

    async startSummary(input: {sessionId: string; threadId: string | null; execution: Execution}) {
      const {owner, copy, target, commits} = await view(input.sessionId);
      return spawn({sessionId: owner.id, copy, threadId: input.threadId, kind: "summary", focus: null, execution: input.execution,
        title: "Summary of the changes", prompt: summaryPrompt(target, commits)});
    },

    /** Explains a file (`startLine` 0) or lines of it, with the settings' provider and model. */
    async startExplain(input: {sessionId: string; threadId: string | null; filePath: string; side: Side | null; startLine: number; endLine: number; code: string | null}) {
      const {owner, copy, target, commits} = await view(input.sessionId);
      const place = {filePath: input.filePath, side: input.startLine === 0 ? null : input.side ?? "new" as const, startLine: input.startLine,
        endLine: Math.max(input.endLine, input.startLine), code: input.code};
      const lines = place.startLine === 0 ? "" : place.startLine === place.endLine ? ":" + place.startLine : ":" + place.startLine + "-" + place.endLine;
      return spawn({sessionId: owner.id, copy, threadId: input.threadId, kind: "explain", focus: place.filePath + lines, execution: null,
        title: "Explain " + (place.filePath.split("/").pop() ?? place.filePath) + lines, prompt: explainPrompt(target, place, commits)});
    },

    /** Sends open comment threads to a new thread on the same copy. */
    async fixInNewThread(input: {sessionId: string; threadId: string | null; threadIds: readonly string[]; note: string; execution: Execution}) {
      const {owner, copy, target} = await view(input.sessionId);
      const chosen = openThreads(owner.id, input.threadIds);
      const run = await spawn({sessionId: owner.id, copy, threadId: input.threadId, kind: "fix", focus: null, execution: input.execution,
        title: "Review fixes: " + plural(chosen.length, "comment"), prompt: fixPrompt({target, threads: chosen, note: input.note}),
        grants: {threadIds: chosen.map(row => row.id), note: input.note}});
      return {run, count: chosen.length};
    },

    /**
     * An owner's comment with @reviewer or @agent asks the view's reviewer, in the background. Returns the code of why
     * no reviewer can start, or null.
     */
    async onUserComment(thread: ReviewThread, body: string, viewerThreadId: string | null): Promise<string | null> {
      if (!mentionsReviewer(body)) return null;
      // A reviewer that cannot start says why at once, for the comment that asked; the start itself runs in the background.
      if (!runs.reviewer(thread.sessionId)?.threadId) {
        const copy = await deps.copy(session(thread.sessionId).copyId);
        if (!copy) return "NOT_FOUND";
        const refused = await placeOf(copy, viewerThreadId).then(() => null, (error: unknown) => error instanceof Error ? error.message : "RUN_PLACE_REQUIRED");
        if (refused) return refused;
      }
      askReviewer(thread.id, viewerThreadId).catch(error => deps.log("Could not ask the reviewer about " + thread.id + ": " + String(error)));
      return null;
    },

    askReviewer,

    /** Closes a run: it loses its rights first, then its thread is archived. */
    async close(runId: string) {
      const run = runs.run(runId) ?? fail("UNKNOWN_RUN");
      const wasOpen = run.status !== "closed";
      runs.close(run.id);
      changed(run.sessionId);
      if (wasOpen && run.threadId) await archive(run.threadId);
    },

    /**
     * A run thread's turn ended: its running runs are done (or failed) with the agent's last words, unless a question
     * is still queued for it. The review service's `turnEnded` goes first and marks what this turn left unanswered.
     */
    async turnEnded(threadId: string, lastText: string | null, failed: boolean) {
      if (!failed && store.waitingOn(threadId).length > 0) return;
      for (const run of runs.ofThread(threadId).filter(row => row.status === "running")) {
        let files: string[] | null = null;
        const baseline = runs.baseline(run.id);
        if (readsOnly(run.kind) && baseline !== null) {
          const copy = await deps.copy(session(run.sessionId).copyId).catch(() => undefined);
          if (copy) files = await copyFingerprint(copy).then(after => changedFiles(JSON.parse(baseline) as Record<string, string>, after), () => null);
        }
        runs.finish(run.id, failed ? "failed" : "done", lastText === null ? null : lastText.slice(0, SUMMARY_MAX_CHARS), files);
        changed(run.sessionId);
      }
    },

    /**
     * An AI run's comment, from an open review, summary or explain run's thread only. Lines must be shown in the
     * view's diff on that side; a refusal says which are, so the agent can retry.
     */
    async addComment(callerThreadId: string, input: AgentCommentInput) {
      const run = runs.ofThread(callerThreadId).find(row => readsOnly(row.kind)) ?? fail("NOT_A_REVIEW_RUN");
      if (!input.body.trim()) fail("INVALID_INPUT");
      let anchorContent: string | null = null;
      let place = input;
      if (input.filePath !== GENERAL_PATH) {
        const lines = await linesOf(run.sessionId, input.filePath);
        if (input.startLine > 0) {
          const side = input.side ?? "new";
          const endLine = Math.max(input.endLine, input.startLine);
          anchorContent = linesText(lines, side, input.startLine, endLine);
          if (anchorContent === null) throw new CodedError("LINE_NOT_IN_DIFF", "Lines " + input.startLine + "-" + endLine + " of " + input.filePath
            + " are not all shown on the " + side + " side of the diff. Lines shown there: " + (ranges([...lines[side].keys()]) || "none") + ".");
          place = {...input, side, endLine};
        } else place = {...input, side: null, endLine: 0};
      } else place = {...input, side: null, startLine: 0, endLine: 0};
      const authorName = await deps.bb.providerName(callerThreadId).catch(() => "Agent");
      // The reads above awaited BB: the run may have been closed meanwhile.
      if (!runs.ofThread(callerThreadId).some(row => row.id === run.id)) fail("NOT_A_REVIEW_RUN");
      return deps.review.createAgentThread(run.sessionId, {...place, anchorContent}, authorName);
    },

    /**
     * Binds a thread that calls in before `spawn` recorded it: BB stamped it as this plugin's (`originPluginId`, set
     * at creation) and its metadata names a run still waiting for its thread. The metadata alone proves nothing.
     */
    async bindIfPending(threadId: string | undefined) {
      if (!threadId || !runs.hasUnbound() || runs.isRunThread(threadId)) return;
      try {
        const thread = await deps.bb.thread(threadId);
        if (thread.originPluginId !== deps.pluginId) return;
        const runId = (await deps.bb.metadata(threadId))[RUN_METADATA_KEY];
        if (typeof runId === "string" && /^[0-9a-f]{12}$/.test(runId)) runs.bind(runId, threadId);
      } catch (error) {
        deps.log("Could not check whether " + threadId + " is a run starting up: " + String(error));
      }
    },

    /** Whether runs were started under this thread, closed ones included: BB may still report them there. */
    hasChildren: (threadId: string) => runs.hasChildren(threadId),
  };
}
