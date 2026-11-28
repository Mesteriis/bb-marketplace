// BB app entry: a lock in the thread composer, a window behind it, and the
// same window from the "+" menu where the compact layout hides composer actions.
import { useEffect, useRef, useState } from "react";
import {
  definePluginApp,
  experimental_useRpcMutation as useRpcMutation,
  experimental_useRpcQuery as useRpcQuery,
  useComposer,
} from "@get-bb/plugin-sdk/app";
import type { GuardView } from "../../core/service.ts";
import { GuardButton } from "../../ui/guard-button.tsx";
import { GuardPopup } from "../../ui/guard-popup.tsx";
import { rpcContract } from "./contract.ts";

const POPUP_ID = "secrets-guard";
/** The phrase hook writes the marker too, so the state is also polled. */
const POLL_MS = 30_000;

const UNKNOWN_STATE = "Состояние охраны неизвестно: сервер не ответил";

const seconds = () => Math.floor(Date.now() / 1000);

/** The current time, ticking once a second while something counts down. */
function useNow(ticking: boolean): number {
  const [now, setNow] = useState(seconds);
  useEffect(() => {
    if (!ticking) return;
    setNow(seconds());
    const timer = setInterval(() => setNow(seconds()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);
  return now;
}

/** The guard's state for the composer's thread, refreshed on writes and by polling. */
function useGuardView(): {
  threadId: string | null;
  view: GuardView | null;
  problem: string | null;
  now: number;
  refresh(): void;
} {
  const composer = useComposer();
  const threadId = composer.scope.kind === "thread" ? composer.scope.threadId : null;
  const query = useRpcQuery({
    contract: rpcContract,
    method: "state",
    input: { threadId: threadId ?? "-" },
    enabled: threadId !== null,
  });
  const refetch = useRef(query.refetch);
  refetch.current = query.refetch;
  useEffect(() => {
    if (threadId === null) return;
    const timer = setInterval(() => void refetch.current(), POLL_MS);
    return () => clearInterval(timer);
  }, [threadId]);
  // A failed read means the state is unknown: data kept from before the failure is not shown as current.
  const failed = threadId !== null && query.error !== null;
  const view = threadId === null || failed ? null : (query.data ?? null);
  const now = useNow(view?.effective != null);
  return { threadId, view, problem: failed ? UNKNOWN_STATE : null, now, refresh: () => void refetch.current() };
}

function ComposerLock() {
  const composer = useComposer();
  const { view, problem, now } = useGuardView();
  return <GuardButton view={view} now={now} problem={problem} onOpen={() => composer.experimental_openPopup(POPUP_ID)} />;
}

function ComposerGuardPopup() {
  const { threadId, view, problem, now, refresh } = useGuardView();
  const open = useRpcMutation({ contract: rpcContract, method: "open" });
  const close = useRpcMutation({ contract: rpcContract, method: "close" });
  const error = open.error?.message ?? close.error?.message ?? problem;

  // A refusal lands in the mutation's `error`; the rejection itself needs no second report.
  const settle = (request: Promise<unknown>) => void request.then(refresh, refresh);

  return (
    <GuardPopup
      view={view}
      now={now}
      busy={open.isPending || close.isPending}
      error={error}
      onOpen={(scope, minutes) => {
        if (threadId === null) return;
        close.reset();
        settle(open.mutate({ threadId, scope, minutes }));
      }}
      onClose={() => {
        if (threadId === null) return;
        open.reset();
        settle(close.mutate({ threadId }));
      }}
    />
  );
}

export default definePluginApp((app) => {
  app.composer.customize({
    id: "secrets-guard",
    scopes: ["thread"],
    actions: [{ id: "toggle", component: ComposerLock }],
    plusMenu: [
      {
        id: "secrets",
        label: "Секреты…",
        icon: "Lock",
        description: "Открыть или закрыть охрану секретов",
        run({ composer }) {
          composer.experimental_openPopup(POPUP_ID);
        },
      },
    ],
    experimental_popups: [{ id: POPUP_ID, label: "Секреты", component: ComposerGuardPopup }],
  });
});
