// @vitest-environment jsdom
import { render, act, cleanup, fireEvent, within, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
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
      if (method === "embedChatChoices") return [chat];
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


const connectionId = "12345678-1234-4123-8123-123456789aaa";
const uuid = "12345678-1234-4123-8123-123456789abc";
const fixtureChat = {id:"21",name:"Synthetic group",initials:"A",color:"#246dbd",subtitle:"Group",messages:[]};
const fixtureRow = {id:"42",author:"Fixture",time:"",text:"Original fixture"};
function openTile(session: (method: string, payload: Record<string, unknown>) => unknown,
  status = () => ({ state: "ready", connectionId }), choose = false) {
  const node = target("view-1");
  const states: string[] = [];
  node.addEventListener("chertog.embed.v1.owner", event => states.push((event as CustomEvent).detail.kind));
  const view = renderSlot(app.appOverlays.find(item => item.id === "chertog-chat")!, {}, { rpc: {
    status, sessionRpc: input => {
      const { method, payload } = input as { method: string; payload: Record<string,unknown> };
      return session(method, payload);
    },
  } });
  announce(node, { ...base, kind: "announce", ...(choose ? {mode:"choose"} : {resourceRef:uuid}) });
  return { node, states, view };
}
it("offers topics only for a verified forum and lets the user recover from a topic or chat refusal", async () => {
  const rows = [fixtureChat, {...fixtureChat, id:"22",name:"Synthetic forum",forum:true}];
  const {node,states,view} = openTile((method, payload) => {
    if (method === "embedChatChoices") return rows;
    if (method === "forumTopics") return null;
    if (method === "bindEmbedChat" && payload.id === "21") throw new Error("revoked");
    if (method === "bindEmbedChat") return uuid;
    throw new Error(method);
  }, undefined, true);
  try {
    const ui = within(node);
    await ui.findByRole("button",{name:"Synthetic group"});
    expect(ui.queryByRole("button",{name:"Темы · Synthetic group"})).toBeNull();
    fireEvent.click(ui.getByRole("button",{name:"Темы · Synthetic forum"}));
    expect((await ui.findByRole("alert")).textContent).toMatch(/тем/i);
    fireEvent.click(ui.getByRole("button",{name:"Назад к чатам"}));
    fireEvent.click(await ui.findByRole("button",{name:"Synthetic group"}));
    expect((await ui.findByRole("alert")).textContent).toMatch(/чат/);
    fireEvent.click(ui.getByRole("button",{name:"Synthetic forum"}));
    await waitFor(()=>expect(states).toContain("selected"));
    expect(states).not.toContain("denied");
  } finally { view.lifecycle.unmount(); }
});
function fixtureSession(method: string, payload: Record<string,unknown>) {
  if (method === "resolveEmbedChat") return {chat:fixtureChat,list:"main"};
  if (payload.method === "history") return {messages:[fixtureRow],before:null};
  if (payload.method === "historyMessage") return {...fixtureRow,text:"Edited fixture"};
  throw new Error(method);
}
it("keeps the same composer, selection and draft across one failed status poll and recovery", async () => {
  const status = vi.fn().mockReturnValue({state:"ready",connectionId});
  const {node,states,view} = openTile(fixtureSession,status);
  try {
    const field = await within(node).findByRole<HTMLTextAreaElement>("textbox",{name:"Write a message"});
    fireEvent.change(field,{target:{value:"unsaved fixture"}}); field.setSelectionRange(1,4);
    status.mockRejectedValueOnce(new Error("poll interrupted"));
    await waitFor(()=>expect(status.mock.calls.length).toBeGreaterThanOrEqual(3),{timeout:12000});
    expect(within(node).getByRole("textbox",{name:"Write a message"})).toBe(field);
    expect([field.value,field.selectionStart,field.selectionEnd]).toEqual(["unsaved fixture",1,4]);
    expect(states).not.toContain("lost");
  } finally { view.lifecycle.unmount(); }
},15000);
it("refreshes edited rows and applies only deletions for the bound chat and connection", async () => {
  const {node,view} = openTile(fixtureSession);
  try {
    const ui=within(node);
    await ui.findByText("Original fixture");
    await view.behavior.emitRealtime("telegram-history-message-changed",{connectionId,id:"21",messageId:"42"});
    await ui.findByText("Edited fixture");
    for (const extra of [{id:"23"},{connectionId:uuid}]) {
      await view.behavior.emitRealtime("telegram-messages-deleted",{connectionId,id:"21",messageIds:["42"],...extra});
      expect(ui.getByText("Edited fixture")).toBeTruthy();
    }
    await view.behavior.emitRealtime("telegram-messages-deleted",{connectionId,id:"21",messageIds:["42"]});
    await waitFor(()=>expect(ui.queryByText("Edited fixture")).toBeNull());
  } finally { view.lifecycle.unmount(); }
});

it("retains the bound draft when a new generation recovers after bounded status failures", async () => {
  const status = vi.fn().mockReturnValue({state:"ready",connectionId});
  const {node,states,view} = openTile(fixtureSession,status);
  try {
    const field = await within(node).findByRole("textbox",{name:"Write a message"});
    fireEvent.change(field,{target:{value:"recoverable draft"}});
    status.mockRejectedValueOnce(new Error()).mockRejectedValueOnce(new Error()).mockRejectedValueOnce(new Error());
    await waitFor(()=>expect(states).toContain("lost"),{timeout:11000});
    expect(status).toHaveBeenCalledTimes(4);
    status.mockReturnValue({state:"ready",connectionId:"12345678-1234-4123-8123-123456789bbb"});
    node.dataset.generation = "2";
    announce(node,{...base,kind:"announce",generation:2,resourceRef:uuid});
    const restored = await within(node).findByRole<HTMLTextAreaElement>("textbox",{name:"Write a message"});
    expect(restored.value).toBe("recoverable draft");
  } finally { view.lifecycle.unmount(); }
},15000);
