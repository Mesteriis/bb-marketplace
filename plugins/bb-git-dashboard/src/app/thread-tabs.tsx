import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useBbNavigate, useRealtime, useRpc, useSettings, type PluginAppSlots, type PluginThreadActionRegistration } from "@get-bb/plugin-sdk/app";
import type { rpc } from "../adapters/bb/rpc.ts";
import type { Copy } from "../core/workspace.ts";
import { CiPanel } from "../ui/ci/ci-panel.tsx";
import { HistoryPanel } from "../ui/history/history-panel.tsx";
import { ciApi, codeReviewApi, historyApi } from "./apis.tsx";
import { ReviewPanel } from "../ui/code-review/review-panel.tsx";

const signal = "git-workspace-changed";
/** The thread's Git History tab; also what the header shortcut opens. */
export const historyTab = {id: "git-history", context: {kind: "thread"}, availability: "action"} as const;
export const ciTab = {id: "git-ci", context: {kind: "thread"}, availability: "action"} as const;
export const reviewTab = {id: "git-review", context: {kind: "thread"}, availability: "action"} as const;

/** The working copy attached to the thread's environment, or why there is none. */
function useThreadCopy(threadId: string) {
  const client = useRpc<typeof rpc>();
  const [state, setState] = useState<{copy: Copy} | {problem: string}>();
  const refresh = useCallback(() => {
    client.call("context", {threadId}).then(result => setState(result.ok ? {copy: result.copy} : {problem: result.code}),
      () => setState({problem: "HOST_UNAVAILABLE"}));
  }, [client, threadId]);
  useEffect(refresh, [refresh]);
  useRealtime(signal, refresh);
  return {client, state};
}

function ThreadFrame({state, children}: {state: ReturnType<typeof useThreadCopy>["state"]; children(copy: Copy): ReactNode}) {
  return <div className="git-ws"><div className="git-section">
    {!state ? <p className="git-muted" role="status">Reading thread environment…</p>
      : "problem" in state ? <p className="git-muted">{state.problem} · Attach this thread’s working copy from the Git panel first.</p>
      : children(state.copy)}
  </div></div>;
}

/** The commit graph of the thread's working copy, as a thread panel tab. */
export function ThreadHistory({threadId}: {threadId: string}) {
  const {client, state} = useThreadCopy(threadId);
  const api = useMemo(() => historyApi(client), [client]);
  const graph = useSettings().values?.historyGraph !== false;
  return <ThreadFrame state={state}>{copy => <HistoryPanel key={copy.id} api={api} copyId={copy.id} graph={graph}/>}</ThreadFrame>;
}

/** CI/CD of the thread's working copy, as a thread panel tab; a run can be sent to this very thread. */
export function ThreadCi({threadId}: {threadId: string}) {
  const {client, state} = useThreadCopy(threadId);
  const navigate = useBbNavigate();
  const api = useMemo(() => ciApi(client, navigate), [client, navigate]);
  return <ThreadFrame state={state}>{copy => <CiPanel key={copy.id} api={api} copyId={copy.id} currentThreadId={threadId}/>}</ThreadFrame>;
}

/** The line review of the thread's working copy; comments are sent to this very thread. */
export function ThreadReview({threadId}: {threadId: string}) {
  const {client, state} = useThreadCopy(threadId);
  const navigate = useBbNavigate();
  const api = useMemo(() => codeReviewApi(client, navigate), [client, navigate]);
  const [revision, setRevision] = useState(0);
  useRealtime("code-review-changed", useCallback(() => setRevision(value => value + 1), []));
  return <ThreadFrame state={state}>{copy => <ReviewPanel key={copy.id} api={api} copyId={copy.id} currentThreadId={threadId} revision={revision}/>}</ThreadFrame>;
}

const headerShortcut: PluginThreadActionRegistration<boolean> = {
  id: "git-history-header", title: "Git History", icon: "GitBranch", group: "git", placement: "header",
  useData: () => useSettings().values?.historyHeaderShortcut === true,
  item: ({data, experimental_panel}) => data ? {
    label: "Git History", icon: "GitBranch",
    run: () => { experimental_panel.openTab({tab: historyTab, title: "Git History"}); },
  } : null,
};

/** The Git History button in the thread header, shown when the historyHeaderShortcut setting is on. */
export function registerHistoryShortcut(slots: PluginAppSlots) {
  slots.experimental_threadAction(headerShortcut);
}
