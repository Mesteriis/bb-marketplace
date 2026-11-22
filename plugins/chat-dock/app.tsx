// BB Chat Dock — BB frontend entry.
//
// Compiled by `bb plugin build` into dist/app.js. This file is the BB
// adapter: it turns BB's slots, RPC and realtime into plain props for the
// host-agnostic page in src/ui.
import { useEffect, useMemo, useRef, useState } from "react";
import { definePluginApp, useRealtime, useRpc, type PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import { STATUS_CHANNEL, windowStatusSchema, type rpcContract } from "./contract.ts";
import type { WindowStatusView } from "./src/core/window-status.ts";
import { DockPage } from "./src/ui/dock-page.tsx";
import type { WindowApi } from "./src/ui/services.ts";

function ChatDockPanel(_props: PluginNavPanelProps) {
  const rpc = useRpc<typeof rpcContract>();
  const rpcRef = useRef(rpc);
  rpcRef.current = rpc;
  const [status, setStatus] = useState<WindowStatusView | null>(null);

  const chat = useMemo<WindowApi>(
    () => ({
      open: () => rpcRef.current.call("open", null).then((next) => (setStatus(next), next)),
      attach: (view) => {
        rpcRef.current.call("attach", view).catch(() => {});
      },
    }),
    [],
  );

  useEffect(() => {
    let cancelled = false;
    rpcRef.current.call("status", null).then(
      (next) => !cancelled && setStatus(next),
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, []);

  // Realtime payloads are parsed like any other untrusted input.
  useRealtime(STATUS_CHANNEL, (payload) => {
    const parsed = windowStatusSchema.safeParse(payload);
    if (parsed.success) setStatus(parsed.data);
  });

  return <DockPage chat={chat} status={status} />;
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "chat-dock",
    title: "ChatGPT",
    icon: "MessageSquare",
    path: "chat",
    component: ChatDockPanel,
  });
});
