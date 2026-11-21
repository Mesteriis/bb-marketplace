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

/** The stage A document with its first layout renamed: a change a window made. */
function renamedLayout(name: string, revision: number): WorkspaceDocument {
  const document = stageAJson();
  document.layouts[0].name = name;
  document.revision = revision;
  return document;
}

/**
 * What a refused save must look like, whatever words the core chose: nothing
 * but a status and a reason, and the reason does not quote the secret.
 */
function expectRejected(result: unknown, secret: string): void {
  expect(result).toEqual({ status: "rejected", reason: expect.any(String) });
  const reason = (result as { reason: string }).reason;
  expect(reason).not.toBe("");
  expect(reason).not.toContain(secret);
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
 * stored at revision 1. It is filled with panels that differ from the
 * fixture's frame panel by one reference parameter. A hundred of those values
 * are Cyrillic, two bytes a letter, so the document has far fewer characters
 * than bytes.
 */
function documentOfBytes(target: number): WorkspaceDocument {
  const base = stageADocument();
  const filler = (frameId: string): WorkspacePanel => ({ ...base.panels.frame, ref: { provider: "chertog-frame", params: { frameId } } });
  const key = (index: number): string => "p" + String(index).padStart(4, "0");
  const panels: Record<string, WorkspacePanel> = { ...base.panels };
  let count = 0;
  for (; count < 100; count += 1) panels[key(count)] = filler("я".repeat(120));
  const withTails = (first: number, second: number): WorkspaceDocument => ({
    ...base,
    panels: { ...panels, [key(9998)]: filler("x".repeat(first)), [key(9999)]: filler("x".repeat(second)) },
  });
  const stored = (document: WorkspaceDocument): number => utf8Bytes({ ...document, revision: 1 });
  // Keys have one width, so every Latin filler adds the same number of bytes: measure one and add the rest by count.
  const before = stored(withTails(120, 120));
  panels[key(count)] = filler("x".repeat(120));
  count += 1;
  const perFiller = stored(withTails(120, 120)) - before;
  for (let missing = Math.ceil((target - before) / perFiller) - 1; missing > 0; missing -= 1) {
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
    const result = await rig(kv).store.save(renamedLayout("Разработка 2", 1), 1);
    expect(result).toEqual({ status: "saved", document: renamedLayout("Разработка 2", 2) });
    expect(await rig(kv).store.load()).toEqual({ status: "ok", document: renamedLayout("Разработка 2", 2), migratedFrom: null, dropped: [] });
  });
});

describe("two windows", () => {
  it("refuses the save made from a stale revision and returns what storage holds", async () => {
    const { kv, store } = rig();
    expect((await store.save(renamedLayout("Окно A", 0), 0)).status).toBe("saved");

    const late = await store.save(renamedLayout("Окно B", 0), 0);
    expect(late).toEqual({ status: "conflict", current: renamedLayout("Окно A", 1) });
    expect(kv.value(DOCUMENT_KEY)).toEqual(renamedLayout("Окно A", 1));

    const retried = await store.save(renamedLayout("Окно B", 1), 1);
    expect(retried).toEqual({ status: "saved", document: renamedLayout("Окно B", 2) });
    expect(kv.value(DOCUMENT_KEY)).toEqual(renamedLayout("Окно B", 2));
  });

  it("answers a conflict with nothing when a window saves from a revision storage never had", async () => {
    const { kv, store } = rig();
    expect(await store.save(stageADocument(), 2)).toEqual({ status: "conflict", current: null });
    expect(kv.keys()).toEqual([]);
  });

  it("lets exactly one of two simultaneous saves through", async () => {
    const { kv, store } = rig();
    const results = await Promise.all([store.save(renamedLayout("Окно A", 0), 0), store.save(renamedLayout("Окно B", 0), 0)]);
    expect(results).toEqual([
      { status: "saved", document: renamedLayout("Окно A", 1) },
      { status: "conflict", current: renamedLayout("Окно A", 1) },
    ]);
    expect(kv.value(DOCUMENT_KEY)).toEqual(renamedLayout("Окно A", 1));
    // The second save did not read before the first one wrote.
    expect(kv.calls).toEqual(["get workspace/document", "set workspace/document", "get workspace/document"]);
  });

  it("lets exactly one of eight simultaneous saves through", async () => {
    const { kv, store } = rig();
    const names = ["Окно 1", "Окно 2", "Окно 3", "Окно 4", "Окно 5", "Окно 6", "Окно 7", "Окно 8"];
    const results = await Promise.all(names.map((name) => store.save(renamedLayout(name, 0), 0)));
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
    expect(kv.value(DOCUMENT_KEY)).toEqual(renamedLayout("Окно 1", 1));
  });

  it("keeps serving saves after one of them failed in storage", async () => {
    const { kv, store } = rig();
    kv.failNextSetOf = DOCUMENT_KEY;
    const [failed, next] = await Promise.allSettled([store.save(renamedLayout("Окно A", 0), 0), store.save(renamedLayout("Окно B", 0), 0)]);
    expect(failed.status).toBe("rejected");
    if (failed.status !== "rejected") throw new Error("unreachable");
    expect(failed.reason).toEqual(new Error("the storage is full"));
    expect(next).toEqual({ status: "fulfilled", value: { status: "saved", document: renamedLayout("Окно B", 1) } });
    expect(kv.value(DOCUMENT_KEY)).toEqual(renamedLayout("Окно B", 1));
  });
});

describe("what is refused", () => {
  it("rejects a reference parameter that names a credential and stores nothing", async () => {
    const { kv, log, store } = rig();
    const document = stageAJson();
    document.panels["thread-a"].ref.params.token = "hunter2";

    expectRejected(await store.save(document, 0), "hunter2");
    expect(kv.keys()).toEqual([]);
    expect(log.lines).toEqual([]);
  });

  it("rejects a link with a password in a reference and in a layout name, without quoting it", async () => {
    const { kv, store } = rig();
    const inRef = stageAJson();
    inRef.panels.frame.ref.params.url = "https://user:hunter2@example.test/";
    const inName = stageAJson();
    inName.layouts[0].name = "https://user:hunter2@example.test/";

    expectRejected(await store.save(inRef, 0), "hunter2");
    expectRejected(await store.save(inName, 0), "hunter2");
    expect(kv.keys()).toEqual([]);
  });

  it("rejects a credential over a stored document and leaves that document as it was", async () => {
    const { kv, store } = rig();
    await store.save(stageADocument(), 0);
    const document = stageAJson();
    document.revision = 1;
    document.panels["thread-a"].ref.params.password = "hunter2";

    expectRejected(await store.save(document, 1), "hunter2");
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
    document.panels.room = { ...document.panels.frame, ref: { provider: "not-installed-provider", params: { roomId: "room-7" } } };
    document.layouts[1].workspace.root.children[1].tabs = ["thread-a", "room"];

    expect((await rig(kv).store.save(document, 0)).status).toBe("saved");

    const read = await rig(kv).store.load();
    if (read.status !== "ok") throw new Error("the document was not read: " + read.status);
    expect(read.dropped).toEqual([]);
    expect(read.document.panels.room.ref).toEqual({ provider: "not-installed-provider", params: { roomId: "room-7" } });
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
    expect(read.dropped).toEqual([{ kind: "layout", id: "layout-review", name: "Ревью", reason: expect.any(String) }]);
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
    expect(log.lines).toEqual(["warn workspace: the stored original is kept aside before a save over it; parts left out: 1; stored schema version: current; copies kept: 1"]);
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

describe("a stored document of an older version", () => {
  /** Stage A as version 1 stored it: every panel carries the caption of its tab. */
  function stageAVersion1(revision: number): any {
    const stored = stageAJson();
    stored.schemaVersion = 1;
    stored.revision = revision;
    stored.panels["thread-a"].title = "Тред A";
    stored.panels["thread-b"].title = "Тред B";
    stored.panels.frame.title = "Живая панель";
    return stored;
  }

  it("is read through the migration, saved as the current version, and kept aside as it was", async () => {
    const kv = new FakeKv();
    kv.seed(DOCUMENT_KEY, stageAVersion1(4));
    const { log, store } = rig(kv);

    const read = await store.load();
    expect(read).toEqual({ status: "ok", document: { ...stageADocument(), revision: 4 }, migratedFrom: 1, dropped: [] });
    if (read.status !== "ok") throw new Error("unreachable");
    // Reading alone rewrites nothing: storage still holds version 1.
    expect(kv.keys()).toEqual([DOCUMENT_KEY]);
    expect(kv.value(DOCUMENT_KEY)).toEqual(stageAVersion1(4));

    const result = await store.save(read.document, 4);
    expect(result).toEqual({ status: "saved", document: { ...stageADocument(), revision: 5 } });

    const now = kv.value(DOCUMENT_KEY) as { schemaVersion: number; panels: Record<string, object> };
    expect(now).toEqual({ ...stageADocument(), revision: 5 });
    expect(now.schemaVersion).toBe(2);
    expect(Object.values(now.panels).map((panel) => Object.keys(panel))).toEqual([["ref"], ["ref"], ["ref"]]);

    expect(kv.keys()).toEqual(["workspace/backup/2026-11-21T12:00:00.000Z", DOCUMENT_KEY]);
    expect(kv.value("workspace/backup/2026-11-21T12:00:00.000Z")).toEqual(stageAVersion1(4));
    expect(kv.calls.filter((call) => call.startsWith("set "))).toEqual([
      "set workspace/backup/2026-11-21T12:00:00.000Z",
      "set workspace/document",
    ]);
    expect(log.lines).toEqual([
      "warn workspace: the stored original is kept aside before a save over it; parts left out: 0; stored schema version: 1; copies kept: 1",
    ]);
    expect(log.lines.join("\n")).not.toContain("Тред");
  });

  it("is copied once: the next save finds the current version", async () => {
    const kv = new FakeKv();
    kv.seed(DOCUMENT_KEY, stageAVersion1(4));
    const { store } = rig(kv, clockOf(NOON, "2026-11-21T12:05:00.000Z"));

    expect((await store.save({ ...stageADocument(), revision: 4 }, 4)).status).toBe("saved");
    expect((await store.save({ ...stageADocument(), revision: 5 }, 5)).status).toBe("saved");
    expect(kv.keys()).toEqual(["workspace/backup/2026-11-21T12:00:00.000Z", DOCUMENT_KEY]);
    expect(await store.load()).toEqual({ status: "ok", document: { ...stageADocument(), revision: 6 }, migratedFrom: null, dropped: [] });
  });

  it("is not copied by a save that is refused", async () => {
    const kv = new FakeKv();
    kv.seed(DOCUMENT_KEY, stageAVersion1(4));
    const { store } = rig(kv);

    expect(await store.save(stageADocument(), 3)).toEqual({ status: "conflict", current: { ...stageADocument(), revision: 4 } });
    expect(kv.keys()).toEqual([DOCUMENT_KEY]);
    expect(kv.value(DOCUMENT_KEY)).toEqual(stageAVersion1(4));
  });
});

describe("a stored document this code must not replace", () => {
  it("reports an unreadable document and refuses to save over it", async () => {
    const kv = new FakeKv();
    const unreadable = { schemaVersion: 1, revision: 2, panels: {}, layouts: "Разработка", activeLayoutId: "layout-dev" };
    kv.seed(DOCUMENT_KEY, unreadable);
    const { log, store } = rig(kv);

    const read = await store.load();
    expect(read).toEqual({ status: "corrupt", reason: expect.any(String) });
    if (read.status !== "corrupt") throw new Error("unreachable");
    // Whatever revision the save names, the answer is the refusal, with the reader's reason after the store's own words.
    const refusal = { status: "rejected", reason: "Storage holds a workspace that cannot be read: " + read.reason };
    expect(await store.save({ ...stageADocument(), revision: 2 }, 2)).toEqual(refusal);
    expect(await store.save(stageADocument(), 0)).toEqual(refusal);
    expect(kv.keys()).toEqual([DOCUMENT_KEY]);
    expect(kv.value(DOCUMENT_KEY)).toEqual(unreadable);
    expect(log.lines).toEqual([]);
  });

  it("reports a document of a newer version and refuses to save over it", async () => {
    const kv = new FakeKv();
    const newer = { ...stageAJson(), schemaVersion: 999, revision: 9, tags: ["новое поле"] };
    kv.seed(DOCUMENT_KEY, newer);
    const { store } = rig(kv);

    expect(await store.load()).toEqual({ status: "newer", schemaVersion: 999 });
    expect(await store.save({ ...stageADocument(), revision: 9 }, 9)).toEqual({
      status: "rejected",
      reason: "Storage holds a workspace written by a newer version of the plugin (schema version 999)",
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
    expect(log.lines).toEqual(["warn workspace: the stored original is kept aside before a save over it; parts left out: 1; stored schema version: current; copies kept: 1"]);
    const logged = log.lines.join("\n");
    for (const content of ["hunter2", "Разработка", "Ревью", "thr_a", "live-frame"]) {
      expect(logged).not.toContain(content);
    }
  });
});
