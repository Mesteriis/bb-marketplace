// The workspace store over the plugin's key-value storage. Every expected
// value is written out by hand or measured by the test itself.
import { describe, expect, it } from "vitest";
import { createKvWorkspaceStore } from "../../../src/adapters/bb/server/index.ts";
import type { WorkspaceDocument, WorkspacePanel, WorkspaceStore } from "../../../src/core/workspace/index.ts";
import { stageADocument, stageAJson } from "../../core/workspace/fixtures.ts";
import { clockOf, FakeKv, FakeLog } from "./support.ts";

const DOCUMENT_KEY = "workspace/document";
const NOON = "2026-11-21T12:00:00.000Z";

interface Rig {
  readonly kv: FakeKv;
  readonly log: FakeLog;
  readonly store: WorkspaceStore;
}

function rig(kv: FakeKv = new FakeKv(), now: () => Date = clockOf(NOON)): Rig {
  const log = new FakeLog();
  return { kv, log, store: createKvWorkspaceStore({ kv, now, log }) };
}

/** The stage A document with the frame's tab renamed: a change a window made. */
function renamedFrame(title: string, revision: number): WorkspaceDocument {
  const document = stageAJson();
  document.panels.frame.title = title;
  document.revision = revision;
  return document;
}

/** Stage A at the given revision whose "Ревью" layout focuses a tile it does not have. */
function damagedStageA(revision: number): any {
  const stored = stageAJson();
  stored.revision = revision;
  stored.layouts[1].workspace.focusedGroupId = "group-9";
  return stored;
}

function utf8Bytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

/**
 * A valid document that takes exactly `target` bytes of JSON once it is
 * stored at revision 1. A hundred of its titles are Cyrillic, two bytes a
 * letter, so the count of characters is well below the count of bytes.
 */
function documentOfBytes(target: number): WorkspaceDocument {
  const base = stageADocument();
  const filler = (title: string): WorkspacePanel => ({ ref: { provider: "chertog-frame", params: { frameId: "live-frame" } }, title });
  const key = (index: number): string => "p" + String(index).padStart(4, "0");
  const panels: Record<string, WorkspacePanel> = { ...base.panels };
  let count = 0;
  for (; count < 100; count += 1) panels[key(count)] = filler("я".repeat(120));
  const withTails = (first: number, second: number): WorkspaceDocument => ({
    ...base,
    panels: { ...panels, [key(9998)]: filler("x".repeat(first)), [key(9999)]: filler("x".repeat(second)) },
  });
  const stored = (document: WorkspaceDocument): number => utf8Bytes({ ...document, revision: 1 });
  while (stored(withTails(120, 120)) < target) {
    panels[key(count)] = filler("x".repeat(120));
    count += 1;
  }
  const spare = stored(withTails(120, 120)) - target;
  const fromFirst = Math.min(spare, 119);
  const document = withTails(120 - fromFirst, 120 - (spare - fromFirst));
  if (stored(document) !== target) throw new Error("the test document takes " + stored(document) + " bytes, not " + target);
  return document;
}

describe("first entry", () => {
  it("reads nothing from storage nobody wrote to, and writes nothing", async () => {
    const { kv, store } = rig();
    expect(await store.load()).toEqual({ status: "empty" });
    expect(kv.keys()).toEqual([]);
    expect(kv.calls).toEqual(["get workspace/document"]);
  });

  it("stores the first document at revision 1 under the plugin's own key", async () => {
    const { kv, store } = rig();
    const result = await store.save(stageADocument(), 0);
    expect(result).toEqual({ status: "saved", document: { ...stageADocument(), revision: 1 } });
    expect(kv.keys()).toEqual([DOCUMENT_KEY]);
    expect(kv.value(DOCUMENT_KEY)).toEqual({ ...stageADocument(), revision: 1 });
  });
});

describe("restart", () => {
  it("reads both named layouts back through a new adapter over the same storage", async () => {
    const kv = new FakeKv();
    await rig(kv).store.save(stageADocument(), 0);

    const read = await rig(kv).store.load();
    expect(read).toEqual({ status: "ok", document: { ...stageADocument(), revision: 1 }, migratedFrom: null, dropped: [] });
    if (read.status !== "ok") throw new Error("unreachable");
    expect(read.document.layouts.map((layout) => [layout.id, layout.name])).toEqual([
      ["layout-dev", "Разработка"],
      ["layout-review", "Ревью"],
    ]);
    expect(read.document.activeLayoutId).toBe("layout-review");
  });

  it("continues the revisions of the earlier run", async () => {
    const kv = new FakeKv();
    await rig(kv).store.save(stageADocument(), 0);
    const result = await rig(kv).store.save(renamedFrame("Живая панель 2", 1), 1);
    expect(result).toEqual({ status: "saved", document: renamedFrame("Живая панель 2", 2) });
    expect(await rig(kv).store.load()).toEqual({ status: "ok", document: renamedFrame("Живая панель 2", 2), migratedFrom: null, dropped: [] });
  });
});

describe("two windows", () => {
  it("refuses the save made from a stale revision and returns what storage holds", async () => {
    const { kv, store } = rig();
    expect((await store.save(renamedFrame("Окно A", 0), 0)).status).toBe("saved");

    const late = await store.save(renamedFrame("Окно B", 0), 0);
    expect(late).toEqual({ status: "conflict", current: renamedFrame("Окно A", 1) });
    expect(kv.value(DOCUMENT_KEY)).toEqual(renamedFrame("Окно A", 1));

    const retried = await store.save(renamedFrame("Окно B", 1), 1);
    expect(retried).toEqual({ status: "saved", document: renamedFrame("Окно B", 2) });
    expect(kv.value(DOCUMENT_KEY)).toEqual(renamedFrame("Окно B", 2));
  });

  it("answers a conflict with nothing when a window saves from a revision storage never had", async () => {
    const { kv, store } = rig();
    expect(await store.save(stageADocument(), 2)).toEqual({ status: "conflict", current: null });
    expect(kv.keys()).toEqual([]);
  });

  it("lets exactly one of two simultaneous saves through", async () => {
    const { kv, store } = rig();
    const results = await Promise.all([store.save(renamedFrame("Окно A", 0), 0), store.save(renamedFrame("Окно B", 0), 0)]);
    expect(results).toEqual([
      { status: "saved", document: renamedFrame("Окно A", 1) },
      { status: "conflict", current: renamedFrame("Окно A", 1) },
    ]);
    expect(kv.value(DOCUMENT_KEY)).toEqual(renamedFrame("Окно A", 1));
    // The second save did not read before the first one wrote.
    expect(kv.calls).toEqual(["get workspace/document", "set workspace/document", "get workspace/document"]);
  });

  it("lets exactly one of eight simultaneous saves through", async () => {
    const { kv, store } = rig();
    const titles = ["Окно 1", "Окно 2", "Окно 3", "Окно 4", "Окно 5", "Окно 6", "Окно 7", "Окно 8"];
    const results = await Promise.all(titles.map((title) => store.save(renamedFrame(title, 0), 0)));
    expect(results.map((result) => result.status)).toEqual([
      "saved",
      "conflict",
      "conflict",
      "conflict",
      "conflict",
      "conflict",
      "conflict",
      "conflict",
    ]);
    expect(kv.value(DOCUMENT_KEY)).toEqual(renamedFrame("Окно 1", 1));
  });

  it("keeps serving saves after one of them failed in storage", async () => {
    const { kv, store } = rig();
    kv.failNextSetOf = DOCUMENT_KEY;
    const [failed, next] = await Promise.allSettled([store.save(renamedFrame("Окно A", 0), 0), store.save(renamedFrame("Окно B", 0), 0)]);
    expect(failed.status).toBe("rejected");
    if (failed.status !== "rejected") throw new Error("unreachable");
    expect(failed.reason).toEqual(new Error("the storage is full"));
    expect(next).toEqual({ status: "fulfilled", value: { status: "saved", document: renamedFrame("Окно B", 1) } });
    expect(kv.value(DOCUMENT_KEY)).toEqual(renamedFrame("Окно B", 1));
  });
});

describe("what is refused", () => {
  it("rejects a document with a credential and stores nothing", async () => {
    const { kv, log, store } = rig();
    const document = stageAJson();
    document.panels["thread-a"].ref.params.token = "hunter2";

    const result = await store.save(document, 0);
    expect(result).toEqual({ status: "rejected", reason: "panels.thread-a.ref.params.token: A panel reference must not carry credentials" });
    expect(kv.keys()).toEqual([]);
    expect(log.lines).toEqual([]);
  });

  it("rejects a link with a password in a reference and in a title, without quoting it", async () => {
    const { kv, store } = rig();
    const inRef = stageAJson();
    inRef.panels.frame.ref.params.url = "https://user:hunter2@example.test/";
    const inTitle = stageAJson();
    inTitle.panels.frame.title = "Стенд https://user:hunter2@example.test/";

    expect(await store.save(inRef, 0)).toEqual({
      status: "rejected",
      reason: "panels.frame.ref.params.url: A panel reference must not carry a link with a secret",
    });
    expect(await store.save(inTitle, 0)).toEqual({
      status: "rejected",
      reason: "panels.frame.title: A title must not carry a link with a secret",
    });
    expect(kv.keys()).toEqual([]);
  });

  it("rejects a credential over a stored document and leaves that document as it was", async () => {
    const { kv, store } = rig();
    await store.save(stageADocument(), 0);
    const document = stageAJson();
    document.revision = 1;
    document.panels["thread-a"].ref.params.password = "hunter2";

    expect((await store.save(document, 1)).status).toBe("rejected");
    expect(kv.value(DOCUMENT_KEY)).toEqual({ ...stageADocument(), revision: 1 });
  });

  it("rejects what is not a document at all", async () => {
    const { kv, store } = rig();
    for (const notADocument of [null, undefined, "workspace", 7, []]) {
      const result = await store.save(notADocument as unknown as WorkspaceDocument, 0);
      expect(result.status).toBe("rejected");
    }
    expect(kv.keys()).toEqual([]);
  });

  it("stores a document of exactly 256 KB", async () => {
    const { kv, store } = rig();
    const document = documentOfBytes(262144);
    expect((await store.save(document, 0)).status).toBe("saved");
    expect(utf8Bytes(kv.value(DOCUMENT_KEY))).toBe(262144);
    expect(kv.value(DOCUMENT_KEY)).toEqual({ ...document, revision: 1 });
  });

  it("rejects a document one byte over 256 KB instead of cutting it", async () => {
    const { kv, store } = rig();
    await store.save(stageADocument(), 0);

    const document = documentOfBytes(262145);
    expect(JSON.stringify(document).length).toBeLessThan(262144);
    expect(await store.save({ ...document, revision: 1 }, 1)).toEqual({
      status: "rejected",
      reason: "The workspace takes 262145 bytes and storage keeps at most 262144",
    });
    expect(kv.keys()).toEqual([DOCUMENT_KEY]);
    expect(kv.value(DOCUMENT_KEY)).toEqual({ ...stageADocument(), revision: 1 });
  });
});

describe("a panel of a provider that is not installed", () => {
  it("is stored and read back where it was", async () => {
    const kv = new FakeKv();
    const document = stageAJson();
    document.panels.room = { ref: { provider: "not-installed-provider", params: { roomId: "room-7" } }, title: "Комната 7" };
    document.layouts[1].workspace.root.children[1].tabs = ["thread-a", "room"];

    expect((await rig(kv).store.save(document, 0)).status).toBe("saved");

    const read = await rig(kv).store.load();
    if (read.status !== "ok") throw new Error("the document was not read: " + read.status);
    expect(read.dropped).toEqual([]);
    expect(read.document.panels.room).toEqual({
      ref: { provider: "not-installed-provider", params: { roomId: "room-7" } },
      title: "Комната 7",
    });
    expect(read.document.layouts[1].workspace.root).toEqual({
      kind: "split",
      id: "split-3",
      direction: "row",
      children: [
        { kind: "group", id: "group-1", tabs: ["frame"], activeTab: "frame" },
        { kind: "group", id: "group-2", tabs: ["thread-a", "room"], activeTab: "thread-a" },
      ],
      sizes: [0.5, 0.5],
    });
  });
});

describe("a stored document the reader left parts out of", () => {
  it("is kept aside under a dated key before the first save over it", async () => {
    const kv = new FakeKv();
    kv.seed(DOCUMENT_KEY, damagedStageA(3));
    const { log, store } = rig(kv);

    const read = await store.load();
    if (read.status !== "ok") throw new Error("the document was not read: " + read.status);
    expect(read.dropped).toEqual([
      { kind: "layout", id: "layout-review", name: "Ревью", reason: "workspace: the focused group group-9 is not in the tree" },
    ]);
    expect(read.document.layouts.map((layout) => layout.id)).toEqual(["layout-dev"]);
    // Reading alone moves nothing.
    expect(kv.keys()).toEqual([DOCUMENT_KEY]);

    const result = await store.save(read.document, 3);
    expect(result).toEqual({ status: "saved", document: { ...read.document, revision: 4 } });
    expect(kv.keys()).toEqual(["workspace/backup/2026-11-21T12:00:00.000Z", DOCUMENT_KEY]);
    expect(kv.value("workspace/backup/2026-11-21T12:00:00.000Z")).toEqual(damagedStageA(3));
    expect(kv.value(DOCUMENT_KEY)).toEqual({ ...read.document, revision: 4 });
    // The copy is written before the document is replaced.
    expect(kv.calls.filter((call) => call.startsWith("set "))).toEqual([
      "set workspace/backup/2026-11-21T12:00:00.000Z",
      "set workspace/document",
    ]);
    expect(log.lines).toEqual(["warn workspace: the stored original is kept aside before a save over it; parts left out: 1; copies kept: 1"]);
  });

  it("is copied once: the next save finds a whole document", async () => {
    const kv = new FakeKv();
    kv.seed(DOCUMENT_KEY, damagedStageA(3));
    const { store } = rig(kv, clockOf(NOON, "2026-11-21T12:05:00.000Z"));
    const read = await store.load();
    if (read.status !== "ok") throw new Error("the document was not read: " + read.status);

    await store.save(read.document, 3);
    expect((await store.save({ ...read.document, revision: 4 }, 4)).status).toBe("saved");
    expect(kv.keys()).toEqual(["workspace/backup/2026-11-21T12:00:00.000Z", DOCUMENT_KEY]);
  });

  it("is not copied by a save that is refused", async () => {
    const kv = new FakeKv();
    kv.seed(DOCUMENT_KEY, damagedStageA(3));
    const { store } = rig(kv);
    const secret = stageAJson();
    secret.panels.frame.ref.params.apiKey = "hunter2";

    expect((await store.save(stageADocument(), 2)).status).toBe("conflict");
    expect((await store.save(secret, 3)).status).toBe("rejected");
    expect(kv.keys()).toEqual([DOCUMENT_KEY]);
    expect(kv.value(DOCUMENT_KEY)).toEqual(damagedStageA(3));
  });

  it("stays in storage when the copy cannot be written", async () => {
    const kv = new FakeKv();
    kv.seed(DOCUMENT_KEY, damagedStageA(3));
    kv.failNextSetOf = "workspace/backup/2026-11-21T12:00:00.000Z";
    const { store } = rig(kv);

    await expect(store.save(stageADocument(), 3)).rejects.toEqual(new Error("the storage is full"));
    expect(kv.keys()).toEqual([DOCUMENT_KEY]);
    expect(kv.value(DOCUMENT_KEY)).toEqual(damagedStageA(3));
  });

  it("keeps the five newest copies", async () => {
    const kv = new FakeKv();
    const minutes = ["01", "02", "03", "04", "05", "06", "07"];
    const { store } = rig(kv, clockOf(...minutes.map((minute) => "2026-11-21T12:" + minute + ":00.000Z")));
    for (const [index] of minutes.entries()) {
      // Each round damages the stored document again, at the revision the last save left.
      kv.seed(DOCUMENT_KEY, damagedStageA(index));
      expect((await store.save({ ...stageADocument(), revision: index }, index)).status).toBe("saved");
    }
    expect(kv.keys()).toEqual([
      "workspace/backup/2026-11-21T12:03:00.000Z",
      "workspace/backup/2026-11-21T12:04:00.000Z",
      "workspace/backup/2026-11-21T12:05:00.000Z",
      "workspace/backup/2026-11-21T12:06:00.000Z",
      "workspace/backup/2026-11-21T12:07:00.000Z",
      DOCUMENT_KEY,
    ]);
    expect(kv.value("workspace/backup/2026-11-21T12:03:00.000Z")).toEqual(damagedStageA(2));
    expect(kv.value("workspace/backup/2026-11-21T12:07:00.000Z")).toEqual(damagedStageA(6));
  });

  it("gives two copies of one instant different keys", async () => {
    const kv = new FakeKv();
    const { store } = rig(kv);
    for (const revision of [0, 1]) {
      kv.seed(DOCUMENT_KEY, damagedStageA(revision));
      await store.save({ ...stageADocument(), revision }, revision);
    }
    expect(kv.keys()).toEqual(["workspace/backup/2026-11-21T12:00:00.000Z", "workspace/backup/2026-11-21T12:00:00.000Z-2", DOCUMENT_KEY]);
    expect(kv.value("workspace/backup/2026-11-21T12:00:00.000Z")).toEqual(damagedStageA(0));
    expect(kv.value("workspace/backup/2026-11-21T12:00:00.000Z-2")).toEqual(damagedStageA(1));
  });
});

describe("a stored document this code must not replace", () => {
  it("reports an unreadable document and refuses to save over it", async () => {
    const kv = new FakeKv();
    const unreadable = { schemaVersion: 1, revision: 2, panels: {}, layouts: "Разработка", activeLayoutId: "layout-dev" };
    kv.seed(DOCUMENT_KEY, unreadable);
    const { log, store } = rig(kv);

    expect(await store.load()).toEqual({ status: "corrupt", reason: "layouts: Invalid input: expected array, received string" });
    expect(await store.save({ ...stageADocument(), revision: 2 }, 2)).toEqual({
      status: "rejected",
      reason: "Storage holds a workspace that cannot be read: layouts: Invalid input: expected array, received string",
    });
    expect(await store.save(stageADocument(), 0)).toEqual({
      status: "rejected",
      reason: "Storage holds a workspace that cannot be read: layouts: Invalid input: expected array, received string",
    });
    expect(kv.keys()).toEqual([DOCUMENT_KEY]);
    expect(kv.value(DOCUMENT_KEY)).toEqual(unreadable);
    expect(log.lines).toEqual([]);
  });

  it("reports a document of a newer version and refuses to save over it", async () => {
    const kv = new FakeKv();
    const newer = { ...stageAJson(), schemaVersion: 2, revision: 9, tags: ["новое поле"] };
    kv.seed(DOCUMENT_KEY, newer);
    const { store } = rig(kv);

    expect(await store.load()).toEqual({ status: "newer", schemaVersion: 2 });
    expect(await store.save({ ...stageADocument(), revision: 9 }, 9)).toEqual({
      status: "rejected",
      reason: "Storage holds a workspace written by a newer version of the plugin (schema version 2)",
    });
    expect(kv.keys()).toEqual([DOCUMENT_KEY]);
    expect(kv.value(DOCUMENT_KEY)).toEqual(newer);
  });
});

describe("what the adapter touches", () => {
  it("uses only keys under workspace/ and writes no document content to the log", async () => {
    const kv = new FakeKv();
    kv.seed(DOCUMENT_KEY, damagedStageA(0));
    const { log, store } = rig(kv);
    const secret = stageAJson();
    secret.panels.frame.ref.params.token = "hunter2";

    await store.load();
    await store.save(secret, 0);
    await store.save(stageADocument(), 5);
    await store.save(stageADocument(), 0);
    await store.load();

    const touched = kv.calls.map((call) => call.slice(call.indexOf(" ") + 1));
    expect(touched.filter((key) => !key.startsWith("workspace/"))).toEqual([]);
    expect(log.lines).toEqual(["warn workspace: the stored original is kept aside before a save over it; parts left out: 1; copies kept: 1"]);
    const logged = log.lines.join("\n");
    for (const content of ["hunter2", "Разработка", "Ревью", "Тред A", "thr_a", "Живая панель", "live-frame"]) {
      expect(logged).not.toContain(content);
    }
  });
});
