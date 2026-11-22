// Hiding, closing and moving a parent tile takes its linked block along.
import { describe, expect, it } from "vitest";
import { closeTab, findGroupOfPanel, listGroups } from "../../../src/core/layout/index.ts";
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

const group = (id: string, panel: string) => ({ kind: "group" as const, id, tabs: [panel], activeTab: panel });

/** Two tiles side by side: the parent thread and an unrelated one. */
function twoTiles(): WorkspaceDocument {
  const groups = [group("group-1", "panel-p"), group("group-2", "panel-x")];
  return {
    schemaVersion: 2, revision: 1,
    panels: { "panel-p": { ref: threadRef("thr_p") }, "panel-x": { ref: threadRef("thr_x") } },
    layouts: [{
      id: "layout-main", name: "main",
      workspace: { root: { kind: "split", id: "split-100", direction: "row", children: groups, sizes: [0.5, 0.5] }, focusedGroupId: "group-2", maximizedGroupId: null, nextNodeId: 200 },
    }],
    activeLayoutId: "layout-main",
  };
}

/** A session whose layout holds the parent with its two subthreads and the unrelated tile. */
async function blockSession(): Promise<WorkspaceSession> {
  const rpc = new FakeWorkspaceRpc();
  rpc.stored = twoTiles();
  const threads = new ThreadDirectory();
  threads.set({ status: "ready", threads: entries });
  const nextId = sequentialIds();
  const session = new WorkspaceSession({
    rpc,
    sources: [createThreadSource({ directory: threads, renderChat: () => null })],
    newId: (prefix) => nextId(prefix),
    diagnostics: { failure: () => undefined },
    threads,
  });
  await session.controller.enter();
  session.openThread("thr_c");
  session.openThread("thr_c2");
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

  it("closing the parent closes its children and ends their instances in one call", async () => {
    const session = await blockSession();
    const children = [panelOf(session, "thr_c"), panelOf(session, "thr_c2")];
    expect(children.every((panelId) => session.instanceOfPanel(panelId) !== null)).toBe(true);
    expect(await session.closePanel("panel-p")).toBe("closed");
    expect(placed(session)).toEqual(["panel-x"]);
    for (const panelId of ["panel-p", ...children]) {
      expect(session.instanceOfPanel(panelId)).toBeNull();
      expect(session.document()!.panels[panelId]).toBeUndefined();
    }
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
});
