// Hiding, closing and moving a parent tile takes its linked block along.
import { describe, expect, it } from "vitest";
import { closeTab, findGroupOfPanel, listGroups } from "../../../src/core/layout/index.ts";
import type { WorkspaceDocument } from "../../../src/core/workspace/index.ts";
import { activeLayout, blockChildren, panelIdOfRef } from "../../../src/core/workspace/index.ts";
import { paramsSchema as embedParams } from "../../../src/core/embed/wire.ts";
import type { ContentSource } from "../../../src/adapters/bb/app/content-sources.ts";
import { chooseSource } from "../../../src/adapters/bb/app/choose-source.tsx";
import { ThreadDirectory, createThreadSource, threadRef, type ThreadEntry } from "../../../src/adapters/bb/app/thread-source.ts";
import { WorkspaceSession } from "../../../src/adapters/bb/app/workspace-session.ts";
import { applyTileCommand, tileCommandOperation } from "../../../src/ui/tiles/index.ts";
import { FakeWorkspaceRpc, sequentialIds } from "./support.ts";

const entries: ThreadEntry[] = [
  { id: "thr_p", title: "Родитель", projectName: null },
  { id: "thr_c", title: "Субтред", projectName: null, parentThreadId: "thr_p" },
  { id: "thr_c2", title: "Второй субтред", projectName: null, parentThreadId: "thr_p" },
  { id: "thr_x", title: "Другой", projectName: null },
  { id: "thr_q", title: "Второй родитель", projectName: null },
  { id: "thr_q1", title: "Субтред второго", projectName: null, parentThreadId: "thr_q" },
];

/** Changes to the thread source a test needs: a thread that needs a session-end confirmation, or a provider question before a close. */
interface Tweaks {
  endsSession?: readonly string[];
  askClose?: (instanceId: string) => Promise<"ended" | "keep" | "hide">;
}

function tweaked(base: ContentSource, { endsSession = [], askClose }: Tweaks): ContentSource {
  const provider = { ...base.provider, endsSessionOnLastClose: (ref: { params: Record<string, unknown> }) => endsSession.includes(String(ref.params.threadId)) };
  return { ...base, provider, ...(askClose === undefined ? {} : { embed: { choose() {}, target: () => null, close: askClose } }) } as ContentSource;
}

const group = (id: string, panel: string) => ({ kind: "group" as const, id, tabs: [panel], activeTab: panel });

/** Two tiles side by side: the parent thread and an unrelated one. */
function twoTiles(unrelatedFirst = false, secondParent = false): WorkspaceDocument {
  const parents = { kind: "group" as const, id: "group-1", tabs: ["panel-p", "panel-q"], activeTab: "panel-p" };
  const groups = secondParent ? [parents, group("group-2", "panel-x")] : unrelatedFirst ? [group("group-1", "panel-x"), group("group-2", "panel-p")] : [group("group-1", "panel-p"), group("group-2", "panel-x")];
  return {
    schemaVersion: 3, revision: 1,
    panels: { "panel-p": { ref: threadRef("thr_p") }, "panel-x": { ref: threadRef("thr_x") }, ...(secondParent ? { "panel-q": { ref: threadRef("thr_q") } } : {}) },
    layouts: [{
      id: "layout-main", name: "main",
      workspace: { root: { kind: "split", id: "split-100", direction: "row", children: groups, sizes: [0.5, 0.5] }, focusedGroupId: "group-2", maximizedGroupId: null, nextNodeId: 200 },
    }],
    activeLayoutId: "layout-main",
  };
}

/** What the embed stub's `choose` was given, so a test can confirm or cancel the choice like the embedded page would. */
interface PendingChoice { selected(uuid: string): void; cancel(reason?: string): void }
const RDP_UUID = "6f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f";

/** An embedded provider like Remote Hub RDP: its item opens a choice that ends in a resource UUID. */
function rdpSource(pending: { current?: PendingChoice }): ContentSource {
  return {
    provider: {
      type: "remote-rdp-live", paramsSchema: embedParams, multipleViews: true,
      capabilities: { showNativeRoute: "no", embedInstance: "yes", keepLiveInDocument: "yes", rebindToSession: "unverified", transferBetweenWindows: "no", restoreAfterRestart: "partial" },
      open: async () => ({ status: "entry" }), release() {}, endsSessionOnLastClose: () => false, endSession: async () => "unknown",
    },
    sectionTitle: "RDP", neutralLabel: "RDP", canEndSession: false, offered: () => true,
    section: () => ({ state: "ready", items: [{ id: "choose", title: "Добавить RDP" }] }),
    stableRefOf: () => null, refOf: () => null, label: () => ({ title: "RDP" }), stateText: () => null, subscribe: () => () => {},
    render: () => null,
    embed: { choose: (_id, selected, cancel) => { pending.current = { selected, cancel }; }, target: () => null, close: async () => "ended" },
  } as ContentSource;
}

/** A session whose layout holds the parent with its two subthreads and the unrelated tile. */
async function blockSession(
  tweaks: Tweaks = {}, stored: WorkspaceDocument = twoTiles(), open: readonly string[] = ["thr_c", "thr_c2"], extra: readonly ContentSource[] = [],
): Promise<WorkspaceSession> {
  const rpc = new FakeWorkspaceRpc();
  rpc.stored = stored;
  const threads = new ThreadDirectory();
  threads.set({ status: "ready", threads: entries });
  const nextId = sequentialIds();
  const session: WorkspaceSession = new WorkspaceSession({
    rpc,
    sources: [tweaked(createThreadSource({ directory: threads, renderChat: () => null }), tweaks), chooseSource(() => session), ...extra],
    newId: (prefix) => nextId(prefix),
    diagnostics: { failure: () => undefined },
    threads,
  });
  await session.controller.enter();
  for (const threadId of open) session.openThread(threadId);
  // A save that lands while a close awaits makes the session sync and reopen the tab being closed; let it land first.
  await session.controller.whenIdle();
  return session;
}

const shown = (session: WorkspaceSession) => activeLayout(session.document()!).workspace;
const placed = (session: WorkspaceSession) => listGroups(shown(session).root).flatMap((tile) => tile.tabs);
const panelOf = (session: WorkspaceSession, id: string) => panelIdOfRef(session.document()!, threadRef(id))!;

describe("a parent tile and its block", () => {
  it("starts with both subthreads in the block", async () => {
    const session = await blockSession();
    expect(blockChildren(session.document()!, "panel-p", session.parentOf)).toEqual([panelOf(session, "thr_c"), panelOf(session, "thr_c2")]);
  });

  it("hiding the parent takes its children out of the layout", async () => {
    const session = await blockSession();
    session.removeFromLayout("panel-p");
    expect(placed(session)).toEqual(["panel-x"]);
  });

  it("removing the parent through the tile menu takes its children out of the layout", async () => {
    const session = await blockSession();
    session.applySurfaceChange({ kind: "state", state: closeTab(shown(session), "panel-p") });
    expect(placed(session)).toEqual(["panel-x"]);
  });

  it("asks before closing a parent that has children, and changes nothing until the user confirms", async () => {
    const session = await blockSession();
    const before = session.document();
    expect(await session.closePanel("panel-p")).toBe("needs-confirmation");
    expect(session.document()).toBe(before);
    expect(session.instanceOfPanel("panel-p")).not.toBeNull();
  });

  it("closes the parent and every child once the block is confirmed", async () => {
    const session = await blockSession();
    const children = [panelOf(session, "thr_c"), panelOf(session, "thr_c2")];
    expect(children.every((panelId) => session.instanceOfPanel(panelId) !== null)).toBe(true);
    expect(await session.closePanel("panel-p", { confirmBlock: true })).toBe("closed");
    expect(placed(session)).toEqual(["panel-x"]);
    for (const panelId of ["panel-p", ...children]) {
      expect(session.instanceOfPanel(panelId)).toBeNull();
      expect(session.document()!.panels[panelId]).toBeUndefined();
    }
  });

  it("covers a member that would end a session with the same question, and releases nothing before it is answered", async () => {
    const session = await blockSession({ endsSession: ["thr_c2"] });
    const children = [panelOf(session, "thr_c"), panelOf(session, "thr_c2")];
    const before = session.document();
    expect(await session.closePanel("panel-p", { confirmBlock: true })).toBe("needs-confirmation");
    expect(session.document()).toBe(before);
    for (const panelId of ["panel-p", ...children]) expect(session.instanceOfPanel(panelId)).not.toBeNull();
    expect(await session.closePanel("panel-p", { confirmBlock: true, confirmEndsSession: true })).toBe("closed");
    expect(placed(session)).toEqual(["panel-x"]);
    for (const panelId of ["panel-p", ...children]) expect(session.instanceOfPanel(panelId)).toBeNull();
  });

  it("releases nothing when a member's provider asks to keep it", async () => {
    const asked: string[] = [];
    const session = await blockSession({ askClose: async (instanceId) => { asked.push(instanceId); return asked.length === 2 ? "keep" : "ended"; } });
    const children = [panelOf(session, "thr_c"), panelOf(session, "thr_c2")];
    expect(await session.closePanel("panel-p", { confirmBlock: true })).toBe("kept");
    for (const panelId of ["panel-p", ...children]) expect(session.instanceOfPanel(panelId)).not.toBeNull();
    expect(placed(session)).toEqual(["panel-p", ...children, "panel-x"]);
  });

  it("closes a child that is opened while the close is waiting for a provider", async () => {
    let answer!: () => void;
    const gate = new Promise<void>((resolve) => { answer = resolve; });
    const session = await blockSession({ askClose: async () => { await gate; return "ended"; } }, twoTiles(), ["thr_c"]);
    const closing = session.closePanel("panel-p", { confirmBlock: true });
    session.openThread("thr_c2");
    const late = panelOf(session, "thr_c2");
    expect(placed(session)).toContain(late);
    answer();
    expect(await closing).toBe("closed");
    expect(placed(session)).toEqual(["panel-x"]);
    expect(session.instanceOfPanel(late)).toBeNull();
  });

  it("closes a panel without children without any question, as before", async () => {
    const session = await blockSession();
    expect(await session.closePanel("panel-x")).toBe("closed");
    expect(placed(session)).toEqual(["panel-p", panelOf(session, "thr_c"), panelOf(session, "thr_c2")]);
  });

  it("closing a child alone leaves the parent and the other child", async () => {
    const session = await blockSession();
    const child = panelOf(session, "thr_c");
    expect(await session.closePanel(child)).toBe("closed");
    expect(placed(session)).toEqual(["panel-p", panelOf(session, "thr_c2"), "panel-x"]);
    expect(session.instanceOfPanel(child)).toBeNull();
  });

  it("dragging the parent's tile moves the children with it", async () => {
    const session = await blockSession();
    const root = shown(session).root;
    session.applySurfaceChange({
      kind: "operation",
      operation: { type: "moveGroup", groupId: findGroupOfPanel(root, "panel-p")!.id, targetGroupId: findGroupOfPanel(root, "panel-x")!.id, edge: "right" },
    });
    expect(placed(session)).toEqual(["panel-x", "panel-p", panelOf(session, "thr_c"), panelOf(session, "thr_c2")]);
  });

  it("moves a tile without children as before", async () => {
    const session = await blockSession();
    const root = shown(session).root;
    session.applySurfaceChange({
      kind: "operation",
      operation: { type: "moveGroup", groupId: findGroupOfPanel(root, "panel-x")!.id, targetGroupId: findGroupOfPanel(root, "panel-p")!.id, edge: "left" },
    });
    expect(placed(session)).toEqual(["panel-x", "panel-p", panelOf(session, "thr_c"), panelOf(session, "thr_c2")]);
  });

  it("keyboard move of the parent's tile moves the children with it", async () => {
    const session = await blockSession({}, twoTiles(true));
    const groupId = findGroupOfPanel(shown(session).root, "panel-p")!.id;
    const command = { type: "moveGroup", direction: "left" } as const;
    const via = tileCommandOperation(shown(session), groupId, command);
    expect(via).toBeDefined();
    session.applySurfaceChange({ kind: "state", state: applyTileCommand(shown(session), groupId, command), via });
    expect(placed(session)).toEqual(["panel-p", panelOf(session, "thr_c"), panelOf(session, "thr_c2"), "panel-x"]);
  });

  it("keyboard move of a tab that is a parent moves its children with it", async () => {
    const session = await blockSession({}, twoTiles(true));
    const groupId = findGroupOfPanel(shown(session).root, "panel-p")!.id;
    const command = { type: "moveTab", direction: "left" } as const;
    const via = tileCommandOperation(shown(session), groupId, command);
    session.applySurfaceChange({ kind: "state", state: applyTileCommand(shown(session), groupId, command), via });
    expect(findGroupOfPanel(shown(session).root, "panel-p")!.tabs).toEqual(["panel-x", "panel-p"]);
    expect(placed(session)).toEqual(["panel-x", "panel-p", panelOf(session, "thr_c"), panelOf(session, "thr_c2")]);
  });

  it("dragging the parent's only tab to another tile brings the children along", async () => {
    const session = await blockSession();
    const root = shown(session).root;
    session.applySurfaceChange({
      kind: "operation",
      operation: { type: "moveTabToEdge", panelId: "panel-p", targetGroupId: findGroupOfPanel(root, "panel-x")!.id, edge: "right" },
    });
    expect(placed(session)).toEqual(["panel-x", "panel-p", panelOf(session, "thr_c"), panelOf(session, "thr_c2")]);
  });

  it("dropping the parent's tab on the centre of another tile re-places the children around its new tile", async () => {
    const session = await blockSession();
    const root = shown(session).root;
    session.applySurfaceChange({
      kind: "operation",
      operation: { type: "moveTab", panelId: "panel-p", targetGroupId: findGroupOfPanel(root, "panel-x")!.id },
    });
    expect(findGroupOfPanel(shown(session).root, "panel-p")!.tabs).toEqual(["panel-x", "panel-p"]);
    expect(placed(session)).toEqual(["panel-x", "panel-p", panelOf(session, "thr_c"), panelOf(session, "thr_c2")]);
  });

  it("moving a tile that holds several parents moves every parent's block", async () => {
    const stored = twoTiles(false, true);
    const session = await blockSession({}, stored, ["thr_c", "thr_c2", "thr_q1"]);
    const root = shown(session).root;
    session.applySurfaceChange({
      kind: "operation",
      operation: { type: "moveGroup", groupId: findGroupOfPanel(root, "panel-p")!.id, targetGroupId: findGroupOfPanel(root, "panel-x")!.id, edge: "right" },
    });
    const order = placed(session);
    expect(order.slice(0, 3)).toEqual(["panel-x", "panel-p", "panel-q"]);
    expect(blockChildren(session.document()!, "panel-p", session.parentOf)).toEqual([panelOf(session, "thr_c"), panelOf(session, "thr_c2")]);
    expect(blockChildren(session.document()!, "panel-q", session.parentOf)).toEqual([panelOf(session, "thr_q1")]);
  });

  it("keeps the blocks of both tiles when two parents swap places", async () => {
    const stored = twoTiles();
    const groups = [group("group-1", "panel-p"), group("group-2", "panel-q")];
    const document: WorkspaceDocument = {
      ...stored,
      panels: { "panel-p": { ref: threadRef("thr_p") }, "panel-q": { ref: threadRef("thr_q") } },
      layouts: [{ ...stored.layouts[0], workspace: { ...stored.layouts[0].workspace, root: { kind: "split", id: "split-100", direction: "row", children: groups, sizes: [0.5, 0.5] } } }],
    };
    const session = await blockSession({}, document, ["thr_c", "thr_q1"]);
    const root = shown(session).root;
    session.applySurfaceChange({
      kind: "operation",
      operation: { type: "swapGroups", groupId: findGroupOfPanel(root, "panel-p")!.id, targetGroupId: findGroupOfPanel(root, "panel-q")!.id },
    });
    expect(placed(session)).toEqual(["panel-q", panelOf(session, "thr_q1"), "panel-p", panelOf(session, "thr_c")]);
  });

  it("refuses visibly a swap of a parent with the tile of its own child", async () => {
    const session = await blockSession();
    const before = session.document();
    const root = shown(session).root;
    session.applySurfaceChange({
      kind: "operation",
      operation: { type: "swapGroups", groupId: findGroupOfPanel(root, "panel-p")!.id, targetGroupId: findGroupOfPanel(root, panelOf(session, "thr_c"))!.id },
    });
    expect(session.document()).toBe(before);
    expect(session.controller.getSnapshot().refusal).toBe("invalid-layout");
    // The other way round: the child's tile dropped on the parent's.
    session.controller.dismissRefusal();
    session.applySurfaceChange({
      kind: "operation",
      operation: { type: "swapGroups", groupId: findGroupOfPanel(root, panelOf(session, "thr_c"))!.id, targetGroupId: findGroupOfPanel(root, "panel-p")!.id },
    });
    expect(session.document()).toBe(before);
    expect(session.controller.getSnapshot().refusal).toBe("invalid-layout");
  });
});

describe("opening something beside a tile", () => {
  it("places a picker right of the tile with the tile as its parent, so it counts as a child", async () => {
    const session = await blockSession({}, twoTiles(), []);
    session.openBeside("panel-p");
    const picker = placed(session).find((panelId) => session.document()!.panels[panelId].ref.provider === "chertog-choose")!;
    expect(session.document()!.panels[picker].parent).toBe("panel-p");
    expect(session.parentOf(picker)).toBe("panel-p");
    expect(blockChildren(session.document()!, "panel-p", session.parentOf)).toEqual([picker]);
    expect(session.linkedCountOf("panel-p")).toBe(1);
  });

  it("keeps what is chosen in that picker in the block: it inherits the parent and closes with it", async () => {
    const session = await blockSession({}, twoTiles(), []);
    session.openBeside("panel-p");
    const picker = placed(session).find((panelId) => session.document()!.panels[panelId].ref.provider === "chertog-choose")!;
    session.replaceChoice(session.instanceOfPanel(picker)!.instanceId, { providerId: "bb-thread", itemId: "thr_q", placement: "tab" });
    const chosen = panelOf(session, "thr_q");
    expect(session.document()!.panels[chosen].parent).toBe("panel-p");
    expect(session.parentOf(chosen)).toBe("panel-p");
    expect(await session.closePanel("panel-p", { confirmBlock: true })).toBe("closed");
    expect(placed(session)).toEqual(["panel-x"]);
  });

  it("does not treat a stored parent as a parent while that parent is not placed", async () => {
    const session = await blockSession({}, twoTiles(), []);
    session.openBeside("panel-p");
    const picker = placed(session).find((panelId) => session.document()!.panels[panelId].ref.provider === "chertog-choose")!;
    session.removeFromLayout("panel-p");
    expect(session.parentOf(picker)).toBeUndefined();
  });
});

describe("an embedded source chosen in the picker beside a tile", () => {
  const pickerOf = (session: WorkspaceSession) =>
    placed(session).find((panelId) => session.document()!.panels[panelId].ref.provider === "chertog-choose")!;
  const rdpChoice = { providerId: "remote-rdp-live", itemId: "choose", placement: "tab" as const };

  it("offers the embedded sections in a picker that has a parent, and only there", async () => {
    const session = await blockSession({}, twoTiles(), [], [rdpSource({})]);
    session.openBeside("panel-p");
    expect(session.pickerOffersEmbeds(session.instanceOfPanel(pickerOf(session))!.instanceId)).toBe(true);
    expect(session.pickerOffersEmbeds(session.instanceOfPanel("panel-x")!.instanceId)).toBe(false);
  });

  it("replaces the picker in place with the confirmed choice, which joins the block and closes with it", async () => {
    const pending: { current?: PendingChoice } = {};
    const session = await blockSession({}, twoTiles(), [], [rdpSource(pending)]);
    session.openBeside("panel-p");
    const picker = pickerOf(session);
    const before = shown(session);
    session.replaceChoice(session.instanceOfPanel(picker)!.instanceId, rdpChoice);
    pending.current!.selected(RDP_UUID);
    await session.controller.whenIdle();
    const rdp = placed(session).find((panelId) => session.document()!.panels[panelId]?.ref.provider === "remote-rdp-live")!;
    expect(session.document()!.panels[picker]).toBeUndefined();
    expect(session.document()!.panels[rdp].parent).toBe("panel-p");
    expect(findGroupOfPanel(shown(session).root, rdp)!.id).toBe(findGroupOfPanel(before.root, picker)!.id);
    expect(blockChildren(session.document()!, "panel-p", session.parentOf)).toEqual([rdp]);
    expect(await session.closePanel("panel-p", { confirmBlock: true })).toBe("closed");
    expect(placed(session)).toEqual(["panel-x"]);
    expect(session.document()!.panels[rdp]).toBeUndefined();
  });

  it("leaves the picker as it was when the choice is cancelled", async () => {
    const pending: { current?: PendingChoice } = {};
    const session = await blockSession({}, twoTiles(), [], [rdpSource(pending)]);
    session.openBeside("panel-p");
    const picker = pickerOf(session);
    await session.controller.whenIdle();
    const before = session.document();
    session.replaceChoice(session.instanceOfPanel(picker)!.instanceId, rdpChoice);
    pending.current!.cancel();
    await session.controller.whenIdle();
    expect(session.document()).toBe(before);
    expect(pickerOf(session)).toBe(picker);
  });
});

describe("opening beside a subordinate tile", () => {
  it("attaches the picker to the block's main tile, never to a grandchild", async () => {
    const session = await blockSession();
    const child = panelOf(session, "thr_c");
    session.openBeside(child);
    const picker = placed(session).find((panelId) => session.document()!.panels[panelId].ref.provider === "chertog-choose")!;
    expect(session.document()!.panels[picker].parent).toBe("panel-p");
    expect(blockChildren(session.document()!, "panel-p", session.parentOf)).toContain(picker);
    expect(blockChildren(session.document()!, child, session.parentOf)).toEqual([]);
  });
});

describe("parents that would form a cycle", () => {
  /** A subthread tile A (its thread parent thr_p is not placed) beside an unrelated tile. */
  function subthreadOnly(): WorkspaceDocument {
    const document = twoTiles();
    const { "panel-p": _parent, ...panels } = document.panels;
    return {
      ...document,
      panels: { ...panels, "panel-a": { ref: threadRef("thr_c") } },
      layouts: [{ ...document.layouts[0], workspace: { ...document.layouts[0].workspace, root: { ...document.layouts[0].workspace.root, children: [group("group-1", "panel-a"), group("group-2", "panel-x")] } as never } }],
    };
  }
  const chooseInto = async (session: WorkspaceSession, besidePanel: string, threadId: string): Promise<string> => {
    session.openBeside(besidePanel);
    const picker = placed(session).find((panelId) => session.document()!.panels[panelId].ref.provider === "chertog-choose")!;
    session.replaceChoice(session.instanceOfPanel(picker)!.instanceId, { providerId: "bb-thread", itemId: threadId, placement: "tab" });
    await session.controller.whenIdle();
    return panelOf(session, threadId);
  };

  it("keeps the relation acyclic: a stored parent wins over the thread tree, and nothing hangs", async () => {
    const session = await blockSession({}, subthreadOnly(), []);
    const z = await chooseInto(session, "panel-a", "thr_q");
    const p = await chooseInto(session, "panel-a", "thr_p");
    // P is A's stored child, although the thread tree makes P the parent of A: the stored link wins.
    expect(session.parentOf(p)).toBe("panel-a");
    expect(session.parentOf("panel-a")).toBeUndefined();
    // Beside Z means beside the block's main tile A, and it returns.
    session.openBeside(z);
    const pickers = placed(session).filter((panelId) => session.document()!.panels[panelId].ref.provider === "chertog-choose");
    expect(pickers).toHaveLength(1);
    expect(session.document()!.panels[pickers[0]].parent).toBe("panel-a");
    // Closing P closes nothing else; closing A closes its whole block.
    expect(session.linkedCountOf(p)).toBe(0);
    expect(await session.closePanel("panel-a", { confirmBlock: true })).toBe("closed");
    expect(placed(session)).toEqual(["panel-x"]);
  });
});

describe("an embedded choice whose reference the document already has", () => {
  const RDP = { provider: "remote-rdp-live", params: { resourceRef: RDP_UUID } };
  function withRdp(inLayout: boolean): WorkspaceDocument {
    const document = twoTiles();
    const root = document.layouts[0].workspace.root as unknown as { children: Array<{ tabs: string[] }> };
    const children = inLayout ? [root.children[0], { ...root.children[1], tabs: ["panel-x", "panel-r"] }] : root.children;
    return {
      ...document,
      panels: { ...document.panels, "panel-r": { ref: RDP } },
      layouts: [{ ...document.layouts[0], workspace: { ...document.layouts[0].workspace, root: { ...root, children } as never } }],
    };
  }
  const bound = (session: WorkspaceSession) => session.registry.list().every((instance) => session.document()!.panels[session.panelOfInstance(instance.instanceId) ?? ""] !== undefined);
  const rdpInstances = (session: WorkspaceSession) => session.registry.list().filter((instance) => instance.ref.provider === "remote-rdp-live");

  const pickerIn = (session: WorkspaceSession) => placed(session).find((panelId) => session.document()!.panels[panelId].ref.provider === "chertog-choose")!;
  /** Opens a picker beside the parent and confirms the RDP resource in it. */
  async function pick(session: WorkspaceSession, pending: { current?: PendingChoice }): Promise<void> {
    session.openBeside("panel-p");
    session.replaceChoice(session.instanceOfPanel(pickerIn(session))!.instanceId, { providerId: "remote-rdp-live", itemId: "choose", placement: "tab" });
    pending.current!.selected(RDP_UUID);
    await session.controller.whenIdle();
  }
  async function choose(stored: WorkspaceDocument, hide = false): Promise<WorkspaceSession> {
    const pending: { current?: PendingChoice } = {};
    const session = await blockSession({}, stored, [], [rdpSource(pending)]);
    if (hide) {
      // A hidden panel survives only while its instance is live: choose it once, then take it out of the layout.
      await pick(session, pending);
      session.removeFromLayout(placed(session).find((panelId) => session.document()!.panels[panelId].ref.provider === "remote-rdp-live")!);
    }
    await pick(session, pending);
    return session;
  }

  it("does not orphan an instance when the reference is already placed", async () => {
    const session = await choose(withRdp(true));
    expect(bound(session)).toBe(true);
    expect(rdpInstances(session)).toHaveLength(1);
    expect(Object.values(session.document()!.panels).filter((panel) => panel.ref.provider === "remote-rdp-live")).toHaveLength(1);
  });

  it("puts a registered but not placed reference in the picker's place, under its own id", async () => {
    const session = await choose(twoTiles(), true);
    expect(bound(session)).toBe(true);
    expect(rdpInstances(session)).toHaveLength(1);
    const rdp = Object.keys(session.document()!.panels).filter((panelId) => session.document()!.panels[panelId].ref.provider === "remote-rdp-live");
    expect(rdp).toHaveLength(1);
    expect(session.document()!.panels[rdp[0]].parent).toBe("panel-p");
    expect(placed(session)).toContain(rdp[0]);
    expect(placed(session).some((panelId) => session.document()!.panels[panelId].ref.provider === "chertog-choose")).toBe(false);
  });

  it("reports a refusal to start the choice instead of closing silently", async () => {
    const session = await blockSession({}, twoTiles(), [], [rdpSource({})]);
    session.openBeside("panel-p");
    const picker = placed(session).find((panelId) => session.document()!.panels[panelId].ref.provider === "chertog-choose")!;
    const instanceId = session.instanceOfPanel(picker)!.instanceId;
    // Eight tiles are the limit; a replacement never adds one, so a refusal needs a vanished picker group instead.
    session.removeFromLayout(picker);
    session.replaceChoice(instanceId, { providerId: "remote-rdp-live", itemId: "choose", placement: "tab" });
    expect(session.choiceError).not.toBeNull();
  });
});
