import { experimental_copyToClipboard, type useBbNavigate, type useRpc } from "@get-bb/plugin-sdk/app";
import type { rpc } from "../adapters/bb/rpc.ts";
import type { Failure } from "../core/workspace.ts";
import type { CiApi } from "../ui/ci/ci-api.ts";
import type { HistoryApi } from "../ui/history/history-api.ts";

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
