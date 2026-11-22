// BB Chat Dock — BB frontend entry.
//
// Compiled by `bb plugin build` into dist/app.js. This file is the BB
// adapter: it turns BB's slots, navigation, clipboard and Browser page access
// into plain props for the host-agnostic screens in src/ui.
import { useCallback, useMemo } from "react";
import {
  definePluginApp,
  experimental_copyToClipboard,
  useBbNavigate,
  type ExperimentalPluginBrowserToolbarActionProps,
  type PluginNavPanelProps,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { createConsent } from "./src/core/consent.ts";
import { createStaging } from "./src/core/staging.ts";
import { CHATGPT_ORIGIN } from "./src/core/target.ts";
import { MAX_TEXT_LENGTH, type PagePort } from "./src/core/transfer.ts";
import { DockPage } from "./src/ui/dock-page.tsx";
import type { DockServices } from "./src/ui/services.ts";
import { ToolbarAction } from "./src/ui/toolbar-action.tsx";

declare const __BB_PLUGIN_ID__: string | undefined;

// One per loaded copy of the plugin, in memory only. BB may keep this module
// across a disable or a reload, so the `lifetime` content script below clears
// the staged text and turns the embedded mode off when the plugin's UI is
// taken down.
const services: DockServices = {
  staging: createStaging(),
  consent: createConsent(),
  copyText: (text) => experimental_copyToClipboard({ text }),
  notify(kind, message) {
    if (kind === "error") toast.error(message);
    else if (kind === "success") toast.success(message);
    else toast.info(message);
  },
};

function overlayProps(): Record<string, string> {
  const pluginId = typeof __BB_PLUGIN_ID__ === "string" ? __BB_PLUGIN_ID__ : undefined;
  return {
    "data-bb-portaled-overlay": "",
    "data-bb-plugin-root": "",
    ...(pluginId !== undefined ? { "data-bb-plugin": pluginId } : {}),
  };
}

function newNonce(): string {
  return crypto.randomUUID();
}

function ChatDockPanel(_props: PluginNavPanelProps) {
  const navigate = useBbNavigate();
  const openChatGpt = useCallback(() => navigate.openUrl(CHATGPT_ORIGIN + "/"), [navigate]);
  return <DockPage services={services} openChatGpt={openChatGpt} />;
}

function ChatDockToolbar({ url, experimental_page }: ExperimentalPluginBrowserToolbarActionProps) {
  // Only the isolated world is used: page scripts cannot see or change it.
  const page = useMemo<PagePort | null>(
    () =>
      experimental_page === null
        ? null
        : { evaluate: (expression) => experimental_page.evaluate(expression, { world: "isolated" }) },
    [experimental_page],
  );
  const overlay = useMemo(overlayProps, []);
  return <ToolbarAction services={services} url={url} page={page} newNonce={newNonce} overlayProps={overlay} />;
}

export default definePluginApp((app) => {
  // No DOM and no listeners: this exists for its disposer, which BB calls on
  // disable, stop, removal, a reload that replaces the bundle, and window
  // teardown. A reload of the same bundle keeps the open window's UI.
  app.contentScripts.register({
    id: "lifetime",
    mount: () => () => {
      services.staging.clear();
      services.consent.withdraw();
    },
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
      services.staging.stage({ text: selectedText, source: { kind: "message-selection", threadId } });
      toast.success("Фрагмент подготовлен. Откройте страницу ChatGPT в BB: там предпросмотр, копирование и вставка.");
    },
  });

  app.slots.experimental_browserToolbarAction({
    id: "insert",
    title: "BB Chat Dock",
    component: ChatDockToolbar,
  });
});
