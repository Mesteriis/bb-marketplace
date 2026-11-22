// @vitest-environment jsdom
import { render, act, cleanup, fireEvent, within, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, expect, it } from "vitest";
import { TelegramPortals } from "../src/adapters/bb/embed-portals.tsx";

import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

let app: Awaited<ReturnType<typeof loadPluginApp>>;
beforeAll(async () => { app = await loadPluginApp(() => import("../app.tsx")); }, 30_000);
afterEach(() => { cleanup(); document.body.replaceChildren(); });
const base = { version: "chertog.embed.v1", provider: "telegram-chat", instanceId: "view-1", generation: 1 };
function target(id: string) {
  const layer = document.querySelector("[data-chertog-embed-layer]") ?? document.body.appendChild(document.createElement("main"));
  layer.setAttribute("data-chertog-embed-layer", "v1");
  const host = layer.appendChild(document.createElement("section"));
  host.dataset.liveHost = id;
  const node = host.appendChild(document.createElement("div"));
  Object.assign(node.dataset, { chertogEmbedTarget: "v1", provider: "telegram-chat", instanceId: id, generation: "1" });
  return node;
}
function announce(node: HTMLElement, detail: object) {
  act(() => { node.dispatchEvent(new CustomEvent("chertog.embed.v1.host", { detail, bubbles: true })); });
}
it("rejects wrong nodes, versions, generations and additional fields before mounting", () => {
  const node = target("view-1");
  const message = { ...base, kind: "announce", mode: "choose" };
  render(<TelegramPortals renderPanel={() => <input />} />);
  for (const change of [{ generation: 0 }, { generation: 2 }, { version: "chertog.embed.v2" }, { url: "private" }, { provider: "zoom-call" }]) {
    announce(node, { ...message, ...change });
    expect(node.childElementCount).toBe(0);
  }
  announce(document.body, message);
  expect(document.querySelector("input")).toBeNull();
  announce(node, message);
  expect(node.querySelector("input")).toBeTruthy();
  announce(node, { ...base, kind: "release" });
  announce(node, message);
  expect(node.childElementCount).toBe(0);
});
it("preserves two independent draft inputs across replay and revokes both on disable", () => {
  const a = target("view-1"), b = target("view-2");
  const revoked: string[] = [];
  for (const node of [a,b]) node.addEventListener("chertog.embed.v1.owner", e => {
    const data = (e as CustomEvent).detail;
    if (data.kind === "revoked") revoked.push(data.instanceId);
  });
  const mounted = render(<TelegramPortals renderPanel={() => <textarea />} />);
  const first = { ...base, kind: "announce", resourceRef: "12345678-1234-4123-8123-123456789abc" };
  announce(a, first);
  announce(b, { ...first, instanceId: "view-2", resourceRef: "12345678-1234-4123-8123-123456789abd" });
  fireEvent.change(a.querySelector("textarea")!, {target:{value:"first"}});
  fireEvent.change(b.querySelector("textarea")!, {target:{value:"second"}});
  announce(a, first);
  expect(a.querySelector("textarea")?.value).toBe("first");
  expect(b.querySelector("textarea")?.value).toBe("second");
  mounted.unmount();
  expect(document.querySelector("textarea")).toBeNull();
  expect(revoked).toEqual(["view-1","view-2"]);
});

it("registers the Telegram owner slot and waits for host acceptance before resolving the chosen chat", async () => {
  const slot = app.appOverlays.find(item => item.id === "chertog-chat")!;
  const node = target("view-1");
  const chat = {id:"21",name:"Synthetic A",initials:"A",color:"#246dbd",subtitle:"Group",messages:[]};
  const ref = "12345678-1234-4123-8123-123456789abc";
  const methods: string[] = [], states: string[] = [];
  node.addEventListener("chertog.embed.v1.owner", e=>states.push((e as CustomEvent).detail.kind));
  const view = renderSlot(slot, {}, { rpc: {
    status: () => ({state:"ready", connectionId:"12345678-1234-4123-8123-123456789aaa"}),
    sessionRpc: input => {
      const {method,payload} = input as {method:string;payload:{method?:string}};
      methods.push(method);
      if (method === "chatPage") return {chats:[chat],nextOffset:null};
      if (method === "bindEmbedChat") return ref;
      if (method === "resolveEmbedChat") return {chat,list:"main"};
      if (method === "embedChatAction" && payload.method === "history") return {messages:[],before:null};
      throw new Error("Unexpected call");
    },
  } });
  try {
    announce(node,{...base,kind:"announce",mode:"choose"});
    fireEvent.click(await within(node).findByRole("button",{name:"Synthetic A"}));
    await waitFor(()=>expect(states).toContain("selected"));
    announce(node,{...base,kind:"announce",resourceRef:"12345678-1234-4123-8123-123456789abd"});
    expect(methods).not.toContain("resolveEmbedChat");
    announce(node,{...base,kind:"announce",resourceRef:ref});
    await within(node).findByRole("textbox",{name:"Write a message"});
    expect(states).toContain("ready");
    announce(node,{...base,kind:"visibility",visible:false});
    expect(node.querySelector("[inert]")).toBeTruthy();
    announce(node,{...base,kind:"close"});
    fireEvent.click(within(node).getByRole("button",{name:"Оставить",hidden:true}));
    expect(states).toContain("keep");
  } finally { view.lifecycle.unmount(); }
  expect(node.childElementCount).toBe(0);
});

it("cannot accept an in-flight choice after owner cancellation", () => {
  const node = target("view-1");
  const replies: string[] = [];
  node.addEventListener("chertog.embed.v1.owner", e => replies.push((e as CustomEvent).detail.kind));
  render(<TelegramPortals renderPanel={panel => <button onClick={() => {
    panel.status("cancelled");
    panel.select("12345678-1234-4123-8123-123456789abc");
  }}>Cancel pending lookup</button>} />);
  announce(node, { ...base, kind: "announce", mode: "choose" });
  fireEvent.click(node.querySelector("button")!);
  expect(replies).toEqual(["cancelled"]);
});
