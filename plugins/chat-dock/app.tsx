// BB Chat Dock — BB frontend entry.
//
// Compiled by `bb plugin build` into dist/app.js. This file is the BB
// adapter: it turns BB's slots, RPC, realtime and clipboard into plain props
// for the host-agnostic page in src/ui.
import { useEffect, useMemo, useRef, useState } from "react";
import {
  definePluginApp,
  experimental_copyToClipboard,
  useRealtime,
  useRpc,
  type PluginNavPanelProps,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { STATUS_CHANNEL, windowStatusSchema, type rpcContract } from "./contract.ts";
import { createStaging } from "./src/core/staging.ts";
import { MAX_TEXT_LENGTH } from "./src/core/transfer.ts";
import type { WindowStatusView } from "./src/core/window-status.ts";
import { DockPage } from "./src/ui/dock-page.tsx";
import type { Notify, WindowApi } from "./src/ui/services.ts";

// One per loaded copy of the plugin, in memory only. The `lifetime` content
// script below clears it when the plugin's UI is taken down.
const staging = createStaging();

const notify: Notify = (kind, message) => {
  if (kind === "error") toast.error(message);
  else if (kind === "success") toast.success(message);
  else toast.info(message);
};

function ChatDockPanel(_props: PluginNavPanelProps) {
  const rpc = useRpc<typeof rpcContract>();
  const rpcRef = useRef(rpc);
  rpcRef.current = rpc;
  const [status, setStatus] = useState<WindowStatusView | null>(null);

  const window = useMemo<WindowApi>(
    () => ({
      open: () => rpcRef.current.call("open", null).then((next) => (setStatus(next), next)),
      propose: (text, source) => rpcRef.current.call("propose", { text, source }),
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

  const services = useMemo(
    () => ({ staging, window, copyText: (text: string) => experimental_copyToClipboard({ text }), notify }),
    [window],
  );
  return <DockPage services={services} status={status} />;
}

export default definePluginApp((app) => {
  // No DOM and no listeners: this exists for its disposer, which BB calls on
  // disable, stop, removal, a reload that replaces the bundle, and window
  // teardown. A reload of the same bundle keeps the open window's UI.
  app.contentScripts.register({
    id: "lifetime",
    mount: () => () => staging.clear(),
  });

  app.slots.navPanel({
    id: "chat-dock",
    title: "ChatGPT",
    icon: "MessageSquare",
    path: "chat",
    component: ChatDockPanel,
  });

  app.slots.messageAction({
    id: "stage-selection",
    title: "Вставить в ChatGPT…",
    icon: "MessageSquare",
    run({ threadId, selectedText }) {
      if (selectedText === undefined || selectedText.length === 0) {
        toast.info("Выделите текст в сообщении ассистента и выберите «Вставить в ChatGPT…» в меню выделения.");
        return;
      }
      if (selectedText.length > MAX_TEXT_LENGTH) {
        toast.error("Фрагмент длиннее 100 000 знаков. Выделите меньше.");
        return;
      }
      staging.stage({ text: selectedText, source: { kind: "message-selection", threadId } });
      toast.success("Фрагмент подготовлен. Откройте страницу ChatGPT в BB: там предпросмотр и передача в окно.");
    },
  });
});
