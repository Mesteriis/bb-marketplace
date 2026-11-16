// Remote Hub — BB frontend entry.
//
// Compiled by bb plugin build into dist/app.js + dist/app.css. React and
// @get-bb/plugin-sdk/app are provided by the BB app at load time, so this
// file must be loaded by BB, not imported directly.
import { useCallback } from "react";
import { definePluginApp, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server.ts";
import type { SessionHandle } from "./src/core/rpc.ts";
import { RemoteHubPage } from "./src/ui/remote-hub-page.tsx";

function RemoteHubTab() {
  const rpc = useRpc<typeof rpcContract>();

  const loadStatus = useCallback(() => rpc.call("helper_status"), [rpc]);

  const onOpen = useCallback(async () => {
    const handle = await rpc.call("echo_open", { cols: 80, rows: 24 });
    return handle as SessionHandle;
  }, [rpc]);

  const onInput = useCallback(
    async (handle: SessionHandle, data: string) => rpc.call("echo_input", { generation: handle.generation, sessionId: handle.sessionId, data }),
    [rpc],
  );

  const onClose = useCallback(
    async (handle: SessionHandle) => {
      await rpc.call("echo_close", { generation: handle.generation, sessionId: handle.sessionId });
    },
    [rpc],
  );

  return <RemoteHubPage loadStatus={loadStatus} onOpen={onOpen} onInput={onInput} onClose={onClose} />;
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "remote-hub",
    title: "Remote Hub",
    icon: "Terminal",
    path: "remote-hub",
    component: RemoteHubTab,
  });
});
