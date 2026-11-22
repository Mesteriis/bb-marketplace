// Opening a BB thread as a tile: focus the one the layout shows, put a
// subthread beside its parent, give anything else a tile of its own.
import { describe, expect, it } from "vitest";
import { findGroupOfPanel, listGroups } from "../../../src/core/layout/index.ts";
import type { WorkspaceDocument } from "../../../src/core/workspace/index.ts";
import { activeLayout, blockChildren, panelIdOfRef } from "../../../src/core/workspace/index.ts";
import { ThreadDirectory, createThreadSource, threadRef, type ThreadEntry } from "../../../src/adapters/bb/app/thread-source.ts";
import { createFixtureSource } from "../../../src/adapters/bb/app/fixture-source.tsx";
import { appStrings } from "../../../src/adapters/bb/app/strings.ts";
import { TILE_LIMIT, WorkspaceSession } from "../../../src/adapters/bb/app/workspace-session.ts";
import { FakeWorkspaceRpc, sequentialIds } from "./support.ts";

const entries: ThreadEntry[] = [
  { id: "thr_p", title: "Родитель", projectName: null },
  { id: "thr_c", title: "Субтред", projectName: null, parentThreadId: "thr_p" },
  { id: "thr_c2", title: "Второй субтред", projectName: null, parentThreadId: "thr_p" },
  { id: "thr_x", title: "Другой", projectName: null },
];

function thread(id: string) {
  return { ref: threadRef(id) };
}

function sessionOver(stored: WorkspaceDocument | null, rpc = new FakeWorkspaceRpc(), fixtureEnabled = true) {
  rpc.stored = stored;
  const threads = new ThreadDirectory();
  threads.set({ status: "ready", threads: entries });
  const nextId = sequentialIds();
  const session = new WorkspaceSession({
    rpc,
    sources: [
      createThreadSource({ directory: threads, renderChat: () => null }),
      createFixtureSource({ pluginId: () => "chertog", enabled: () => fixtureEnabled, newFrameName: () => "new" }),
    ],
    newId: (prefix) => nextId(prefix),
    diagnostics: { failure: () => undefined },
    threads,
  });
  return session;
}

const group = (id: string, panel: string) => ({ kind: "group" as const, id, tabs: [panel], activeTab: panel });

/** One layout whose tiles show the given panels side by side, the last one focused. */
function tiled(panels: Record<string, WorkspaceDocument["panels"][string]>): WorkspaceDocument {
  const ids = Object.keys(panels);
  const groups = ids.map((id, index) => group("group-" + (index + 1), id));
  const root = groups.length === 1 ? groups[0] : { kind: "split" as const, id: "split-100", direction: "row" as const, children: groups, sizes: groups.map(() => 1 / groups.length) };
  return {
    schemaVersion: 3, revision: 1, panels,
    layouts: [{ id: "layout-main", name: "main", workspace: { root, focusedGroupId: "group-" + groups.length, maximizedGroupId: null, nextNodeId: 200 } }],
    activeLayoutId: "layout-main",
  };
}

function document(parentPlaced: boolean): WorkspaceDocument {
  const group = (id: string, panel: string) => ({ kind: "group" as const, id, tabs: [panel], activeTab: panel });
  const layout = (id: string, panel: string) => ({
    id,
    name: id,
    workspace: { root: group("group-1", panel), focusedGroupId: "group-1", maximizedGroupId: null, nextNodeId: 2 },
  });
  return {
    schemaVersion: 3,
    revision: 1,
    panels: { "panel-p": thread("thr_p"), "panel-x": thread("thr_x") },
    layouts: parentPlaced ? [layout("layout-main", "panel-p"), layout("other", "panel-x")] : [layout("layout-main", "panel-x"), layout("other", "panel-p")],
    activeLayoutId: "layout-main",
  };
}

const shown = (session: WorkspaceSession) => activeLayout(session.document()!).workspace;
const panelOf = (session: WorkspaceSession, id: string) => panelIdOfRef(session.document()!, threadRef(id));

describe("openThread", () => {
  it("reports not-shown and changes nothing while the page is not shown", async () => {
    const rpc = new FakeWorkspaceRpc();
    const stored = document(true);
    const session = sessionOver(stored, rpc);
    expect(session.openThread("thr_x")).toBe("not-shown");
    expect(session.document()).toBeNull();
    await session.controller.whenIdle();
    expect(rpc.saves).toEqual([]);
    expect(rpc.stored).toEqual(stored);
  });

  it("focuses the tile of a placed thread when focus starts on another tile", async () => {
    const session = sessionOver(tiled({ "panel-p": thread("thr_p"), "panel-x": thread("thr_x") }));
    await session.controller.enter();
    expect(shown(session).focusedGroupId).toBe("group-2");
    expect(session.openThread("thr_p")).toBe("focused");
    expect(shown(session).focusedGroupId).toBe("group-1");
    expect(listGroups(shown(session).root)).toHaveLength(2);
  });

  it("refuses a new tile beyond the tile limit, reports it, and still focuses an open thread", async () => {
    const panels: Record<string, WorkspaceDocument["panels"][string]> = {};
    for (let index = 1; index <= TILE_LIMIT; index += 1) panels["tile-" + index] = thread("thr_" + index);
    const session = sessionOver(tiled(panels));
    await session.controller.enter();
    const before = session.document();
    expect(session.openThread("thr_x")).toBe("refused");
    expect(session.document()).toBe(before);
    expect(session.controller.getSnapshot().refusal).toBe("tile-limit");
    expect(appStrings.refusal("tile-limit")).toBe("Достигнут предел в 8 тайлов: закройте один из тайлов, чтобы открыть новый.");
    expect(session.openThread("thr_1")).toBe("focused");
  });

  it("puts a thread in the picker tile that waits in the focused tile", async () => {
    const chooser = { ref: { provider: "chertog-choose", params: { kind: "bb-thread" } } };
    const session = sessionOver(tiled({ "panel-p": thread("thr_p"), "panel-choose": chooser }));
    await session.controller.enter();
    expect(session.openThread("thr_x")).toBe("opened");
    const tabs = listGroups(shown(session).root).map((tile) => tile.tabs);
    expect(tabs).toEqual([["panel-p"], [panelOf(session, "thr_x")]]);
    expect(session.document()!.panels["panel-choose"]).toBeUndefined();
  });

  it("puts a thread in the empty tile of a first entry", async () => {
    const session = sessionOver(null);
    await session.controller.enter();
    expect(session.openThread("thr_x")).toBe("opened");
    expect(listGroups(shown(session).root).map((tile) => tile.tabs)).toEqual([[panelOf(session, "thr_x")]]);
  });

  it("focuses a thread that is already placed", async () => {
    const session = sessionOver(document(true));
    await session.controller.enter();
    expect(session.openThread("thr_p")).toBe("focused");
    const root = shown(session).root;
    expect(shown(session).focusedGroupId).toBe(findGroupOfPanel(root, "panel-p")!.id);
    expect(listGroups(root)).toHaveLength(1);
  });

  it("puts a new thread without a parent in a new tile right of the focused one", async () => {
    const session = sessionOver(document(true));
    await session.controller.enter();
    expect(session.openThread("thr_x")).toBe("opened");
    const workspace = shown(session);
    expect(listGroups(workspace.root).map((group) => group.tabs)).toEqual([["panel-p"], [panelOf(session, "thr_x")]]);
    expect(workspace.focusedGroupId).toBe(findGroupOfPanel(workspace.root, panelOf(session, "thr_x")!)!.id);
  });

  it("puts a subthread in the block of its placed parent", async () => {
    const session = sessionOver(document(true));
    await session.controller.enter();
    expect(session.openThread("thr_c")).toBe("opened");
    expect(blockChildren(session.document()!, "panel-p", session.parentOf)).toEqual([panelOf(session, "thr_c")]);
  });

  it("gives a subthread its own tile when the parent is known but not placed", async () => {
    const session = sessionOver(document(false));
    await session.controller.enter();
    expect(session.openThread("thr_c")).toBe("opened");
    const childPanel = panelOf(session, "thr_c")!;
    expect(session.parentOf(childPanel)).toBeUndefined();
    expect(listGroups(shown(session).root).map((group) => group.tabs)).toEqual([["panel-x"], [childPanel]]);
  });

  it("opens the same thread twice as one panel", async () => {
    const session = sessionOver(document(true));
    await session.controller.enter();
    expect(session.openThread("thr_x")).toBe("opened");
    expect(session.openThread("thr_x")).toBe("focused");
    const ids = Object.keys(session.document()!.panels).filter((id) => session.document()!.panels[id].ref.params.threadId === "thr_x");
    expect(ids).toHaveLength(1);
    expect(listGroups(shown(session).root)).toHaveLength(2);
  });
});

describe("openThread validation", () => {
  it("answers unsupported for a thread id the provider or the reference rules refuse, and changes nothing", async () => {
    const session = sessionOver(document(true));
    await session.controller.enter();
    const before = session.document();
    expect(session.openThread("x".repeat(129))).toBe("unsupported");
    expect(session.openThread("thr x")).toBe("unsupported");
    expect(session.openThread("")).toBe("unsupported");
    expect(session.document()).toBe(before);
  });

  it("treats a bb-thread panel request like a thread request, subthread block included", async () => {
    const session = sessionOver(document(true));
    await session.controller.enter();
    expect(session.openPanel(thread("thr_c").ref)).toBe("opened");
    expect(blockChildren(session.document()!, "panel-p", session.parentOf)).toEqual([panelOf(session, "thr_c")]);
  });
});

describe("openPanel", () => {
  const frame = (name: string) => ({ provider: "fixture-frame", params: { frame: name } });

  it("reports not-shown while the page is not shown", () => {
    expect(sessionOver(document(true)).openPanel(frame("a"))).toBe("not-shown");
  });

  it("opens a registered provider ref in a new tile and focuses it on the second request", async () => {
    const session = sessionOver(document(true));
    await session.controller.enter();
    expect(session.openPanel(frame("a"))).toBe("opened");
    expect(listGroups(shown(session).root).map((tile) => tile.tabs.length)).toEqual([1, 1]);
    expect(session.openPanel(frame("a"))).toBe("focused");
    expect(listGroups(shown(session).root)).toHaveLength(2);
  });

  it("answers unsupported for an unknown provider or params the provider refuses, and changes nothing", async () => {
    const session = sessionOver(document(true));
    await session.controller.enter();
    const before = session.document();
    expect(session.openPanel({ provider: "no-such", params: {} })).toBe("unsupported");
    expect(session.openPanel({ provider: "fixture-frame", params: { frame: "bad name" } })).toBe("unsupported");
    expect(session.openPanel({ provider: "fixture-frame", params: { other: 1 } })).toBe("unsupported");
    expect(session.document()).toBe(before);
  });

  it("answers unsupported for a source that is not offered, and opens it once it is", async () => {
    const off = sessionOver(document(true), new FakeWorkspaceRpc(), false);
    await off.controller.enter();
    const before = off.document();
    expect(off.openPanel(frame("a"))).toBe("unsupported");
    expect(off.openPanel({ provider: "chertog-choose", params: { kind: "bb-thread" } })).toBe("unsupported");
    expect(off.document()).toBe(before);
    const on = sessionOver(document(true));
    await on.controller.enter();
    expect(on.openPanel(frame("a"))).toBe("opened");
  });

  it("refuses beyond the tile limit like a thread does", async () => {
    const panels: Record<string, WorkspaceDocument["panels"][string]> = {};
    for (let index = 1; index <= TILE_LIMIT; index += 1) panels["tile-" + index] = thread("thr_" + index);
    const session = sessionOver(tiled(panels));
    await session.controller.enter();
    expect(session.openPanel(frame("a"))).toBe("refused");
    expect(session.controller.getSnapshot().refusal).toBe("tile-limit");
  });

  it("puts a ref in the picker tile that accepts it", async () => {
    const chooser = { ref: { provider: "chertog-choose", params: { kind: "bb-thread" } } };
    const session = sessionOver(tiled({ "panel-p": thread("thr_p"), "panel-choose": chooser }));
    await session.controller.enter();
    expect(session.openPanel(thread("thr_x").ref)).toBe("opened");
    expect(session.document()!.panels["panel-choose"]).toBeUndefined();
  });
});
