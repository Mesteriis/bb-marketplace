// Stage A of the spec, driven through the document operations: the layouts
// "Разработка" and "Ревью" share the frame at different places, and thread B
// is hidden in "Ревью". Every expected document is a literal.
import { describe, expect, it } from "vitest";
import { splitGroup, swapGroups } from "../../../src/core/layout/index.ts";
import type { WorkspaceState } from "../../../src/core/layout/index.ts";
import {
  addPanelToGroup,
  applyLayoutOperation,
  changeActiveLayout,
  createLayout,
  hiddenPanels,
  initialDocument,
  registerPanel,
  removePanelFromLayout,
  switchLayout,
  workspaceDocumentSchema,
} from "../../../src/core/workspace/index.ts";
import type { WorkspaceChange, WorkspaceDocument, WorkspacePanel } from "../../../src/core/workspace/index.ts";
import { stageADocument, stageAJson } from "./fixtures.ts";

const THREAD_A: WorkspacePanel = { ref: { provider: "bb-thread", params: { threadId: "thr_a" } } };
const THREAD_B: WorkspacePanel = { ref: { provider: "bb-thread", params: { threadId: "thr_b" } } };
const FRAME: WorkspacePanel = { ref: { provider: "chertog-frame", params: { frameId: "live-frame" } } };

const NO_LIVE_PANELS: ReadonlySet<string> = new Set();

function done(change: WorkspaceChange): WorkspaceDocument {
  if (!change.ok) throw new Error("expected the change to apply, got " + change.reason);
  return change.document;
}

/** Registers a panel and opens it in a new tile at an edge of a group of the active layout. */
function openBeside(document: WorkspaceDocument, panelId: string, panel: WorkspacePanel, groupId: string, edge: "right" | "bottom"): WorkspaceDocument {
  const registered = done(registerPanel(document, panelId, panel));
  return done(changeActiveLayout(registered, (workspace: WorkspaceState) => splitGroup(workspace, groupId, edge, panelId)));
}

/** The route of stage A from the first entry to both layouts. */
function buildStageA(): WorkspaceDocument {
  let document = initialDocument("layout-dev", "Разработка");
  document = done(addPanelToGroup(document, "group-1", "thread-a", THREAD_A));
  document = openBeside(document, "thread-b", THREAD_B, "group-1", "right");
  document = openBeside(document, "frame", FRAME, "group-2", "bottom");
  document = done(createLayout(document, "layout-review", "Ревью"));
  document = done(addPanelToGroup(document, "group-1", "frame"));
  return done(changeActiveLayout(document, (workspace) => splitGroup(workspace, "group-1", "right", "thread-a")));
}

describe("stage A: the layouts «Разработка» and «Ревью»", () => {
  it("builds both layouts with the shared panels at different places", () => {
    const document = buildStageA();
    expect(document).toEqual(stageADocument());
    expect(workspaceDocumentSchema.safeParse(document).success).toBe(true);
  });

  it("lists thread B as hidden in «Ревью» and nothing as hidden in «Разработка»", () => {
    const review = buildStageA();
    expect(hiddenPanels(review)).toEqual([
      { panelId: "thread-b", ref: { provider: "bb-thread", params: { threadId: "thr_b" } } },
    ]);
    const development = done(switchLayout(review, "layout-dev"));
    expect(development.activeLayoutId).toBe("layout-dev");
    expect(hiddenPanels(development)).toEqual([]);
  });

  it("switching layouts changes only the active id", () => {
    const review = buildStageA();
    const development = done(switchLayout(review, "layout-dev"));
    expect(development).toEqual({ ...stageADocument(), activeLayoutId: "layout-dev" });
    expect(development.layouts).toBe(review.layouts);
    expect(development.panels).toBe(review.panels);
    expect(done(switchLayout(development, "layout-review"))).toEqual(stageADocument());
  });

  it("a drop in «Ревью» moves the shared panel there and leaves «Разработка» as it was", () => {
    const before = buildStageA();
    const after = done(applyLayoutOperation(before, { type: "swapGroups", groupId: "group-1", targetGroupId: "group-2" }));
    const expected = stageAJson();
    expected.layouts[1] = {
      id: "layout-review",
      name: "Ревью",
      workspace: {
        root: {
          kind: "split",
          id: "split-3",
          direction: "row",
          children: [
            { kind: "group", id: "group-2", tabs: ["thread-a"], activeTab: "thread-a" },
            { kind: "group", id: "group-1", tabs: ["frame"], activeTab: "frame" },
          ],
          sizes: [0.5, 0.5],
        },
        focusedGroupId: "group-2",
        maximizedGroupId: null,
        nextNodeId: 4,
      },
    };
    expect(after).toEqual(expected);
    expect(after.layouts[0]).toBe(before.layouts[0]);
  });

  it("a layout operation that changes nothing returns the same document", () => {
    const before = buildStageA();
    const change = applyLayoutOperation(before, { type: "swapGroups", groupId: "group-1", targetGroupId: "group-1" });
    expect(change).toEqual({ ok: true, document: before });
    expect(done(change)).toBe(before);
  });

  it("removing thread A from «Ревью» keeps its reference: «Разработка» still shows it", () => {
    const after = done(removePanelFromLayout(buildStageA(), "thread-a", NO_LIVE_PANELS));
    const expected = stageAJson();
    expected.layouts[1] = {
      id: "layout-review",
      name: "Ревью",
      workspace: {
        root: { kind: "group", id: "group-1", tabs: ["frame"], activeTab: "frame" },
        focusedGroupId: "group-1",
        maximizedGroupId: null,
        nextNodeId: 4,
      },
    };
    expect(after).toEqual(expected);
    expect(hiddenPanels(after).map((panel) => panel.panelId)).toEqual(["thread-a", "thread-b"]);
  });

  it("a layout change may not place a panel the document does not know", () => {
    const before = buildStageA();
    const change = changeActiveLayout(before, (workspace) => swapGroups(splitGroup(workspace, "group-1", "top", "stranger"), "group-1", "group-2"));
    expect(change).toEqual({ ok: false, reason: "unknown-panel" });
  });
});
