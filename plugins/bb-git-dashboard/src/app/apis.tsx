import { experimental_copyToClipboard, experimental_ProviderModelPicker as ProviderModelPicker, Markdown, type useBbNavigate, type useRpc } from "@get-bb/plugin-sdk/app";
import type { rpc } from "../adapters/bb/rpc.ts";
import type { Failure } from "../core/workspace.ts";
import type { CiApi } from "../ui/ci/ci-api.ts";
import type { HistoryApi } from "../ui/history/history-api.ts";
import type { CodeReviewApi, ExecutionPickerProps } from "../ui/code-review/review-api.ts";

type Client = ReturnType<typeof useRpc<typeof rpc>>;
type Navigate = ReturnType<typeof useBbNavigate>;

/** A failed answer as an error; a rate limit keeps its `retryIn` so the page can count down and read again. */
export function failed(result: Failure): never {
  throw Object.assign(new Error(result.code + " · " + result.next), result.retryIn ? {retryIn: result.retryIn} : {});
}

/** The value of an `ok` answer without its envelope; a failure throws its code. */
export function okValue<T extends {ok: boolean}>(result: T): Omit<Extract<T, {ok: true}>, "ok"> {
  if (!result.ok) failed(result as unknown as Failure);
  const {ok: _ok, ...value} = result as Extract<T, {ok: true}>;
  return value;
}

/** The CI/CD section over RPC; shared by the Git panel and the thread's CI/CD tab. */
export function ciApi(client: Client, navigate: Navigate): CiApi {
  return {
    runs: async (copyId, filter, page) => okValue(await client.call("ciRuns", {copyId, filter, page})),
    run: async (copyId, runId) => okValue(await client.call("ciRun", {copyId, runId})),
    log: async (copyId, runId, jobId) => okValue(await client.call("ciLog", {copyId, runId, jobId})),
    workflows: async copyId => okValue(await client.call("ciWorkflows", {copyId})),
    form: async (copyId, workflowId, ref) => okValue(await client.call("ciForm", {copyId, workflowId, ref})),
    prepare: async (copyId, action) => okValue(await client.call("ciPrepare", {copyId, action})),
    confirm: async previewId => { okValue(await client.call("ciConfirm", {previewId})); },
    threads: async copyId => okValue(await client.call("ciThreads", {copyId})),
    ask: async (copyId, runId, jobId) => okValue(await client.call("ciAsk", {copyId, runId, jobId})),
    send: async (copyId, runId, jobId, threadIds, options = {}) => okValue(await client.call("ciSend", {copyId, runId, jobId, threadIds, ...options})),
    compose: async (copyId, runId, jobId) => {
      const {prompt, projectId, hostId} = okValue(await client.call("ciCompose", {copyId, runId, jobId}));
      navigate.toCompose({initialPrompt: prompt, focusPrompt: true, ...(projectId ? {projectId} : {}), ...(hostId ? {hostId} : {})});
    },
    overview: async () => okValue(await client.call("ciOverview", {})),
    subscribe: async (copyId, threadIds) => okValue(await client.call("ciSubscribe", {copyId, threadIds})),
    openThread: threadId => navigate.toThread(threadId),
    copy: text => experimental_copyToClipboard({text}),
    templates: async copyId => okValue(await client.call("ciTemplatesView", {copyId})),
    prepareTemplate: async request => okValue(await client.call("ciTemplatePrepare", request)),
    publishTemplate: async previewId => okValue(await client.call("publish", {previewId})).value,
  };
}

/** The History tab over RPC; shared by the Git panel and the thread's Git History tab. */
export function historyApi(client: Client): HistoryApi {
  return {
    page: async (copyId, offset) => okValue(await client.call("historyPage", {copyId, offset})).value,
    revision: async copyId => okValue(await client.call("historyRevision", {copyId})).revision,
    commit: async (copyId, hash) => okValue(await client.call("historyCommit", {copyId, hash})).value,
    patch: async (copyId, hash, path) => okValue(await client.call("historyPatch", {copyId, hash, path})),
  };
}

/** BB's own provider, model and reasoning picker, reading the catalog where the run would start. */
function ExecutionPicker({value, onChange, routing, disabled}: ExecutionPickerProps) {
  return <ProviderModelPicker value={value} onChange={onChange} routing={routing} disabled={disabled}/>;
}

const reviewerText = (note: {code: string; next: string} | null) => note ? "The reviewer was not asked: " + note.code + " · " + note.next : null;

/** The line review over RPC; shared by the Git panel and the thread's Review tab. */
export function codeReviewApi(client: Client, navigate: Navigate): CodeReviewApi {
  return {
    view: async (copyId, target, ignoreWhitespace, auto) => okValue(await client.call("reviewView", {copyId, target, ignoreWhitespace, auto: auto === true})),
    clear: async sessionId => okValue(await client.call("reviewClear", {sessionId})),
    commits: async copyId => okValue(await client.call("reviewCommits", {copyId})).commits,
    searchFiles: async (copyId, query) => okValue(await client.call("reviewSearchFiles", {copyId, query})),
    fileEntry: async (copyId, path) => okValue(await client.call("reviewFileEntry", {copyId, path})).file,
    revert: async (sessionId, path, revision, hunks) => { okValue(await client.call("reviewRevert", {sessionId, path, revision, hunks})); },
    viewState: async (scope, sessionId) => okValue(await client.call("reviewViewState", {scope, sessionId})).state,
    saveViewState: async (scope, sessionId, state) => { okValue(await client.call("reviewSaveViewState", {scope, sessionId, state})); },
    setViewed: async (sessionId, path, revision, viewed) => { okValue(await client.call("reviewSetViewed", {sessionId, path, revision, viewed})); },
    openFile: (hostId, path, line) => { navigate.experimental_openFilePreview({target: {kind: "host", hostId, path}, location: line ? {kind: "line", line, column: null} : null}); },
    patches: async (copyId, target, ignoreWhitespace, files) => okValue(await client.call("reviewPatches", {copyId, target, ignoreWhitespace, files})).files,
    watch: async copyId => { okValue(await client.call("reviewWatch", {copyId})); },
    createThread: async (sessionId, thread, viewer) => {
      const made = okValue(await client.call("reviewCreateThread", {sessionId, ...thread, viewerThreadId: viewer ?? null}));
      return {threadId: made.thread.id, reviewer: reviewerText(made.reviewer)};
    },
    addComment: async (threadId, body, viewer) =>
      ({reviewer: reviewerText(okValue(await client.call("reviewAddComment", {threadId, body, viewerThreadId: viewer ?? null})).reviewer)}),
    editComment: async (commentId, body) => { okValue(await client.call("reviewEditComment", {commentId, body})); },
    deleteComment: async commentId => { okValue(await client.call("reviewDeleteComment", {commentId})); },
    setStatus: async (threadId, status) => { okValue(await client.call("reviewSetStatus", {threadId, status})); },
    send: async (sessionId, threadId, threadIds, note) => okValue(await client.call("reviewSend", {sessionId, threadId, threadIds, note})),
    apply: async (threadId, commentId) => { okValue(await client.call("reviewApply", {threadId, commentId})); },
    targets: async copyId => okValue(await client.call("reviewTargets", {copyId})).threads,
    runDefaults: async (copyId, viewer) => okValue(await client.call("reviewRunDefaults", {copyId, viewerThreadId: viewer})),
    runs: async sessionId => okValue(await client.call("reviewRuns", {sessionId})).runs,
    startReview: async (sessionId, focuses, instructions, execution, viewer) =>
      okValue(await client.call("reviewStartReview", {sessionId, focuses, instructions, execution, viewerThreadId: viewer})).run,
    startSummary: async (sessionId, execution, viewer) => okValue(await client.call("reviewStartSummary", {sessionId, execution, viewerThreadId: viewer})).run,
    startExplain: async (sessionId, place, viewer) => okValue(await client.call("reviewStartExplain", {sessionId, ...place, viewerThreadId: viewer})).run,
    fix: async (sessionId, threadIds, note, execution, viewer) => okValue(await client.call("reviewFix", {sessionId, threadIds, note, execution, viewerThreadId: viewer})),
    closeRun: async runId => { okValue(await client.call("reviewCloseRun", {runId})); },
    ExecutionPicker,
    Markdown: ({content}) => <Markdown content={content}/>,
    openThread: threadId => navigate.toThread(threadId),
  };
}
