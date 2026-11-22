// The minimal BB client for the browser contract probe. Its only sessions and transport tokens are synthetic.
import * as react from "react";
import * as reactDom from "react-dom";
import { createRoot } from "react-dom/client";
import * as jsxRuntime from "react/jsx-runtime";
import * as classVarianceAuthority from "class-variance-authority";
import * as clsx from "clsx";
import * as tailwindMerge from "tailwind-merge";
import * as radixDropdownMenu from "@radix-ui/react-dropdown-menu";

const version = "chertog.embed.v1";
const provider = new URL(location.href).searchParams.get("provider");
const kind = provider.split("-")[1];
const calls = [];
const replies = [];
const handle = { generation: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", sessionId: 7 };
const target = document.querySelector("[data-chertog-embed-target]");
target.dataset.provider = provider;
const send = (fields) =>
  target.dispatchEvent(
    new CustomEvent(version + ".host", {
      bubbles: true,
      detail: { version, provider, instanceId: "view-1", generation: 1, ...fields },
    }),
  );
let restored = sessionStorage.getItem("chosen");
document.addEventListener(version + ".owner", (e) => {
  replies.push(e.detail);
  if (e.detail.kind === "selected") {
    restored = e.detail.resourceRef;
    sessionStorage.setItem("chosen", restored);
    send({ kind: "announce", resourceRef: restored });
  }
});
document.addEventListener(version + ".query", (e) => {
  if (e.detail.provider === provider) send(restored ? { kind: "announce", resourceRef: restored } : { kind: "announce", mode: "choose" });
});
const rpc = {
  async call(method, input) {
    calls.push(method);
    if (method === "session_list")
      return [
        {
          ...handle,
          kind,
          state: kind === "rdp" ? "connecting" : "running",
          ...(kind === "rdp" && { rdp: { state: "desktop_ready", desktop: { frameId: 1, width: 2, height: 2 } } }),
          reason: null,
        },
      ];
    if (method === "session_close" && input.generation === handle.generation && input.sessionId === 7) return {};
    if (method === "agent_sessions") return [];
    if (method === "session_attach" && input.liveKind === kind && input.generation === handle.generation && input.sessionId === 7)
      return { token: "private-synthetic-token" };
    throw new Error("unexpected RPC " + method);
  },
};
globalThis.__bbPluginRuntime = {
  react,
  reactDom,
  jsxRuntime,
  classVarianceAuthority,
  clsx,
  tailwindMerge,
  radixDropdownMenu,
  pluginSdkApp: {
    definePluginApp: (register) => register,
    useRpc: () => rpc,
    useBbNavigate: () => ({}),
  },
};
const path = "/app.js";
const { default: register } = await import(/* @vite-ignore */ path);
const root = createRoot(document.querySelector("#app"));
register({
  slots: new Proxy(
    {},
    {
      get: () => (slot) => {
        if (slot.id === "remote-hub-embed") root.render(react.createElement(slot.component));
      },
    },
  ),
});
globalThis.fixture = {
  calls,
  replies,
  send,
  move() {
    target.parentNode.parentNode.append(target.parentNode);
    send({ kind: "announce", resourceRef: restored });
  },
};
