// Document operations on the stage A document: named layouts, panels and
// templates. Expected documents are literals built on the fixture.
import { describe, expect, it } from "vitest";
import { createWorkspace, maximizeGroup, splitGroup } from "../../../src/core/layout/index.ts";
import {
  activeLayout,
  addLayoutFromTemplate,
  addPanelToGroup,
  changeActiveLayout,
  createLayout,
  deleteLayout,
  dropUnusedPanels,
  duplicateLayout,
  hiddenPanels,
  panelIdOfRef,
  registerPanel,
  removePanelFromLayout,
  renameLayout,
  switchLayout,
  workspaceDocumentSchema,
} from "../../../src/core/workspace/index.ts";
import type { LayoutTemplate, WorkspaceChange, WorkspaceDocument } from "../../../src/core/workspace/index.ts";
import { stageADocument, stageAJson } from "./fixtures.ts";

const NO_LIVE_PANELS: ReadonlySet<string> = new Set();

function done(change: WorkspaceChange): WorkspaceDocument {
  if (!change.ok) throw new Error("expected the change to apply, got " + change.reason);
  return change.document;
}

const PICKER = {
  root: { kind: "group", id: "group-1", tabs: [], activeTab: null },
  focusedGroupId: "group-1",
  maximizedGroupId: null,
  nextNodeId: 2,
};

describe("named layouts", () => {
  it("creates a layout with one content-picker tile and opens it", () => {
    const expected = stageAJson();
    expected.layouts.push({ id: "layout-call", name: "Созвон", workspace: PICKER });
    expected.activeLayoutId = "layout-call";
    const created = done(createLayout(stageADocument(), "layout-call", "  Созвон "));
    expect(created).toEqual(expected);
    expect(hiddenPanels(created).map((panel) => panel.panelId)).toEqual(["thread-a", "thread-b", "frame"]);
  });

  it.each([
    ["an id in use", "layout-dev", "Созвон", "layout-exists"],
    ["an empty id", "", "Созвон", "invalid-id"],
    ["an id with a space", "layout call", "Созвон", "invalid-id"],
    ["an empty name", "layout-call", "   ", "invalid-name"],
    ["a name of 65 characters", "layout-call", "я".repeat(65), "invalid-name"],
    ["a name with a line break", "layout-call", "Со\nзвон", "invalid-name"],
    ["a name with a link that has a password", "layout-call", "Созвон https://zoom.example/j/812?pwd=fixture", "invalid-name"],
    ["the name Authorization=Bearer synthetic-test-value", "layout-call", "Authorization=Bearer synthetic-test-value", "invalid-name"],
    ["the name Authorization: Bearer synthetic-test-value", "layout-call", "Authorization: Bearer synthetic-test-value", "invalid-name"],
    ["the name authorization synthetic-test-value", "layout-call", "authorization synthetic-test-value", "invalid-name"],
    ["the name BEARER synthetic-test-value", "layout-call", "BEARER synthetic-test-value", "invalid-name"],
    ["the name Bearer:synthetic-test-value", "layout-call", "Bearer:synthetic-test-value", "invalid-name"],
    ["the name B-e-a-r-e-r synthetic-test-value", "layout-call", "B-e-a-r-e-r synthetic-test-value", "invalid-name"],
    ["the name Basic YTpi", "layout-call", "Basic YTpi", "invalid-name"],
    ["the name basic:YTpi", "layout-call", "basic:YTpi", "invalid-name"],
    ["the name BASIC  a", "layout-call", "BASIC  a", "invalid-name"],
    ["the name Basic layout", "layout-call", "Basic layout", "invalid-name"],
    ["the name Fix token refresh", "layout-call", "Fix token refresh", "invalid-name"],
    ["the name Вход api key synthetic", "layout-call", "Вход api key synthetic", "invalid-name"],
    ["the name accessToken synthetic", "layout-call", "accessToken synthetic", "invalid-name"],
    ["the name Пароль hunter2", "layout-call", "Пароль hunter2", "invalid-name"],
    ["the name root:hunter2@build-1", "layout-call", "root:hunter2@build-1", "invalid-name"],
    ["the name Сборка %41", "layout-call", "Сборка %41", "invalid-name"],
    ["the name Сборка &#65;", "layout-call", "Сборка &#65;", "invalid-name"],
    ["the name Bearer synthetic-test-value", "layout-call", "Bearer synthetic-test-value", "invalid-name"],
  ])("does not create a layout with %s", (_name, id, name, reason) => {
    expect(createLayout(stageADocument(), id, name)).toEqual({ ok: false, reason });
  });

  it.each([["Разработка"], ["Ревью"], ["Q&A (черновик)"], ["Fix 50% CPU usage"], ["Дизайн №2"], ["build-1: логи, часть 2/3"], ["Basic"], ["C# & F#"]])(
    "accepts the name %s as it is typed",
    (name) => {
      expect(done(createLayout(stageADocument(), "layout-call", name)).layouts[2].name).toBe(name);
    },
  );

  it("refuses a name with a credential marker as a whole: nothing of it is stored", () => {
    const before = stageADocument();
    for (const name of ["Authorization=Bearer synthetic-test-value", "Basic YTpi"]) {
      expect(createLayout(before, "layout-call", name)).toEqual({ ok: false, reason: "invalid-name" });
      expect(renameLayout(before, "layout-dev", name)).toEqual({ ok: false, reason: "invalid-name" });
      expect(duplicateLayout(before, "layout-dev", "layout-call", name)).toEqual({ ok: false, reason: "invalid-name" });
    }
    expect(before).toEqual(stageADocument());
  });

  it("accepts a name of 64 characters", () => {
    expect(done(createLayout(stageADocument(), "layout-call", "я".repeat(64))).layouts[2].name).toBe("я".repeat(64));
  });

  it("renames a layout and nothing else", () => {
    const expected = stageAJson();
    expected.layouts[0].name = "Сборка";
    expect(done(renameLayout(stageADocument(), "layout-dev", "Сборка"))).toEqual(expected);
    expect(renameLayout(stageADocument(), "layout-x", "Сборка")).toEqual({ ok: false, reason: "unknown-layout" });
    expect(renameLayout(stageADocument(), "layout-dev", "")).toEqual({ ok: false, reason: "invalid-name" });
    expect(renameLayout(stageADocument(), "layout-dev", "zoom.example/j/812?pwd=fixture")).toEqual({ ok: false, reason: "invalid-name" });
  });

  it("duplicates a layout right after its source and opens the copy", () => {
    const expected = stageAJson();
    expected.layouts = [expected.layouts[0], { ...stageAJson().layouts[0], id: "layout-dev-2", name: "Разработка 2" }, expected.layouts[1]];
    expected.activeLayoutId = "layout-dev-2";
    const before = stageADocument();
    const after = done(duplicateLayout(before, "layout-dev", "layout-dev-2", "Разработка 2"));
    expect(after).toEqual(expected);
    expect(after.panels).toBe(before.panels);
    expect(duplicateLayout(before, "layout-x", "layout-dev-2", "Копия")).toEqual({ ok: false, reason: "unknown-layout" });
    expect(duplicateLayout(before, "layout-dev", "layout-review", "Копия")).toEqual({ ok: false, reason: "layout-exists" });
    expect(duplicateLayout(before, "layout-dev", "layout-dev-2", " ")).toEqual({ ok: false, reason: "invalid-name" });
  });

  it("deleting the active layout opens its neighbour and forgets panels nothing shows", () => {
    const expected = stageAJson();
    expected.layouts = [expected.layouts[1]];
    delete expected.panels["thread-b"];
    const afterDev = done(deleteLayout(done(switchLayout(stageADocument(), "layout-dev")), "layout-dev", NO_LIVE_PANELS));
    expect(afterDev).toEqual(expected);
  });

  it("deleting the active last layout of three opens the one before it", () => {
    const three = done(createLayout(stageADocument(), "layout-call", "Созвон"));
    expect(three.activeLayoutId).toBe("layout-call");
    expect(done(deleteLayout(three, "layout-call", new Set(["thread-b"])))).toEqual(stageADocument());
  });

  it("deleting a layout keeps the reference of a panel that is still live", () => {
    const expected = stageAJson();
    expected.layouts = [expected.layouts[1]];
    expect(done(deleteLayout(stageADocument(), "layout-dev", new Set(["thread-b"])))).toEqual(expected);
  });

  it("deleting another layout leaves the active one open", () => {
    const expected = stageAJson();
    expected.layouts = [expected.layouts[0]];
    expected.activeLayoutId = "layout-dev";
    const onDev = done(switchLayout(stageADocument(), "layout-dev"));
    expect(done(deleteLayout(onDev, "layout-review", NO_LIVE_PANELS))).toEqual(expected);
  });

  it("does not delete an unknown layout or the last one", () => {
    expect(deleteLayout(stageADocument(), "layout-x", NO_LIVE_PANELS)).toEqual({ ok: false, reason: "unknown-layout" });
    const single = done(deleteLayout(stageADocument(), "layout-dev", NO_LIVE_PANELS));
    expect(deleteLayout(single, "layout-review", NO_LIVE_PANELS)).toEqual({ ok: false, reason: "last-layout" });
  });

  it("switches to a known layout only, and returns the same document when it is already open", () => {
    const document = stageADocument();
    expect(switchLayout(document, "layout-x")).toEqual({ ok: false, reason: "unknown-layout" });
    expect(done(switchLayout(document, "layout-review"))).toBe(document);
    expect(activeLayout(document).name).toBe("Ревью");
  });

  it("keeps focus and maximize per layout", () => {
    const maximized = done(changeActiveLayout(stageADocument(), (workspace) => maximizeGroup(workspace, "group-1")));
    const expected = stageAJson();
    expected.layouts[1].workspace.focusedGroupId = "group-1";
    expected.layouts[1].workspace.maximizedGroupId = "group-1";
    expect(maximized).toEqual(expected);
    const back = done(switchLayout(done(switchLayout(maximized, "layout-dev")), "layout-review"));
    expect(back).toEqual(expected);
  });
});

describe("panels", () => {
  it("adds a hidden panel to a group of the active layout as its active tab", () => {
    const expected = stageAJson();
    expected.layouts[1].workspace.root.children[0] = { kind: "group", id: "group-1", tabs: ["frame", "thread-b"], activeTab: "thread-b" };
    expected.layouts[1].workspace.focusedGroupId = "group-1";
    const after = done(addPanelToGroup(stageADocument(), "group-1", "thread-b"));
    expect(after).toEqual(expected);
    expect(hiddenPanels(after)).toEqual([]);
  });

  it("adds a new panel with its reference", () => {
    const expected = stageAJson();
    expected.panels.terminal = { ref: { provider: "remote-ssh", params: { connectionId: "build-1" } } };
    expected.layouts[1].workspace.root.children[1] = { kind: "group", id: "group-2", tabs: ["thread-a", "terminal"], activeTab: "terminal" };
    const panel = { ref: { provider: "remote-ssh", params: { connectionId: "build-1" } } };
    expect(done(addPanelToGroup(stageADocument(), "group-2", "terminal", panel))).toEqual(expected);
  });

  it.each([
    ["a panel already in the layout", "group-1", "thread-a", undefined, "already-placed"],
    ["an unknown group", "group-9", "thread-b", undefined, "unknown-group"],
    ["an unknown panel without a reference", "group-1", "terminal", undefined, "unknown-panel"],
    ["a reference with a password", "group-1", "terminal", { ref: { provider: "remote-ssh", params: { password: "hunter2" } } }, "invalid-panel"],
    ["a reference with an instance id", "group-1", "terminal", { ref: { provider: "remote-ssh", params: {}, instanceId: "panel-3" } }, "invalid-panel"],
    ["a reference with an instance id among its parameters", "group-1", "terminal", { ref: { provider: "remote-ssh", params: { instanceId: "live-1" } } }, "invalid-panel"],
    ["a panel id with a space", "group-1", "my terminal", { ref: { provider: "remote-ssh", params: {} } }, "invalid-id"],
    ["another reference under an id in use", "group-1", "thread-b", { ref: { provider: "bb-thread", params: { threadId: "thr_c" } } }, "panel-conflict"],
  ])("does not add %s", (_name, groupId, panelId, panel, reason) => {
    expect(addPanelToGroup(stageADocument(), groupId, panelId, panel as never)).toEqual({ ok: false, reason });
  });

  it("registering a known reference again keeps the stored entry", () => {
    const document = stageADocument();
    const again = registerPanel(document, "thread-b", { ref: { provider: "bb-thread", params: { threadId: "thr_b" } } });
    expect(done(again)).toBe(document);
  });

  it("finds the panel id of a reference", () => {
    expect(panelIdOfRef(stageADocument(), { provider: "bb-thread", params: { threadId: "thr_b" } })).toBe("thread-b");
    expect(panelIdOfRef(stageADocument(), { provider: "bb-thread", params: { threadId: "thr_c" } })).toBeUndefined();
  });

  it("removing a panel no layout shows any more forgets its reference", () => {
    const onDev = done(switchLayout(stageADocument(), "layout-dev"));
    const after = done(removePanelFromLayout(onDev, "thread-b", NO_LIVE_PANELS));
    expect(Object.keys(after.panels)).toEqual(["thread-a", "frame"]);
    expect(after.layouts[0].workspace).toEqual({
      root: {
        kind: "split",
        id: "split-3",
        direction: "row",
        children: [
          { kind: "group", id: "group-1", tabs: ["thread-a"], activeTab: "thread-a" },
          { kind: "group", id: "group-4", tabs: ["frame"], activeTab: "frame" },
        ],
        sizes: [0.5, 0.5],
      },
      focusedGroupId: "group-4",
      maximizedGroupId: null,
      nextNodeId: 6,
    });
  });

  it("removing a panel keeps its reference while a live instance uses it, until it is dropped", () => {
    const onDev = done(switchLayout(stageADocument(), "layout-dev"));
    const hidden = done(removePanelFromLayout(onDev, "thread-b", new Set(["thread-b"])));
    expect(hiddenPanels(hidden)).toEqual([{ panelId: "thread-b", ref: { provider: "bb-thread", params: { threadId: "thr_b" } } }]);
    expect(dropUnusedPanels(hidden, new Set(["thread-b"]))).toBe(hidden);
    expect(Object.keys(dropUnusedPanels(hidden, NO_LIVE_PANELS).panels)).toEqual(["thread-a", "frame"]);
  });

  it("does not remove a panel the active layout does not show", () => {
    expect(removePanelFromLayout(stageADocument(), "thread-b", NO_LIVE_PANELS)).toEqual({ ok: false, reason: "not-placed" });
  });

  it("removing the last panel of a layout leaves the content picker", () => {
    let document = done(removePanelFromLayout(stageADocument(), "thread-a", NO_LIVE_PANELS));
    document = done(removePanelFromLayout(document, "frame", NO_LIVE_PANELS));
    expect(activeLayout(document).workspace).toEqual({
      root: { kind: "group", id: "group-4", tabs: [], activeTab: null },
      focusedGroupId: "group-4",
      maximizedGroupId: null,
      nextNodeId: 5,
    });
    expect(workspaceDocumentSchema.safeParse(document).success).toBe(true);
  });
});

describe("layout templates", () => {
  const CALL: LayoutTemplate = {
    name: "Созвон",
    panels: {
      call: { ref: { provider: "zoom-meeting", params: { meetingId: "81234567890" } } },
      "thread-a": { ref: { provider: "bb-thread", params: { threadId: "thr_a" } } },
    },
    workspace: splitGroup(createWorkspace(["call"]), "group-1", "right", "thread-a"),
  };

  it("adds a preset as data: its layout and references, without opening it", () => {
    const expected = stageAJson();
    expected.panels.call = { ref: { provider: "zoom-meeting", params: { meetingId: "81234567890" } } };
    expected.layouts.push({
      id: "layout-call",
      name: "Созвон",
      workspace: {
        root: {
          kind: "split",
          id: "split-3",
          direction: "row",
          children: [
            { kind: "group", id: "group-1", tabs: ["call"], activeTab: "call" },
            { kind: "group", id: "group-2", tabs: ["thread-a"], activeTab: "thread-a" },
          ],
          sizes: [0.5, 0.5],
        },
        focusedGroupId: "group-2",
        maximizedGroupId: null,
        nextNodeId: 4,
      },
    });
    const after = done(addLayoutFromTemplate(stageADocument(), "layout-call", CALL));
    expect(after).toEqual(expected);
    expect(after.activeLayoutId).toBe("layout-review");
    expect(after.panels).toEqual({ ...stageADocument().panels, call: { ref: { provider: "zoom-meeting", params: { meetingId: "81234567890" } } } });
  });

  it.each([
    ["an id in use", "layout-dev", CALL, "layout-exists"],
    ["a panel id that already names another reference", "layout-call", { ...CALL, panels: { ...CALL.panels, "thread-a": { ref: { provider: "bb-thread", params: { threadId: "thr_z" } } } } }, "panel-conflict"],
    ["a tile for a panel it does not describe", "layout-call", { ...CALL, panels: { call: CALL.panels.call } }, "unknown-panel"],
    ["a reference with a token", "layout-call", { ...CALL, panels: { ...CALL.panels, call: { ref: { provider: "zoom-meeting", params: { token: "t" } } } } }, "invalid-panel"],
    ["a broken tree", "layout-call", { ...CALL, workspace: { ...CALL.workspace, focusedGroupId: "group-8" } }, "invalid-layout"],
    ["an empty name", "layout-call", { ...CALL, name: "" }, "invalid-name"],
  ])("does not add a template with %s", (_name, id, template, reason) => {
    expect(addLayoutFromTemplate(stageADocument(), id, template)).toEqual({ ok: false, reason });
  });
});
