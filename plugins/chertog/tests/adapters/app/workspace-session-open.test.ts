// Opening a BB thread as a tile: focus the one the layout shows, put a
// subthread beside its parent, give anything else a tile of its own.
import { describe, expect, it } from "vitest";
import { findGroupOfPanel, listGroups } from "../../../src/core/layout/index.ts";
import type { WorkspaceDocument } from "../../../src/core/workspace/index.ts";
import { activeLayout, blockChildren, panelIdOfRef } from "../../../src/core/workspace/index.ts";
import { ThreadDirectory, createThreadSource, threadRef, type ThreadEntry } from "../../../src/adapters/bb/app/thread-source.ts";
import { WorkspaceSession } from "../../../src/adapters/bb/app/workspace-session.ts";
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

function sessionOver(stored: WorkspaceDocument | null) {
  const rpc = new FakeWorkspaceRpc();
  rpc.stored = stored;
  const threads = new ThreadDirectory();
  threads.set({ status: "ready", threads: entries });
  const nextId = sequentialIds();
  const session = new WorkspaceSession({
    rpc,
    sources: [createThreadSource({ directory: threads, renderChat: () => null })],
    newId: (prefix) => nextId(prefix),
    diagnostics: { report: () => undefined } as never,
    threads,
  });
  return session;
}

function document(parentPlaced: boolean): WorkspaceDocument {
  const group = (id: string, panel: string) => ({ kind: "group" as const, id, tabs: [panel], activeTab: panel });
  const layout = (id: string, panel: string) => ({
    id,
    name: id,
    workspace: { root: group("group-1", panel), focusedGroupId: "group-1", maximizedGroupId: null, nextNodeId: 2 },
  });
  return {
    schemaVersion: 2,
    revision: 1,
    panels: { "panel-p": thread("thr_p"), "panel-x": thread("thr_x") },
    layouts: parentPlaced ? [layout("layout-main", "panel-p"), layout("other", "panel-x")] : [layout("layout-main", "panel-x"), layout("other", "panel-p")],
    activeLayoutId: "layout-main",
  };
}

const shown = (session: WorkspaceSession) => activeLayout(session.document()!).workspace;
const panelOf = (session: WorkspaceSession, id: string) => panelIdOfRef(session.document()!, threadRef(id));

describe("openThread", () => {
  it("reports not-shown and changes nothing while the page is not shown", () => {
    const session = sessionOver(document(true));
    expect(session.openThread("thr_x")).toBe("not-shown");
    expect(session.document()).toBeNull();
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
