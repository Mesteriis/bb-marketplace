// Remote Hub — BB frontend entry.
//
// Compiled by bb plugin build into dist/app.js + dist/app.css. React and
// @get-bb/plugin-sdk/app are provided by the BB app at load time, so this
// file must be loaded by BB, not imported directly.
import { useCallback, useEffect, useState } from "react";
import { definePluginApp, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server.ts";
import { RemoteHubPanel, type RemoteHubViewState } from "./src/ui/remote-hub-panel.tsx";

function RemoteHubPage() {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<RemoteHubViewState>({ kind: "loading" });
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    rpc
      .call("helper_status")
      .then((status) => {
        if (!cancelled) setState({ kind: "ready", status });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({ kind: "error", message: error instanceof Error ? error.message : String(error) });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [rpc, refresh]);

  const onOpen = useCallback(async () => {
    const result = await rpc.call("echo_open", { cols: 80, rows: 24 });
    return result.sessionId;
  }, [rpc]);

  const onInput = useCallback(
    async (sessionId: number, data: string) => rpc.call("echo_input", { sessionId, data }),
    [rpc],
  );

  const onClose = useCallback(
    async (sessionId: number) => {
      await rpc.call("echo_close", { sessionId });
      setRefresh((n) => n + 1);
    },
    [rpc],
  );

  return <RemoteHubPanel state={state} onOpen={onOpen} onInput={onInput} onClose={onClose} />;
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "remote-hub",
    title: "Remote Hub",
    icon: "Terminal",
    path: "remote-hub",
    component: RemoteHubPage,
  });
});
