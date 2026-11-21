// The store port rules: the first entry, saving against a revision, the
// conflict of two windows and the merge that keeps both windows' work.
import { describe, expect, it } from "vitest";
import { swapGroups } from "../../../src/core/layout/index.ts";
import {
  addPanelToGroup,
  changeActiveLayout,
  createLayout,
  decideSave,
  deleteLayout,
  enterWorkspace,
  initialDocument,
  mergeDocuments,
  readWorkspaceDocument,
  registerPanel,
  removePanelFromLayout,
  renameLayout,
  switchLayout,
} from "../../../src/core/workspace/index.ts";
import type { WorkspaceChange, WorkspaceDocument } from "../../../src/core/workspace/index.ts";
import { MemoryWorkspaceStore, stageADocument, stageAJson } from "./fixtures.ts";

const NO_LIVE_PANELS: ReadonlySet<string> = new Set();

function done(change: WorkspaceChange): WorkspaceDocument {
  if (!change.ok) throw new Error("expected the change to apply, got " + change.reason);
  return change.document;
}

const FIRST_DOCUMENT = {
  schemaVersion: 1,
  revision: 0,
  panels: {},
  layouts: [
    {
      id: "layout-1",
      name: "Раскладка 1",
      workspace: {
        root: { kind: "group", id: "group-1", tabs: [], activeTab: null },
        focusedGroupId: "group-1",
        maximizedGroupId: null,
        nextNodeId: 2,
      },
    },
  ],
  activeLayoutId: "layout-1",
};

const FIRST = { layoutId: "layout-1", name: "Раскладка 1" };

/** The review layout with its two tiles exchanged. */
const REVIEW_SWAPPED = {
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

const CALL_PICKER = {
  id: "layout-call",
  name: "Созвон",
  workspace: {
    root: { kind: "group", id: "group-1", tabs: [], activeTab: null },
    focusedGroupId: "group-1",
    maximizedGroupId: null,
    nextNodeId: 2,
  },
};

describe("entering the workspace", () => {
  it("the first entry gives one layout with one full-size content-picker tile", () => {
    expect(initialDocument("layout-1", "Раскладка 1")).toEqual(FIRST_DOCUMENT);
    const entry = enterWorkspace({ status: "empty" }, FIRST);
    expect(entry).toEqual({ origin: "first-entry", canSave: true, document: FIRST_DOCUMENT, layout: FIRST_DOCUMENT.layouts[0], dropped: [] });
  });

  it("a later entry opens the last active layout", () => {
    const stored = { ...stageAJson(), activeLayoutId: "layout-dev", revision: 7 };
    const entry = enterWorkspace(readWorkspaceDocument(stored), FIRST);
    expect(entry).toEqual({ origin: "restored", canSave: true, document: stored, layout: stageADocument().layouts[0], dropped: [] });
  });

  it("passes on what reading dropped", () => {
    const raw = stageAJson();
    raw.layouts[0].workspace.nextNodeId = 1.5;
    const entry = enterWorkspace(readWorkspaceDocument(raw), FIRST);
    expect(entry.origin).toBe("restored");
    expect(entry.layout.id).toBe("layout-review");
    expect(entry.dropped).toEqual([
      { kind: "layout", id: "layout-dev", name: "Разработка", reason: "workspace.nextNodeId: Invalid input: expected int, received number" },
    ]);
  });

  it.each([
    ["a newer version", { ...stageAJson(), schemaVersion: 9 }, "newer-version"],
    ["a damaged document", { schemaVersion: 1, layouts: "?" }, "corrupt"],
  ])("opens a fresh workspace that may not be saved over %s", (_name, raw, origin) => {
    const entry = enterWorkspace(readWorkspaceDocument(raw), FIRST);
    expect(entry).toEqual({ origin, canSave: false, document: FIRST_DOCUMENT, layout: FIRST_DOCUMENT.layouts[0], dropped: [] });
  });
});

describe("decideSave", () => {
  it("stores the first document at revision 1", () => {
    const result = decideSave(null, initialDocument("layout-1", "Раскладка 1"), 0);
    expect(result).toEqual({ status: "saved", document: { ...FIRST_DOCUMENT, revision: 1 } });
  });

  it("advances the revision by one on every save", () => {
    const stored = { ...stageADocument(), revision: 3 };
    const renamed = done(renameLayout(stored, "layout-dev", "Сборка"));
    const expected = stageAJson();
    expected.revision = 4;
    expected.layouts[0].name = "Сборка";
    expect(decideSave(stored, renamed, 3)).toEqual({ status: "saved", document: expected });
  });

  it("refuses a save made against an older revision and returns the stored document", () => {
    const stored = { ...stageADocument(), revision: 4 };
    const stale = done(renameLayout({ ...stageADocument(), revision: 3 }, "layout-dev", "Сборка"));
    const result = decideSave(stored, stale, 3);
    expect(result).toEqual({ status: "conflict", current: { ...stageADocument(), revision: 4 } });
    expect(result.status === "conflict" && result.current).toBe(stored);
  });

  it("refuses a save against a revision the storage has not reached", () => {
    expect(decideSave({ ...stageADocument(), revision: 2 }, stageADocument(), 5)).toEqual({
      status: "conflict",
      current: { ...stageADocument(), revision: 2 },
    });
    expect(decideSave(null, stageADocument(), 2)).toEqual({ status: "conflict", current: null });
    expect(decideSave(null, stageADocument(), -1)).toEqual({ status: "conflict", current: null });
  });

  it.each([
    ["a token in a panel reference", (document: any) => (document.panels.frame.ref.params.sessionToken = "tok-9"), "panels.frame.ref.params.sessionToken: A panel reference must not carry credentials"],
    ["an instance id among the parameters of a reference", (document: any) => (document.panels.frame.ref.params.instanceId = "live-1"), "panels.frame.ref.params.instanceId: A panel reference must not carry a live handle"],
    ["a link with a password in a title", (document: any) => (document.panels.frame.title = "https://zoom.example/j/812?pwd=fixture"), "panels.frame.title: A title must not carry a link with a secret"],
    ["a link with a password in a layout name", (document: any) => (document.layouts[0].name = "https://zoom.example/j/812?pwd=fixture"), "layouts.0.name: A name must not carry a link with a secret"],
    ["a live handle", (document: any) => (document.panels.frame.instanceId = "panel-2"), 'panels.frame: Unrecognized key: "instanceId"'],
    ["a tile for a panel without a reference", (document: any) => delete document.panels.frame, "layouts.0.workspace: the panel frame has no reference"],
    ["an active layout that does not exist", (document: any) => (document.activeLayoutId = "layout-x"), "activeLayoutId: the active layout layout-x does not exist"],
    ["two layouts with one id", (document: any) => (document.layouts[1].id = "layout-dev"), "layouts.1.id: the layout id layout-dev is used twice"],
    ["no layout", (document: any) => (document.layouts = []), "layouts: Too small: expected array to have >=1 items"],
  ])("rejects a document with %s and stores nothing", (_name, damage, reason) => {
    const document = stageAJson();
    damage(document);
    expect(decideSave(null, document, 0)).toEqual({ status: "rejected", reason });
  });
});

describe("two windows saving one workspace", () => {
  async function seeded(): Promise<{ store: MemoryWorkspaceStore; base: WorkspaceDocument }> {
    const store = new MemoryWorkspaceStore();
    const saved = await store.save(stageADocument(), 0);
    if (saved.status !== "saved") throw new Error("seeding failed");
    return { store, base: saved.document };
  }

  it("the second window's stale save is refused, merged and saved without losing either window's work", async () => {
    const { store, base } = await seeded();
    expect(base.revision).toBe(1);

    // Window 2 renames «Разработка», creates «Созвон» and saves first.
    const theirs = done(createLayout(done(renameLayout(base, "layout-dev", "Сборка")), "layout-call", "Созвон"));
    expect((await store.save(theirs, 1)).status).toBe("saved");

    // Window 1 exchanged the tiles of «Ревью» meanwhile.
    const mine = done(changeActiveLayout(base, (workspace) => swapGroups(workspace, "group-1", "group-2")));
    const refused = await store.save(mine, 1);
    expect(refused.status).toBe("conflict");
    if (refused.status !== "conflict" || refused.current === null) return;
    expect(refused.current.revision).toBe(2);
    expect(refused.current.layouts.map((layout) => layout.name)).toEqual(["Сборка", "Ревью", "Созвон"]);

    const merged = mergeDocuments(base, mine, refused.current, NO_LIVE_PANELS);
    const expected = stageAJson();
    expected.revision = 2;
    expected.layouts[0].name = "Сборка";
    expected.layouts[1] = REVIEW_SWAPPED;
    expected.layouts.push(CALL_PICKER);
    expect(merged).toEqual({ document: expected, overridden: [], renamedPanels: [] });

    const saved = await store.save(merged.document, refused.current.revision);
    expect(saved).toEqual({ status: "saved", document: { ...expected, revision: 3 } });
    expect(await store.load()).toEqual({ status: "ok", document: { ...expected, revision: 3 }, migratedFrom: null, dropped: [] });
  });

  it("when both windows changed one layout, the saving window wins and the layout is reported", () => {
    const base = { ...stageADocument(), revision: 1 };
    const mine = done(changeActiveLayout(base, (workspace) => swapGroups(workspace, "group-1", "group-2")));
    const theirs = { ...done(renameLayout(base, "layout-review", "Проверка")), revision: 2 };
    const expected = stageAJson();
    expected.revision = 2;
    expected.layouts[1] = REVIEW_SWAPPED;
    expect(mergeDocuments(base, mine, theirs, NO_LIVE_PANELS)).toEqual({ document: expected, overridden: ["layout-review"], renamedPanels: [] });
  });

  it("a layout this window deleted stays when the other window changed it", () => {
    const base = { ...stageADocument(), revision: 1 };
    const mine = done(deleteLayout(base, "layout-dev", NO_LIVE_PANELS));
    const theirs = { ...done(renameLayout(base, "layout-dev", "Сборка")), revision: 2 };
    const expected = stageAJson();
    expected.revision = 2;
    expected.layouts[0].name = "Сборка";
    expect(mergeDocuments(base, mine, theirs, NO_LIVE_PANELS)).toEqual({ document: expected, overridden: [], renamedPanels: [] });
  });

  it("a layout this window deleted goes when the other window left it alone, with the panels only it showed", () => {
    const base = { ...stageADocument(), revision: 1 };
    const mine = done(deleteLayout(base, "layout-dev", NO_LIVE_PANELS));
    const theirs = { ...done(renameLayout(base, "layout-review", "Проверка")), revision: 2 };
    const expected = stageAJson();
    expected.revision = 2;
    expected.layouts = [{ ...expected.layouts[1], name: "Проверка" }];
    delete expected.panels["thread-b"];
    expect(mergeDocuments(base, mine, theirs, NO_LIVE_PANELS)).toEqual({ document: expected, overridden: [], renamedPanels: [] });
  });

  it("a layout the other window deleted goes, and this window opens the layout that window left active", () => {
    const base = { ...stageADocument(), revision: 1 };
    const mine = done(renameLayout(base, "layout-dev", "Сборка"));
    const theirs = { ...done(deleteLayout(base, "layout-review", NO_LIVE_PANELS)), revision: 2 };
    const expected = stageAJson();
    expected.revision = 2;
    expected.layouts = [{ ...expected.layouts[0], name: "Сборка" }];
    expected.activeLayoutId = "layout-dev";
    expect(mergeDocuments(base, mine, theirs, NO_LIVE_PANELS)).toEqual({ document: expected, overridden: [], renamedPanels: [] });
  });

  it("a layout the other window deleted stays when this window changed it", () => {
    const base = { ...stageADocument(), revision: 1 };
    const mine = done(changeActiveLayout(base, (workspace) => swapGroups(workspace, "group-1", "group-2")));
    const theirs = { ...done(deleteLayout(base, "layout-review", NO_LIVE_PANELS)), revision: 2 };
    const expected = stageAJson();
    expected.revision = 2;
    expected.layouts = [expected.layouts[0], REVIEW_SWAPPED];
    expect(mergeDocuments(base, mine, theirs, NO_LIVE_PANELS)).toEqual({ document: expected, overridden: [], renamedPanels: [] });
  });

  it("each window deleting the other's only remaining layout leaves this window's layout", () => {
    const base = { ...stageADocument(), revision: 1 };
    const mine = done(deleteLayout(base, "layout-dev", NO_LIVE_PANELS));
    const theirs = { ...done(deleteLayout(done(switchLayout(base, "layout-dev")), "layout-review", NO_LIVE_PANELS)), revision: 2 };
    const expected = stageAJson();
    expected.revision = 2;
    expected.layouts = [expected.layouts[1]];
    delete expected.panels["thread-b"];
    expect(mergeDocuments(base, mine, theirs, NO_LIVE_PANELS)).toEqual({ document: expected, overridden: [], renamedPanels: [] });
  });

  it("a reference this window dropped stays while the other window's layout shows the panel or it is live here", () => {
    const base = { ...stageADocument(), revision: 1 };
    // This window takes thread B out of «Разработка»: no layout of its own shows it now.
    const mine = done(removePanelFromLayout(done(switchLayout(base, "layout-dev")), "thread-b", NO_LIVE_PANELS));
    expect(Object.keys(mine.panels)).toEqual(["thread-a", "frame"]);
    // The other window renamed «Ревью» only: «Разработка» is this window's to change.
    const theirs = { ...done(renameLayout(base, "layout-review", "Проверка")), revision: 2 };
    expect(Object.keys(mergeDocuments(base, mine, theirs, NO_LIVE_PANELS).document.panels)).toEqual(["thread-a", "frame"]);
    expect(Object.keys(mergeDocuments(base, mine, theirs, new Set(["thread-b"])).document.panels)).toEqual(["thread-a", "thread-b", "frame"]);
    // The other window changed «Разработка» too and still shows thread B there: its tile needs the reference.
    const both = { ...done(renameLayout(base, "layout-dev", "Сборка")), revision: 2 };
    const merged = mergeDocuments(base, done(deleteLayout(base, "layout-dev", NO_LIVE_PANELS)), both, NO_LIVE_PANELS);
    expect(Object.keys(merged.document.panels)).toEqual(["thread-a", "thread-b", "frame"]);
    expect(merged.document.panels["thread-b"]).toEqual({ ref: { provider: "bb-thread", params: { threadId: "thr_b" } }, title: "Тред B" });
  });

  it("two windows that gave one panel id to different threads keep both threads, each in its own layout", () => {
    const base = { ...stageADocument(), revision: 1 };
    const threadC = { ref: { provider: "bb-thread", params: { threadId: "thr_c" } }, title: "Тред C" };
    const threadD = { ref: { provider: "bb-thread", params: { threadId: "thr_d" } }, title: "Тред D" };
    // The other window opened thread C as `panel-1` in «Разработка» and saved first.
    const theirs = { ...done(addPanelToGroup(done(switchLayout(base, "layout-dev")), "group-1", "panel-1", threadC)), revision: 2 };
    // This window opened thread D under the same id in «Ревью».
    const mine = done(addPanelToGroup(base, "group-1", "panel-1", threadD));

    const expected = stageAJson();
    expected.revision = 2;
    expected.panels["panel-1"] = { ref: { provider: "bb-thread", params: { threadId: "thr_c" } }, title: "Тред C" };
    expected.panels["panel-1-2"] = { ref: { provider: "bb-thread", params: { threadId: "thr_d" } }, title: "Тред D" };
    expected.layouts[0].workspace.root.children[0] = { kind: "group", id: "group-1", tabs: ["thread-a", "panel-1"], activeTab: "panel-1" };
    expected.layouts[0].workspace.focusedGroupId = "group-1";
    expected.layouts[1].workspace.root.children[0] = { kind: "group", id: "group-1", tabs: ["frame", "panel-1-2"], activeTab: "panel-1-2" };
    expected.layouts[1].workspace.focusedGroupId = "group-1";
    const merged = mergeDocuments(base, mine, theirs, new Set(["panel-1"]));
    expect(merged).toEqual({ document: expected, overridden: [], renamedPanels: [{ from: "panel-1", to: "panel-1-2" }] });
    expect(decideSave(theirs, merged.document, 2).status).toBe("saved");
  });

  it("a renamed panel takes the next free id and stays known while it is live in this window", () => {
    const base = { ...stageADocument(), revision: 1 };
    const threadC = { ref: { provider: "bb-thread", params: { threadId: "thr_c" } }, title: "Тред C" };
    const threadD = { ref: { provider: "bb-thread", params: { threadId: "thr_d" } }, title: "Тред D" };
    const threadE = { ref: { provider: "bb-thread", params: { threadId: "thr_e" } }, title: "Тред E" };
    let theirs = done(addPanelToGroup(done(switchLayout(base, "layout-dev")), "group-1", "panel-1", threadC));
    theirs = { ...done(addPanelToGroup(theirs, "group-1", "panel-1-2", threadE)), revision: 2 };
    // This window registered thread D as `panel-1` and shows it live, hidden from every layout.
    const mine = done(registerPanel(base, "panel-1", threadD));
    const merged = mergeDocuments(base, mine, theirs, new Set(["panel-1"]));
    expect(merged.renamedPanels).toEqual([{ from: "panel-1", to: "panel-1-3" }]);
    expect(merged.document.panels["panel-1"]).toEqual(threadC);
    expect(merged.document.panels["panel-1-2"]).toEqual(threadE);
    expect(merged.document.panels["panel-1-3"]).toEqual(threadD);
    // Not live and not placed: the renamed reference is not needed.
    const idle = mergeDocuments(base, mine, theirs, NO_LIVE_PANELS);
    expect(idle.renamedPanels).toEqual([]);
    expect(Object.keys(idle.document.panels)).toEqual(["thread-a", "thread-b", "frame", "panel-1", "panel-1-2"]);
  });

  it("two renamed panels with long ids do not get one new id", () => {
    const base = { ...stageADocument(), revision: 1 };
    const first = "p".repeat(63) + "a";
    const second = "p".repeat(63) + "b";
    const thread = (threadId: string) => ({ ref: { provider: "bb-thread", params: { threadId } }, title: threadId });
    let theirs = done(registerPanel(base, first, thread("thr_1")));
    theirs = { ...done(registerPanel(theirs, second, thread("thr_2"))), revision: 2 };
    const mine = done(registerPanel(done(registerPanel(base, first, thread("thr_3"))), second, thread("thr_4")));
    const merged = mergeDocuments(base, mine, theirs, new Set([first, second]));
    expect(merged.renamedPanels).toEqual([
      { from: first, to: "p".repeat(62) + "-2" },
      { from: second, to: "p".repeat(62) + "-3" },
    ]);
    expect(merged.document.panels["p".repeat(62) + "-2"].ref.params).toEqual({ threadId: "thr_3" });
    expect(merged.document.panels["p".repeat(62) + "-3"].ref.params).toEqual({ threadId: "thr_4" });
    expect(decideSave(theirs, merged.document, 2).status).toBe("saved");
  });

  it("two windows that gave one panel id to the same thread share the panel", () => {
    const base = { ...stageADocument(), revision: 1 };
    const threadC = { ref: { provider: "bb-thread", params: { threadId: "thr_c" } }, title: "Тред C" };
    const theirs = { ...done(addPanelToGroup(done(switchLayout(base, "layout-dev")), "group-1", "panel-1", threadC)), revision: 2 };
    const mine = done(addPanelToGroup(base, "group-1", "panel-1", { ...threadC, title: "Другое имя" }));
    const merged = mergeDocuments(base, mine, theirs, NO_LIVE_PANELS);
    expect(merged.renamedPanels).toEqual([]);
    expect(merged.document.layouts[1].workspace.root).toEqual({
      kind: "split",
      id: "split-3",
      direction: "row",
      children: [
        { kind: "group", id: "group-1", tabs: ["frame", "panel-1"], activeTab: "panel-1" },
        { kind: "group", id: "group-2", tabs: ["thread-a"], activeTab: "thread-a" },
      ],
      sizes: [0.5, 0.5],
    });
    expect(merged.document.panels["panel-1"].ref).toEqual({ provider: "bb-thread", params: { threadId: "thr_c" } });
  });

  it("a merge of unchanged documents is the stored document", () => {
    const base = { ...stageADocument(), revision: 1 };
    const theirs = { ...stageADocument(), revision: 2 };
    expect(mergeDocuments(base, base, theirs, NO_LIVE_PANELS)).toEqual({ document: theirs, overridden: [], renamedPanels: [] });
  });
});
