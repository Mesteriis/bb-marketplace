// Reading a stored document: migration along the chain, a newer version and a
// damaged document that must not be overwritten, a damaged part that must not
// take the rest with it, and secrets that never reach the document.
import { describe, expect, it } from "vitest";
import { migrateToVersion, readWorkspaceDocument, SCHEMA_VERSION, workspaceDocumentSchema } from "../../../src/core/workspace/index.ts";
import type { MigrationChain } from "../../../src/core/workspace/index.ts";
import { stageADocument, stageAJson } from "./fixtures.ts";

describe("readWorkspaceDocument", () => {
  it("has schema version 3", () => {
    expect(SCHEMA_VERSION).toBe(3);
  });

  it("reports storage without a document as empty", () => {
    expect(readWorkspaceDocument(null)).toEqual({ status: "empty" });
    expect(readWorkspaceDocument(undefined)).toEqual({ status: "empty" });
  });

  it("reads both named layouts of a current document unchanged", () => {
    expect(readWorkspaceDocument(stageAJson())).toEqual({
      status: "ok",
      document: stageADocument(),
      migratedFrom: null,
      dropped: [],
    });
  });

  it("reports a newer version without a document to save over it", () => {
    const raw = { ...stageAJson(), schemaVersion: 4, zones: [{ display: "second" }] };
    expect(readWorkspaceDocument(raw)).toEqual({ status: "newer", schemaVersion: 4 });
  });

  it.each([
    ["a string", "{}", "The stored workspace is not an object"],
    ["a list", [], "The stored workspace is not an object"],
    ["a number", 7, "The stored workspace is not an object"],
    ["an object without a version", { layouts: [] }, "The stored workspace has no schema version"],
    ["a fractional version", { ...stageAJson(), schemaVersion: 1.5 }, "The stored workspace has no schema version"],
    ["a version in a string", { ...stageAJson(), schemaVersion: "1" }, "The stored workspace has no schema version"],
    ["an older version without a migration", { ...stageAJson(), schemaVersion: 0 }, "No migration from schema version 0"],
    ["a missing revision", { ...stageAJson(), revision: undefined }, "revision: Invalid input: expected number, received undefined"],
    ["a negative revision", { ...stageAJson(), revision: -1 }, "revision: Too small: expected number to be >=0"],
    ["layouts that are not a list", { ...stageAJson(), layouts: {} }, "layouts: Invalid input: expected array, received object"],
    ["an unknown top-level field", { ...stageAJson(), instanceId: "panel-1" }, 'Unrecognized key: "instanceId"'],
    ["no layout left to show", { ...stageAJson(), layouts: [] }, "No readable layout is left"],
  ])("reports %s as corrupt", (_name, raw, reason) => {
    expect(readWorkspaceDocument(raw)).toEqual({ status: "corrupt", reason });
  });

  it("drops one damaged layout and keeps the other with every panel", () => {
    const raw = stageAJson();
    raw.layouts[0].workspace.root.sizes = [0.5];
    const expected = stageAJson();
    expected.layouts = [expected.layouts[1]];
    expect(readWorkspaceDocument(raw)).toEqual({
      status: "ok",
      document: expected,
      migratedFrom: null,
      dropped: [{ kind: "layout", id: "layout-dev", name: "Разработка", reason: "workspace: split-3 has 2 children and 1 sizes" }],
    });
  });

  it("opens the first readable layout when the active one is damaged", () => {
    const raw = stageAJson();
    raw.layouts[1].workspace.focusedGroupId = "group-9";
    const expected = stageAJson();
    expected.layouts = [expected.layouts[0]];
    expected.activeLayoutId = "layout-dev";
    expect(readWorkspaceDocument(raw)).toEqual({
      status: "ok",
      document: expected,
      migratedFrom: null,
      dropped: [{ kind: "layout", id: "layout-review", name: "Ревью", reason: "workspace: the focused group group-9 is not in the tree" }],
    });
  });

  it("reports a layout that is not an object without its id", () => {
    const raw = stageAJson();
    raw.layouts.push("layout");
    const result = readWorkspaceDocument(raw);
    expect(result).toEqual({
      status: "ok",
      document: stageADocument(),
      migratedFrom: null,
      dropped: [{ kind: "layout", id: null, name: null, reason: "Invalid input: expected object, received string" }],
    });
  });

  it("keeps the first of two layouts with one id", () => {
    const raw = stageAJson();
    raw.layouts.push({ ...stageAJson().layouts[0], name: "Копия" });
    expect(readWorkspaceDocument(raw)).toEqual({
      status: "ok",
      document: stageADocument(),
      migratedFrom: null,
      dropped: [{ kind: "layout", id: "layout-dev", name: "Копия", reason: "A layout with this id is already read" }],
    });
  });

  it.each([
    ["two tiles with one panel", (raw: any) => Object.assign(raw.layouts[0].workspace.root.children[0], { tabs: ["frame"], activeTab: "frame" }), "workspace: the panel frame is placed twice"],
    ["an active tab outside the tabs", (raw: any) => (raw.layouts[0].workspace.root.children[0].activeTab = "frame"), "workspace: group-1 shows the tab frame it does not hold"],
    ["two nodes with one id", (raw: any) => (raw.layouts[0].workspace.root.children[0].id = "group-2"), "workspace: the node id group-2 is used twice"],
    ["a node id the counter would hand out again", (raw: any) => (raw.layouts[0].workspace.nextNodeId = 5), "workspace: the node id split-5 is not below the next id 5"],
    ["a group named as a split", (raw: any) => (raw.layouts[0].workspace.root.children[0].id = "split-1"), "workspace: the group id split-1 is not a group id"],
    ["shares that do not sum to 1", (raw: any) => (raw.layouts[0].workspace.root.sizes = [0.5, 0.25]), "workspace: the shares of split-3 sum to 0.75"],
    ["a split inside a split of the same direction", (raw: any) => (raw.layouts[0].workspace.root.children[1].direction = "row"), "workspace: split-5 repeats the direction of its parent"],
    ["an empty tile beside others", (raw: any) => Object.assign(raw.layouts[0].workspace.root.children[0], { tabs: [], activeTab: null }), "workspace: the empty group group-1 is not the only tile"],
    ["a maximized group outside the tree", (raw: any) => (raw.layouts[0].workspace.maximizedGroupId = "group-7"), "workspace: the maximized group group-7 is not in the tree"],
    ["a live handle beside the tree", (raw: any) => (raw.layouts[0].instanceId = "panel-1"), 'Unrecognized key: "instanceId"'],
    ["a live handle inside a tile", (raw: any) => (raw.layouts[0].workspace.root.children[0].instanceId = "panel-1"), 'workspace.root.children.0: Unrecognized key: "instanceId"'],
    ["an empty name", (raw: any) => (raw.layouts[0].name = "  "), "name: A name is 1 to 64 characters without line breaks"],
  ])("drops a layout with %s", (_name, damage, reason) => {
    const raw = stageAJson();
    damage(raw);
    const result = readWorkspaceDocument(raw);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.dropped).toEqual([{ kind: "layout", id: "layout-dev", name: raw.layouts[0].name, reason }]);
    expect(result.document.layouts.map((layout) => layout.id)).toEqual(["layout-review"]);
    expect(Object.keys(result.document.panels)).toEqual(["thread-a", "thread-b", "frame"]);
  });

  it("keeps the reference and the place of a panel whose provider is not installed", () => {
    const raw = stageAJson();
    raw.panels.call = { ref: { provider: "zoom-meeting", params: { meetingId: "81234567890" } } };
    raw.layouts[1].workspace.root.children[1] = { kind: "group", id: "group-2", tabs: ["thread-a", "call"], activeTab: "call" };
    const result = readWorkspaceDocument(raw);
    expect(result).toEqual({ status: "ok", document: raw, migratedFrom: null, dropped: [] });
    if (result.status !== "ok") return;
    expect(result.document.panels.call).toEqual({
      ref: { provider: "zoom-meeting", params: { meetingId: "81234567890" } },
    });
    expect(result.document.layouts.map((layout) => layout.name)).toEqual(["Разработка", "Ревью"]);
  });
});

/** Panels a document must never hold, with the reason the reader gives for leaving each out. */
const SECRET_PANELS: [name: string, panel: unknown, reason: string][] = [
  ["a token", { ref: { provider: "bb-thread", params: { threadId: "thr_b", accessToken: "tok-1" } } }, "ref.params.accessToken: A panel reference must not carry credentials"],
  ["a password", { ref: { provider: "remote-ssh", params: { host: "build-1", password: "hunter2" } } }, "ref.params.password: A panel reference must not carry credentials"],
  ["message text", { ref: { provider: "telegram-chat", params: { chatId: "42", draftText: "Привет" } } }, "ref.params.draftText: A panel reference must not carry correspondence"],
  ["a meeting link with a password", { ref: { provider: "zoom-meeting", params: { link: "https://zoom.example/j/812?pwd=abc" } } }, "ref.params.link: A panel reference must not carry a link with a secret"],
  ["an instance id", { ref: { provider: "bb-thread", params: { threadId: "thr_b" }, instanceId: "panel-7" } }, 'ref: Unrecognized key: "instanceId"'],
  ["an instance id among the parameters", { ref: { provider: "bb-thread", params: { threadId: "thr_b", instanceId: "panel-7" } } }, "ref.params.instanceId: A panel reference must not carry a live handle"],
  ["a WebContents id among the parameters", { ref: { provider: "bb-thread", params: { threadId: "thr_b", webContentsId: 7 } } }, "ref.params.webContentsId: A panel reference must not carry a live handle"],
  ["a process id among the parameters", { ref: { provider: "remote-ssh", params: { host: "build-1", pid: 4242 } } }, "ref.params.pid: A panel reference must not carry a live handle"],
  ["a PTY handle among the parameters", { ref: { provider: "remote-ssh", params: { host: "build-1", pty_handle: "pty-3" } } }, "ref.params.pty_handle: A panel reference must not carry a live handle"],
  ["a process handle in capitals among the parameters", { ref: { provider: "remote-ssh", params: { host: "build-1", PIDHandle: 4242 } } }, "ref.params.PIDHandle: A panel reference must not carry a live handle"],
  ["a lowercase instance id among the parameters", { ref: { provider: "remote-ssh", params: { host: "build-1", instanceid: "panel-7" } } }, "ref.params.instanceid: A panel reference must not carry a live handle"],
  ["a PTY id in capitals among the parameters", { ref: { provider: "remote-ssh", params: { host: "build-1", PTYID: "pty-3" } } }, "ref.params.PTYID: A panel reference must not carry a live handle"],
  ["a process id with a prefix among the parameters", { ref: { provider: "remote-ssh", params: { host: "build-1", shellPid: 4242 } } }, "ref.params.shellPid: A panel reference must not carry a live handle"],
  ["a socket among the parameters", { ref: { provider: "remote-ssh", params: { host: "build-1", socketFd: 4242 } } }, "ref.params.socketFd: A panel reference must not carry a live handle"],
  ["a title beside the reference", { ref: { provider: "bb-thread", params: { threadId: "thr_b" } }, title: "panel-7" }, 'Unrecognized key: "title"'],
  ["an instance id beside the reference", { ref: { provider: "bb-thread", params: { threadId: "thr_b" } }, instanceId: "panel-7" }, 'Unrecognized key: "instanceId"'],
];

describe("secrets and live handles", () => {
  it.each(SECRET_PANELS)("the strict schema refuses a document whose panel carries %s", (_name, panel, _reason) => {
    const document = stageAJson();
    document.panels["thread-b"] = panel;
    expect(workspaceDocumentSchema.safeParse(document).success).toBe(false);
  });

  it.each(SECRET_PANELS)("reading drops a panel that carries %s, takes it out of its tiles and keeps the rest", (_name, panel, reason) => {
    const raw = stageAJson();
    raw.panels["thread-b"] = panel;
    const result = readWorkspaceDocument(raw);
    expect(result).toEqual({
      status: "ok",
      document: {
        schemaVersion: 3,
        revision: 0,
        panels: {
          "thread-a": { ref: { provider: "bb-thread", params: { threadId: "thr_a" } } },
          frame: { ref: { provider: "chertog-frame", params: { frameId: "live-frame" } } },
        },
        layouts: [
          {
            id: "layout-dev",
            name: "Разработка",
            workspace: {
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
            },
          },
          stageADocument().layouts[1],
        ],
        activeLayoutId: "layout-review",
      },
      migratedFrom: null,
      dropped: [{ kind: "panel", panelId: "thread-b", reason }],
    });
    expect(JSON.stringify(result)).not.toMatch(/tok-1|hunter2|Привет|pwd|panel-7|4242|pty-3|synthetic|dXNlcjpzM2Ny/);
  });

  it("drops a panel whose id is not an identifier, without repeating the id", () => {
    const raw = stageAJson();
    raw.panels["my secret note"] = { ref: { provider: "bb-thread", params: { threadId: "thr_c" } } };
    expect(readWorkspaceDocument(raw)).toEqual({
      status: "ok",
      document: stageADocument(),
      migratedFrom: null,
      dropped: [{ kind: "panel", panelId: null, reason: "The panel id is not an identifier" }],
    });
  });

  it("takes a tab without a panel entry out of its tile", () => {
    const raw = stageAJson();
    delete raw.panels["thread-a"];
    const result = readWorkspaceDocument(raw);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.dropped).toEqual([{ kind: "panel", panelId: "thread-a", reason: "A tile shows a panel the document has no reference for" }]);
    expect(result.document.layouts[1].workspace).toEqual({
      root: { kind: "group", id: "group-1", tabs: ["frame"], activeTab: "frame" },
      focusedGroupId: "group-1",
      maximizedGroupId: null,
      nextNodeId: 4,
    });
  });
});

describe("identifiers that only look like live handles", () => {
  it.each([["groupId"], ["appId"], ["mapId"], ["rapidMode"], ["emptyState"], ["threadId"], ["frameId"], ["connectionId"]])(
    "keeps the parameter %s",
    (name) => {
      const raw = stageAJson();
      raw.panels.frame.ref.params = { [name]: "x-1" };
      const result = readWorkspaceDocument(raw);
      expect(result.status === "ok" && result.dropped).toEqual([]);
    },
  );
});

describe("a document of schema version 1, which kept a title with every panel", () => {
  /** The stage A document as version 1 stored it. */
  function versionOne(): any {
    const raw = stageAJson();
    raw.schemaVersion = 1;
    raw.revision = 6;
    raw.panels["thread-a"].title = "Тред A";
    raw.panels["thread-b"].title = "Тред B";
    raw.panels.frame.title = "Живая панель";
    return raw;
  }

  it("is read with both layouts and every reference, without the titles and without a report", () => {
    expect(readWorkspaceDocument(versionOne())).toEqual({
      status: "ok",
      document: { ...stageADocument(), revision: 6 },
      migratedFrom: 1,
      dropped: [],
    });
  });

  it.each([
    ["Authorization=Bearer synthetic-test-value"],
    ["Basic YTpi"],
    ["https://root:hunter2@build-1"],
    [""],
    ["я".repeat(500)],
  ])("drops the title %s silently and keeps its panel", (title) => {
    const raw = versionOne();
    raw.panels["thread-b"].title = title;
    const result = readWorkspaceDocument(raw);
    expect(result).toEqual({ status: "ok", document: { ...stageADocument(), revision: 6 }, migratedFrom: 1, dropped: [] });
    expect(JSON.stringify(result)).not.toMatch(/title|synthetic|YTpi|hunter2/);
  });

  it("drops a title that is not a string as well", () => {
    const raw = versionOne();
    raw.panels.frame.title = { text: "synthetic-test-value" };
    expect(readWorkspaceDocument(raw)).toEqual({ status: "ok", document: { ...stageADocument(), revision: 6 }, migratedFrom: 1, dropped: [] });
  });

  it("still judges the rest of a version 1 panel", () => {
    const raw = versionOne();
    raw.panels["thread-b"].ref.params.accessToken = "tok-1";
    const result = readWorkspaceDocument(raw);
    expect(result.status === "ok" && result.dropped).toEqual([
      { kind: "panel", panelId: "thread-b", reason: "ref.params.accessToken: A panel reference must not carry credentials" },
    ]);
    expect(result.status === "ok" && result.migratedFrom).toBe(1);
  });

  it("drops a version 1 panel that is not an object and keeps the rest", () => {
    const raw = versionOne();
    raw.panels["thread-b"] = null;
    const result = readWorkspaceDocument(raw);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.migratedFrom).toBe(1);
    expect(result.dropped).toEqual([{ kind: "panel", panelId: "thread-b", reason: "Invalid input: expected object, received null" }]);
    expect(Object.keys(result.document.panels)).toEqual(["thread-a", "frame"]);
    expect(result.document.layouts.map((layout) => layout.name)).toEqual(["Разработка", "Ревью"]);
  });

  it("reports a version 1 document whose panels are not a record as corrupt", () => {
    expect(readWorkspaceDocument({ ...versionOne(), panels: "?" })).toEqual({
      status: "corrupt",
      reason: "panels: Invalid input: expected record, received string",
    });
  });
});

describe("migrateToVersion", () => {
  // A chain for a format two versions ahead of its first one: version 1 kept
  // layouts as a name-keyed record, version 2 called the active layout `current`.
  const CHAIN: MigrationChain = {
    1: (old) => ({
      revision: old.revision,
      current: old.current,
      layouts: Object.entries(old.layouts as Record<string, unknown>).map(([name, tree]) => ({ name, tree })),
    }),
    2: (old) => ({ revision: old.revision, layouts: old.layouts, activeLayout: old.current }),
  };

  it("runs every step from the stored version to the wanted one", () => {
    const stored = { schemaVersion: 1, revision: 4, current: "Ревью", layouts: { Разработка: "a|b", Ревью: "b|a" } };
    expect(migrateToVersion(stored, 3, CHAIN)).toEqual({
      status: "migrated",
      from: 1,
      document: {
        schemaVersion: 3,
        revision: 4,
        activeLayout: "Ревью",
        layouts: [
          { name: "Разработка", tree: "a|b" },
          { name: "Ревью", tree: "b|a" },
        ],
      },
    });
  });

  it("runs only the remaining steps for a later version", () => {
    const stored = { schemaVersion: 2, revision: 1, current: "Ревью", layouts: [{ name: "Ревью", tree: "b|a" }] };
    expect(migrateToVersion(stored, 3, CHAIN)).toEqual({
      status: "migrated",
      from: 2,
      document: { schemaVersion: 3, revision: 1, activeLayout: "Ревью", layouts: [{ name: "Ревью", tree: "b|a" }] },
    });
  });

  it("returns a document of the wanted version as it is", () => {
    const stored = { schemaVersion: 3, revision: 1, activeLayout: "Ревью", layouts: [] };
    const result = migrateToVersion(stored, 3, CHAIN);
    expect(result).toEqual({ status: "current", document: stored });
    expect(result.status === "current" && result.document).toBe(stored);
  });

  it("does not touch the stored object", () => {
    const stored = { schemaVersion: 1, revision: 4, current: "Ревью", layouts: { Ревью: "b|a" } };
    migrateToVersion(stored, 3, CHAIN);
    expect(stored).toEqual({ schemaVersion: 1, revision: 4, current: "Ревью", layouts: { Ревью: "b|a" } });
  });

  it("reports a newer version, a missing step and a failing step apart", () => {
    expect(migrateToVersion({ schemaVersion: 4 }, 3, CHAIN)).toEqual({ status: "newer", schemaVersion: 4 });
    expect(migrateToVersion({ schemaVersion: 0 }, 3, CHAIN)).toEqual({ status: "corrupt", reason: "No migration from schema version 0" });
    expect(migrateToVersion({ schemaVersion: 1, revision: 1 }, 3, CHAIN)).toEqual({
      status: "corrupt",
      reason: "The migration from schema version 1 failed",
    });
    expect(migrateToVersion("x", 3, CHAIN)).toEqual({ status: "corrupt", reason: "The stored workspace is not an object" });
    expect(migrateToVersion({ revision: 1 }, 3, CHAIN)).toEqual({ status: "corrupt", reason: "The stored workspace has no schema version" });
  });
});
