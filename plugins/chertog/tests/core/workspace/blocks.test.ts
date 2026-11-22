// Linked block operations: a parent tile and its children kept together.
import { describe, expect, it } from "vitest";
import { createWorkspace, findGroupOfPanel, listGroups, moveTab, splitGroup } from "../../../src/core/layout/index.ts";
import type { LayoutNode } from "../../../src/core/layout/index.ts";
import { activeLayout, blockChildren, changeActiveLayout, BLOCK_SIDE_LIMIT, closeBlock, moveBlock, placeInBlock } from "../../../src/core/workspace/index.ts";
import type { ParentOf, WorkspaceChange, WorkspaceDocument, WorkspacePanel } from "../../../src/core/workspace/index.ts";

const NO_LIVE: ReadonlySet<string> = new Set();
const parentOf: ParentOf = (panelId) => (/^c\d$/.test(panelId) ? "p" : undefined);

function thread(id: string): WorkspacePanel {
  return { ref: { provider: "bb-thread", params: { threadId: "thr_" + id } } };
}

function done(change: WorkspaceChange): WorkspaceDocument {
  if (!change.ok) throw new Error("expected the change to apply, got " + change.reason);
  return change.document;
}

/** One layout with one tile `p`, the parent thread. */
function parentOnly(): WorkspaceDocument {
  return {
    schemaVersion: 2,
    revision: 0,
    panels: { p: thread("p") },
    layouts: [{ id: "layout-1", name: "Работа", workspace: createWorkspace(["p"]) }],
    activeLayoutId: "layout-1",
  };
}

function withChildren(count: number, document = parentOnly()): WorkspaceDocument {
  let current = document;
  for (let index = 1; index <= count; index += 1) current = done(placeInBlock(current, "p", "c" + index, thread("c" + index), parentOf));
  return current;
}

function groupIdOf(document: WorkspaceDocument, panelId: string): string {
  const group = findGroupOfPanel(activeLayout(document).workspace.root, panelId);
  if (group === undefined) throw new Error(panelId + " is not placed");
  return group.id;
}

/** The tree as nested arrays of tab lists, with the split direction first. */
function shape(node: LayoutNode): unknown {
  return node.kind === "group" ? node.tabs : [node.direction, ...node.children.map(shape)];
}

function placed(document: WorkspaceDocument): string[] {
  return listGroups(activeLayout(document).workspace.root).flatMap((group) => group.tabs);
}

describe("placeInBlock", () => {
  it("puts the first child in a tile right of the parent and focuses it", () => {
    const document = done(placeInBlock(parentOnly(), "p", "c1", thread("c1"), parentOf));
    const { workspace } = activeLayout(document);
    expect(shape(workspace.root)).toEqual(["row", ["p"], ["c1"]]);
    expect(workspace.focusedGroupId).toBe(groupIdOf(document, "c1"));
    expect(document.panels.c1).toEqual(thread("c1"));
  });

  it("stacks the second and third child below the previous one", () => {
    const document = withChildren(3);
    expect(shape(activeLayout(document).workspace.root)).toEqual(["row", ["p"], ["column", ["c1"], ["c2"], ["c3"]]]);
    expect(blockChildren(document, "p", parentOf)).toEqual(["c1", "c2", "c3"]);
  });

  it("makes the fourth child a tab of the last child's tile, active, with no new group", () => {
    const three = withChildren(3);
    const four = done(placeInBlock(three, "p", "c4", thread("c4"), parentOf));
    const { workspace } = activeLayout(four);
    expect(BLOCK_SIDE_LIMIT).toBe(3);
    expect(listGroups(workspace.root)).toHaveLength(listGroups(activeLayout(three).workspace.root).length);
    expect(shape(workspace.root)).toEqual(["row", ["p"], ["column", ["c1"], ["c2"], ["c3", "c4"]]]);
    expect(findGroupOfPanel(workspace.root, "c4")?.activeTab).toBe("c4");
    expect(blockChildren(four, "p", parentOf)).toEqual(["c1", "c2", "c3", "c4"]);
  });

  it("only shows an already placed child", () => {
    const two = withChildren(2);
    const again = done(placeInBlock(two, "p", "c1", thread("c1"), parentOf));
    expect(listGroups(activeLayout(again).workspace.root)).toHaveLength(3);
    expect(activeLayout(again).workspace.focusedGroupId).toBe(groupIdOf(again, "c1"));
    expect(blockChildren(again, "p", parentOf)).toEqual(["c1", "c2"]);
  });

  it("refuses when the parent is not placed", () => {
    expect(placeInBlock(parentOnly(), "ghost", "c1", thread("c1"), parentOf)).toEqual({ ok: false, reason: "not-placed" });
  });
});

describe("closeBlock", () => {
  it("takes the parent and all children out of the layout and leaves other tiles", () => {
    let document = withChildren(4);
    document = done(changeOther(document));
    const closed = done(closeBlock(document, "p", parentOf, NO_LIVE));
    expect(placed(closed)).toEqual(["other"]);
    expect(Object.keys(closed.panels)).toEqual(["other"]);
  });

  it("keeps a parent that has a live instance among the hidden panels", () => {
    const closed = done(closeBlock(withChildren(2), "p", parentOf, new Set(["p"])));
    expect(placed(closed)).toEqual([]);
    expect(Object.keys(closed.panels)).toEqual(["p"]);
  });

  it("closes a child that was moved into another tile together with the parent", () => {
    let document = done(changeOther(withChildren(2)));
    document = done(moveChildInto(document, "c2", "other"));
    expect(blockChildren(document, "p", parentOf)).toContain("c2");
    const closed = done(closeBlock(document, "p", parentOf, NO_LIVE));
    expect(placed(closed)).toEqual(["other"]);
  });
});

describe("moveBlock", () => {
  it("moves the parent left of another tile and sets the children back right of it", () => {
    const document = done(changeOther(withChildren(3)));
    const moved = done(moveBlock(document, groupIdOf(document, "p"), groupIdOf(document, "other"), "left", parentOf));
    expect(shape(activeLayout(moved).workspace.root)).toEqual(["row", ["p"], ["column", ["c1"], ["c2"], ["c3"]], ["other"]]);
    expect(blockChildren(moved, "p", parentOf)).toEqual(["c1", "c2", "c3"]);
    expect(Object.keys(moved.panels).sort()).toEqual(["c1", "c2", "c3", "other", "p"]);
  });

  it("changes nothing when the target is a tile of the block itself", () => {
    const document = withChildren(2);
    const same = moveBlock(document, groupIdOf(document, "p"), groupIdOf(document, "c1"), "left", parentOf);
    expect(same).toEqual({ ok: true, document });
  });
});

/** Places the unrelated tile `other` as a split right of the parent group's whole row. */
function changeOther(document: WorkspaceDocument): WorkspaceChange {
  const registered = { ...document, panels: { ...document.panels, other: thread("other") } };
  const target = listGroups(activeLayout(registered).workspace.root).at(-1);
  if (target === undefined) throw new Error("no group");
  return changeActiveLayout(registered, (workspace) => splitGroup(workspace, target.id, "right", "other"));
}

function moveChildInto(document: WorkspaceDocument, panelId: string, intoPanelId: string): WorkspaceChange {
  return changeActiveLayout(document, (workspace) => moveTab(workspace, panelId, groupIdOf(document, intoPanelId)));
}
