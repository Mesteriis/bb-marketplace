// Linked block operations: a parent tile and its children kept together.
import { describe, expect, it } from "vitest";
import { addTab, createWorkspace, findGroupOfPanel, listGroups, moveTab, splitGroup, swapGroups } from "../../../src/core/layout/index.ts";
import type { LayoutNode } from "../../../src/core/layout/index.ts";
import { activeLayout, blockChildren, changeActiveLayout, BLOCK_SIDE_LIMIT, closeBlock, moveBlock, moveWithBlocks, openBeside, placeInBlock, replaceChoosePanel } from "../../../src/core/workspace/index.ts";
import { CHOOSE_PROVIDER } from "../../../src/core/panels/choose.ts";
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
    schemaVersion: 3,
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
    const moved = done(moveBlock(document, "p", groupIdOf(document, "other"), "left", parentOf));
    expect(shape(activeLayout(moved).workspace.root)).toEqual(["row", ["p"], ["column", ["c1"], ["c2"], ["c3"]], ["other"]]);
    expect(blockChildren(moved, "p", parentOf)).toEqual(["c1", "c2", "c3"]);
    expect(Object.keys(moved.panels).sort()).toEqual(["c1", "c2", "c3", "other", "p"]);
  });

  it("changes nothing when the target is a tile of the block itself", () => {
    const document = withChildren(2);
    const same = moveBlock(document, "p", groupIdOf(document, "c1"), "left", parentOf);
    expect(same).toEqual({ ok: true, document });
  });

  it("refuses an unknown target group instead of reporting a change", () => {
    const document = withChildren(1);
    expect(moveBlock(document, "p", "no-such-group", "left", parentOf)).toEqual({ ok: false, reason: "unknown-group" });
  });

  it("refuses a parent the layout does not place", () => {
    const document = done(changeOther(withChildren(1)));
    expect(moveBlock(document, "ghost", groupIdOf(document, "other"), "left", parentOf)).toEqual({ ok: false, reason: "not-placed" });
  });

  it("takes the parent by panel id even when another tab is active in its tile", () => {
    let document = withChildren(2);
    document = { ...document, panels: { ...document.panels, other: thread("other"), q: thread("q") } };
    document = done(changeActiveLayout(document, (workspace) => addTab(workspace, groupIdOf(document, "p"), "other")));
    document = done(changeActiveLayout(document, (workspace) => splitGroup(workspace, groupIdOf(document, "p"), "left", "q")));
    expect(findGroupOfPanel(activeLayout(document).workspace.root, "p")?.activeTab).toBe("other");
    const moved = done(moveBlock(document, "p", groupIdOf(document, "q"), "left", parentOf));
    expect(shape(activeLayout(moved).workspace.root)).toEqual(["row", ["p", "other"], ["column", ["c1"], ["c2"]], ["q"]]);
  });
});

describe("moveWithBlocks", () => {
  const swapWithOther = (document: WorkspaceDocument) => (lifted: WorkspaceDocument) =>
    changeActiveLayout(lifted, (workspace) => swapGroups(workspace, groupIdOf(document, "p"), groupIdOf(document, "other")));

  it("applies any move and sets the children back around the parent's new tile", () => {
    const document = done(changeOther(withChildren(2)));
    const moved = done(moveWithBlocks(document, ["p"], groupIdOf(document, "other"), parentOf, swapWithOther(document)));
    expect(placed(moved)).toEqual(["other", "p", "c1", "c2"]);
  });

  it("refuses an unknown target and leaves a no-op move alone", () => {
    const document = done(changeOther(withChildren(2)));
    expect(moveWithBlocks(document, ["p"], "no-such-group", parentOf, swapWithOther(document))).toEqual({ ok: false, reason: "unknown-group" });
    expect(moveWithBlocks(document, ["p"], groupIdOf(document, "other"), parentOf, (lifted) => ({ ok: true, document: lifted }))).toEqual({ ok: true, document });
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

describe("openBeside", () => {
  const RDP = { provider: "remote-rdp-live", params: { resourceRef: "6f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f" } };
  const stored = (document: WorkspaceDocument): ParentOf => (panelId) => document.panels[panelId]?.parent;

  it("puts a picker tile right of the parent, with the parent stored on it", () => {
    const document = done(openBeside(parentOnly(), "p", "pick", stored(parentOnly())));
    expect(shape(activeLayout(document).workspace.root)).toEqual(["row", ["p"], ["pick"]]);
    expect(document.panels.pick).toEqual({ ref: { provider: CHOOSE_PROVIDER, params: { kind: "any" } }, parent: "p" });
  });

  it("refuses a parent the layout does not place", () => {
    expect(openBeside(parentOnly(), "nobody", "pick", () => undefined)).toEqual({ ok: false, reason: "not-placed" });
  });

  it("makes a chosen RDP session a child that closing the parent closes too", () => {
    const opened = done(openBeside(parentOnly(), "p", "pick", () => undefined));
    const chosen = done(replaceChoosePanel(opened, "pick", "rdp", RDP, NO_LIVE));
    expect(chosen.panels.rdp).toEqual({ ref: RDP, parent: "p" });
    expect(blockChildren(chosen, "p", stored(chosen))).toEqual(["rdp"]);
    const closed = done(closeBlock(chosen, "p", stored(chosen), NO_LIVE));
    expect(placed(closed)).toEqual([]);
    expect(closed.panels).toEqual({});
  });
});

describe("choosing a panel the document already has, in a picker beside a parent", () => {
  const RDP = { provider: "remote-rdp-live", params: { resourceRef: "6f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f" } };
  const picker = { ref: { provider: CHOOSE_PROVIDER, params: { kind: "any" } }, parent: "p" };
  const stored = (document: WorkspaceDocument): ParentOf => (panelId) => document.panels[panelId]?.parent;
  /** Parents p and q placed, a picker beside p, and a hidden panel `h` with the given stored parent. */
  function hiddenOnDocument(hiddenParent: string | undefined, extra: Record<string, WorkspacePanel> = {}, placedIds = ["p", "q", "pick"]): WorkspaceDocument {
    return {
      schemaVersion: 3, revision: 0,
      panels: { p: thread("p"), q: thread("q"), pick: picker, h: hiddenParent === undefined ? { ref: RDP } : { ref: RDP, parent: hiddenParent }, ...extra },
      layouts: [{ id: "layout-1", name: "Работа", workspace: createWorkspace(placedIds) }],
      activeLayoutId: "layout-1",
    };
  }

  it.each([["another parent", "q"], ["no parent", undefined]])("joins the block of the picker's parent, not the block of %s", (_name, oldParent) => {
    const chosen = done(replaceChoosePanel(hiddenOnDocument(oldParent), "pick", "new", RDP, NO_LIVE));
    expect(chosen.panels.h).toEqual({ ref: RDP, parent: "p" });
    expect(placed(chosen)).toContain("h");
    expect(blockChildren(chosen, "p", stored(chosen))).toEqual(["h"]);
    expect(blockChildren(chosen, "q", stored(chosen))).toEqual([]);
    const closed = done(closeBlock(chosen, "p", stored(chosen), NO_LIVE));
    expect(placed(closed)).toEqual(["q"]);
  });

  it("is refused, with nothing changed, when the hidden panel is an ancestor of the picker's parent", () => {
    // p's own stored parent is h: h becoming p's child would make a cycle.
    const document = hiddenOnDocument(undefined, { p: { ...thread("p"), parent: "h" } });
    expect(replaceChoosePanel(document, "pick", "new", RDP, NO_LIVE)).toEqual({ ok: false, reason: "invalid-panel" });
  });
});
