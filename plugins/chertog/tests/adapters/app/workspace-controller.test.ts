// The workspace controller against a fake RPC: what the first and the next
// entry show, the order of saves, a conflict of two windows, and a failed
// save that must not lose what the window holds.
import { describe, expect, it } from "vitest";
import { splitGroup } from "../../../src/core/layout/index.ts";
import type { WorkspaceDocument } from "../../../src/core/workspace/index.ts";
import { changeActiveLayout, createLayout, registerPanel, renameLayout, switchLayout } from "../../../src/core/workspace/index.ts";
import { MAX_CONFLICTS_IN_A_ROW, WorkspaceController } from "../../../src/adapters/bb/app/workspace-controller.ts";
import { stageADocument } from "../../core/workspace/fixtures.ts";
import { FakeWorkspaceRpc, settle } from "./support.ts";

function controllerOver(rpc: FakeWorkspaceRpc, live: ReadonlySet<string> = new Set()) {
  const renamed: Array<readonly { from: string; to: string }[]> = [];
  const controller = new WorkspaceController({
    rpc,
    first: { layoutId: "layout-main", name: "Основная" },
    livePanelIds: () => live,
    onPanelsRenamed: (renames) => renamed.push(renames),
  });
  return { controller, renamed };
}

function documentOf(controller: WorkspaceController): WorkspaceDocument {
  const document = controller.getSnapshot().document;
  if (document === null) throw new Error("the workspace is not loaded");
  return document;
}

const EMPTY_TILE = {
  root: { kind: "group", id: "group-1", tabs: [], activeTab: null },
  focusedGroupId: "group-1",
  maximizedGroupId: null,
  nextNodeId: 2,
};

describe("entry", () => {
  it("shows one content-picker tile on the first entry and saves nothing", async () => {
    const rpc = new FakeWorkspaceRpc();
    const { controller } = controllerOver(rpc);
    expect(controller.getSnapshot().phase).toBe("idle");
    await controller.enter();

    const snapshot = controller.getSnapshot();
    expect(snapshot.phase).toBe("ready");
    expect(snapshot.origin).toBe("first-entry");
    expect(snapshot.document).toEqual({
      schemaVersion: 2,
      revision: 0,
      panels: {},
      layouts: [{ id: "layout-main", name: "Основная", workspace: EMPTY_TILE }],
      activeLayoutId: "layout-main",
    });
    expect(snapshot.save).toEqual({ status: "saved" });
    expect(rpc.saves).toEqual([]);
  });

  it("opens the last active layout on the next entry", async () => {
    const rpc = new FakeWorkspaceRpc();
    rpc.stored = { ...stageADocument(), revision: 7 };
    const { controller } = controllerOver(rpc);
    await controller.enter();

    expect(controller.getSnapshot().origin).toBe("restored");
    expect(documentOf(controller).activeLayoutId).toBe("layout-review");
    expect(documentOf(controller).revision).toBe(7);
    expect(rpc.saves).toEqual([]);
  });

  it("loads once however many times the route asks", async () => {
    const rpc = new FakeWorkspaceRpc();
    const { controller } = controllerOver(rpc);
    await Promise.all([controller.enter(), controller.enter()]);
    await controller.enter();
    expect(rpc.loads).toBe(1);
  });

  it("reports a failed load and loads again on the next attempt", async () => {
    const rpc = new FakeWorkspaceRpc();
    rpc.loadFailure = new Error("сервер недоступен");
    const { controller } = controllerOver(rpc);
    await controller.enter();
    expect(controller.getSnapshot()).toMatchObject({ phase: "failed", loadError: "сервер недоступен", document: null });

    rpc.loadFailure = null;
    await controller.enter();
    expect(controller.getSnapshot()).toMatchObject({ phase: "ready", loadError: null });
    expect(rpc.loads).toBe(2);
  });

  it("does not save over a document of a newer version", async () => {
    const rpc = new FakeWorkspaceRpc();
    rpc.loadAnswer = { status: "newer", schemaVersion: 9 };
    const { controller } = controllerOver(rpc);
    await controller.enter();
    expect(controller.getSnapshot()).toMatchObject({ origin: "newer-version", save: { status: "off" } });

    expect(controller.change((document) => createLayout(document, "layout-2", "Ревью"))).toBeNull();
    await controller.whenIdle();
    expect(documentOf(controller).layouts.map((layout) => layout.name)).toEqual(["Основная", "Ревью"]);
    expect(rpc.saves).toEqual([]);
    expect(controller.getSnapshot().save).toEqual({ status: "off" });
  });

  it("carries the parts the reader left out", async () => {
    const rpc = new FakeWorkspaceRpc();
    rpc.loadAnswer = {
      status: "ok",
      document: stageADocument(),
      migratedFrom: null,
      dropped: [{ kind: "panel", panelId: "ghost", reason: "A tile shows a panel the document has no reference for" }],
    };
    const { controller } = controllerOver(rpc);
    await controller.enter();
    expect(controller.getSnapshot().dropped).toEqual([
      { kind: "panel", panelId: "ghost", reason: "A tile shows a panel the document has no reference for" },
    ]);
  });
});

describe("saving", () => {
  it("saves a change against the revision it was made from", async () => {
    const rpc = new FakeWorkspaceRpc();
    const { controller } = controllerOver(rpc);
    await controller.enter();
    controller.change((document) => createLayout(document, "layout-2", "Разработка"));
    expect(controller.getSnapshot().save).toEqual({ status: "saving" });
    await controller.whenIdle();

    expect(rpc.saves.map((call) => call.expectedRevision)).toEqual([0]);
    expect(rpc.stored?.revision).toBe(1);
    expect(rpc.stored?.layouts.map((layout) => layout.name)).toEqual(["Основная", "Разработка"]);
    expect(documentOf(controller).revision).toBe(1);
    expect(controller.getSnapshot().save).toEqual({ status: "saved" });
  });

  it("sends one save at a time and ends with the last state", async () => {
    const rpc = new FakeWorkspaceRpc();
    const { controller } = controllerOver(rpc);
    await controller.enter();

    rpc.hold();
    controller.change((document) => createLayout(document, "layout-2", "Первая"));
    await settle();
    controller.change((document) => renameLayout(document, "layout-2", "Вторая"));
    controller.change((document) => renameLayout(document, "layout-2", "Третья"));
    await settle();
    // The first save is still on its way: nothing else was sent.
    expect(rpc.saves).toHaveLength(1);
    rpc.release();
    await controller.whenIdle();

    expect(rpc.saves.map((call) => [call.expectedRevision, call.document.layouts[1].name])).toEqual([
      [0, "Первая"],
      [1, "Третья"],
    ]);
    expect(rpc.stored?.revision).toBe(2);
    expect(rpc.stored?.layouts[1].name).toBe("Третья");
    expect(documentOf(controller)).toEqual(rpc.stored);
  });

  it("does not save a change that changes nothing, and reports a refused one", async () => {
    const rpc = new FakeWorkspaceRpc();
    const { controller } = controllerOver(rpc);
    await controller.enter();

    expect(controller.change((document) => switchLayout(document, "layout-main"))).toBeNull();
    expect(controller.change((document) => renameLayout(document, "layout-main", "token=abc"))).toBe("invalid-name");
    await controller.whenIdle();
    expect(rpc.saves).toEqual([]);
    expect(controller.getSnapshot().refusal).toBe("invalid-name");
    expect(documentOf(controller).layouts[0].name).toBe("Основная");

    controller.dismissRefusal();
    expect(controller.getSnapshot().refusal).toBeNull();
  });

  it("drops the reference of a panel nothing shows any more", async () => {
    const rpc = new FakeWorkspaceRpc();
    const live = new Set<string>(["kept"]);
    const { controller } = controllerOver(rpc, live);
    await controller.enter();
    const ref = (threadId: string) => ({ ref: { provider: "bb-thread", params: { threadId } } });
    controller.change((document) => registerPanel(document, "kept", ref("thr_kept")));
    controller.change((document) => registerPanel(document, "gone", ref("thr_gone")));
    await controller.whenIdle();
    // "gone" is in no layout and has no live instance; "kept" is live.
    expect(Object.keys(documentOf(controller).panels)).toEqual(["kept"]);

    live.clear();
    controller.prune();
    await controller.whenIdle();
    expect(documentOf(controller).panels).toEqual({});
    expect(rpc.stored?.panels).toEqual({});
  });
});

describe("a failed save", () => {
  it("is shown, keeps the local state, and an explicit retry saves subsequent edits too", async () => {
    const rpc = new FakeWorkspaceRpc();
    const { controller } = controllerOver(rpc);
    await controller.enter();

    rpc.saveFailures.push(new Error("нет сети"));
    controller.change((document) => createLayout(document, "layout-2", "Разработка"));
    await controller.whenIdle();
    expect(controller.getSnapshot().save).toEqual({ status: "failed", kind: "transport", reason: "нет сети" });
    expect(documentOf(controller).layouts.map((layout) => layout.name)).toEqual(["Основная", "Разработка"]);
    expect(rpc.stored).toBeNull();

    controller.change((document) => createLayout(document, "layout-3", "Ревью"));
    await controller.whenIdle();
    expect(controller.getSnapshot().save.status).toBe("failed");
    expect(rpc.saves).toHaveLength(1);
    controller.retrySave();
    await controller.whenIdle();
    expect(controller.getSnapshot().save).toEqual({ status: "saved" });
    expect(rpc.saves.map((call) => call.expectedRevision)).toEqual([0, 0]);
    expect(rpc.stored?.layouts.map((layout) => layout.name)).toEqual(["Основная", "Разработка", "Ревью"]);
  });

  it("is sent again on request without a new change", async () => {
    const rpc = new FakeWorkspaceRpc();
    const { controller } = controllerOver(rpc);
    await controller.enter();
    rpc.saveFailures.push(new Error("нет сети"));
    controller.change((document) => createLayout(document, "layout-2", "Разработка"));
    await controller.whenIdle();

    controller.retrySave();
    await controller.whenIdle();
    expect(controller.getSnapshot().save).toEqual({ status: "saved" });
    expect(rpc.stored?.layouts.map((layout) => layout.name)).toEqual(["Основная", "Разработка"]);
  });

  it("shows a document the server refused and keeps it in the window", async () => {
    const rpc = new FakeWorkspaceRpc();
    const { controller } = controllerOver(rpc);
    await controller.enter();
    rpc.saveAnswers.push({ status: "rejected", reason: "layouts.1.name: A name must not carry a link or credentials" });
    controller.change((document) => createLayout(document, "layout-2", "Разработка"));
    await controller.whenIdle();

    expect(controller.getSnapshot().save).toEqual({
      status: "failed",
      kind: "rejected",
      reason: "layouts.1.name: A name must not carry a link or credentials",
    });
    expect(documentOf(controller).layouts).toHaveLength(2);
    expect(rpc.saves).toHaveLength(1);
  });
});

describe("two windows", () => {
  it("merges the other window's layout into its own and saves the result", async () => {
    const rpc = new FakeWorkspaceRpc();
    const { controller, renamed } = controllerOver(rpc);
    await controller.enter();
    // The other window entered the same empty workspace and saved first.
    const theirs = createLayout(documentOf(controller), "layout-theirs", "Созвон");
    if (!theirs.ok) throw new Error("fixture");
    rpc.stored = { ...theirs.document, activeLayoutId: "layout-theirs", revision: 1 };

    controller.change((document) => createLayout(document, "layout-mine", "Разработка"));
    await controller.whenIdle();

    expect(rpc.saves.map((call) => call.expectedRevision)).toEqual([0, 1]);
    expect(rpc.stored?.revision).toBe(2);
    expect(rpc.stored?.layouts.map((layout) => [layout.id, layout.name])).toEqual([
      ["layout-main", "Основная"],
      ["layout-theirs", "Созвон"],
      ["layout-mine", "Разработка"],
    ]);
    // This window stays on the layout it had open.
    expect(documentOf(controller).activeLayoutId).toBe("layout-mine");
    expect(controller.getSnapshot().save).toEqual({ status: "saved" });
    expect(controller.getSnapshot().merge).toEqual({ renamedLayouts: [], renamedPanels: [] });
    expect(renamed).toEqual([]);

    controller.dismissMerge();
    expect(controller.getSnapshot().merge).toBeNull();
  });

  it("keeps both versions of a layout both windows changed and names the copy", async () => {
    const rpc = new FakeWorkspaceRpc();
    rpc.stored = { ...stageADocument(), activeLayoutId: "layout-dev", revision: 3 };
    const { controller } = controllerOver(rpc);
    await controller.enter();
    // The other window splits "Разработка" its own way and saves.
    const other = changeActiveLayout(documentOf(controller), (workspace) => ({ ...workspace, focusedGroupId: "group-1" }));
    if (!other.ok) throw new Error("fixture");
    rpc.stored = { ...other.document, revision: 4 };

    controller.change((document) => changeActiveLayout(document, (workspace) => ({ ...workspace, focusedGroupId: "group-2" })));
    await controller.whenIdle();

    expect(controller.getSnapshot().merge).toEqual({
      renamedLayouts: [{ from: "layout-dev", to: "layout-dev-2", name: "Разработка" }],
      renamedPanels: [],
    });
    expect(rpc.stored?.revision).toBe(5);
    expect(rpc.stored?.layouts.map((layout) => [layout.id, layout.workspace.focusedGroupId])).toEqual([
      ["layout-dev", "group-1"],
      ["layout-review", "group-2"],
      ["layout-dev-2", "group-2"],
    ]);
    expect(documentOf(controller).activeLayoutId).toBe("layout-dev-2");
  });

  it("tells the window which of its panels got a new id", async () => {
    const rpc = new FakeWorkspaceRpc();
    const live = new Set<string>(["panel-1"]);
    const { controller, renamed } = controllerOver(rpc, live);
    await controller.enter();
    const place = (threadId: string) => (document: WorkspaceDocument) => {
      const known = registerPanel(document, "panel-1", { ref: { provider: "bb-thread", params: { threadId } } });
      return known.ok ? changeActiveLayout(known.document, (workspace) => splitGroup(workspace, "group-1", "right", "panel-1")) : known;
    };
    const theirs = place("thr_theirs")(documentOf(controller));
    if (!theirs.ok) throw new Error("fixture");
    rpc.stored = { ...theirs.document, revision: 1 };

    controller.change(place("thr_mine"));
    await controller.whenIdle();

    expect(renamed).toEqual([[{ from: "panel-1", to: "panel-1-2" }]]);
    expect(controller.getSnapshot().merge?.renamedPanels).toEqual([{ from: "panel-1", to: "panel-1-2" }]);
    expect(documentOf(controller).panels["panel-1-2"]).toEqual({ ref: { provider: "bb-thread", params: { threadId: "thr_mine" } } });
    expect(documentOf(controller).panels["panel-1"]).toEqual({ ref: { provider: "bb-thread", params: { threadId: "thr_theirs" } } });
  });

  it("gives up after conflicts in a row, keeps the local state, and takes the stored version on reload", async () => {
    const rpc = new FakeWorkspaceRpc();
    rpc.stored = { ...stageADocument(), revision: 1 };
    const { controller } = controllerOver(rpc);
    await controller.enter();
    // Every save loses to another window that saved just before it.
    const moving = { ...stageADocument(), revision: 2 };
    for (let attempt = 0; attempt <= MAX_CONFLICTS_IN_A_ROW; attempt += 1) {
      rpc.saveAnswers.push({ status: "conflict", current: { ...moving, revision: 2 + attempt } });
    }

    controller.change((document) => createLayout(document, "layout-mine", "Моя"));
    await controller.whenIdle();
    expect(rpc.saves).toHaveLength(MAX_CONFLICTS_IN_A_ROW + 1);
    expect(MAX_CONFLICTS_IN_A_ROW).toBe(3);
    expect(controller.getSnapshot().save).toEqual({ status: "conflict" });
    expect(documentOf(controller).layouts.map((layout) => layout.id)).toContain("layout-mine");

    await controller.reload();
    expect(controller.getSnapshot().save).toEqual({ status: "saved" });
    expect(documentOf(controller)).toEqual({ ...stageADocument(), revision: 1 });
  });

  it("saves from scratch when storage was emptied meanwhile", async () => {
    const rpc = new FakeWorkspaceRpc();
    rpc.stored = { ...stageADocument(), revision: 4 };
    const { controller } = controllerOver(rpc);
    await controller.enter();
    rpc.stored = null;

    controller.change((document) => switchLayout(document, "layout-dev"));
    await controller.whenIdle();
    expect(rpc.saves.map((call) => call.expectedRevision)).toEqual([4, 0]);
    expect(rpc.stored).toEqual({ ...stageADocument(), activeLayoutId: "layout-dev", revision: 1 });
  });
});
