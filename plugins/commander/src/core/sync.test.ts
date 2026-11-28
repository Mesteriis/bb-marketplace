import { expect, test, vi } from "vitest";
import { OperationPlan, planDigest } from "./model.ts";
import { JobRunner } from "./job-runner.ts";
import { parsePosix } from "./path.ts";
import { revalidate } from "./planner.ts";
import { buildSyncPlan, type SyncRequest } from "./sync.ts";
import { FakeProvider } from "./testing/fake-provider.ts";
import { MemoryJobStore } from "./testing/memory-job-store.ts";

const signal = new AbortController().signal;
const path = parsePosix("/a.txt");

function fixture() {
  const left = new FakeProvider("host:left");
  const right = new FakeProvider("host:right");
  left.put(path, Uint8Array.of(42), "3000000000");
  right.put(parsePosix("/extra.txt"), Uint8Array.of(17));
  const req: SyncRequest = {
    left: { endpoint: "host:left", path: parsePosix("/") },
    right: { endpoint: "host:right", path: parsePosix("/") },
    direction: "left-to-right", by: "size+mtime", includeDeletes: false,
  };
  const store = new MemoryJobStore();
  const deps = {
    provider: (id: string) => id === "host:left" ? left : right,
    now: () => new Date("2026-11-27T00:00:00Z"), uuid: () => crypto.randomUUID(),
    protectedPathsFor: () => [], limits: { maxItems: 100, maxDepth: 5 },
    initiator: { kind: "owner" } as const,
  };
  const runner = new JobRunner({ ...deps, store, revalidate: (plan, signal) => revalidate(plan, deps, signal), onEvent: () => {} });
  return { left, right, req, deps, store, runner };
}

test("preserves right-only files after running a plan without deletions", async () => {
  const { req, deps, runner, right, store } = fixture();
  try {
    const sync = await buildSyncPlan(req, deps, signal);
    expect(sync.deletes).toBeNull();
    const job = await runner.submit(sync.copies[0]);
    expect(job.plan.syncId).toBe(sync.id);
    await vi.waitFor(async () => expect((await store.get(job.id))?.state).toBe("completed"));
    expect(right.contents(path)).toEqual(Uint8Array.of(42));
    expect(right.contents(parsePosix("/extra.txt"))).toEqual(Uint8Array.of(17));
  } finally { await runner.shutdown(); }
});

test("selects exactly the right-only entries for the separate deletion plan", async () => {
  const { req, deps, right } = fixture();
  right.put(path, Uint8Array.of(42), "3000000000");
  const sync = await buildSyncPlan({ ...req, includeDeletes: true }, deps, signal);
  expect(sync.deletes?.kind).toBe("delete");
  expect(sync.deletes?.items.map(({ source }) => source)).toEqual([
    { endpoint: "host:right", path: { segments: [{ t: "extra.txt" }] } },
  ]);
});

test("reports differs for differing files in both directions and copies neither version", async () => {
  const { req, deps, right } = fixture();
  right.put(path, Uint8Array.of(17, 18), "4000000000");
  const sync = await buildSyncPlan({ ...req, direction: "both" }, deps, signal);
  expect(sync.conflicts).toMatchObject([{ reason: "differs", left: { name: { t: "a.txt" } }, right: { name: { t: "a.txt" } } }]);
  expect(sync.copies.flatMap(({ items }) => items.map(({ source }) => source?.path))).toEqual([
    { segments: [{ t: "extra.txt" }] },
  ]);
});

test("leaves a newer destination untouched and reports the pair", async () => {
  const { req, deps, right } = fixture();
  right.put(path, Uint8Array.of(17, 18), "4000000000");
  const sync = await buildSyncPlan(req, deps, signal);
  expect(sync.copies).toEqual([]);
  expect(sync.conflicts).toMatchObject([{ reason: "target_newer", left: { name: { t: "a.txt" } }, right: { name: { t: "a.txt" } } }]);
});

test("reports source_changed between planning and running, with no destination write", async () => {
  const { req, deps, left, right, runner, store } = fixture();
  try {
    const [copy] = (await buildSyncPlan(req, deps, signal)).copies;
    left.put(path, Uint8Array.of(41, 42), "4000000000");
    expect(await revalidate(copy, deps, signal)).toEqual({ ok: false, changed: [{ index: 0, reason: "source_changed" }] });
    const { id } = await runner.submit(copy);
    await vi.waitFor(async () => expect((await store.get(id))?.pendingConflict).toMatchObject({ itemIndex: 0, reason: "source_changed" }));
    expect(right.contents(path)).toBeNull();
  } finally { await runner.shutdown(); }
});

test("plans reverse copies and deletions, excluding named entries on both sides", async () => {
  const { req, deps, left, right } = fixture();
  left.put(parsePosix("/ignore.txt"), Uint8Array.of(23));
  right.put(parsePosix("/ignore.txt"), Uint8Array.of(24));
  const plan = await buildSyncPlan({
    ...req, direction: "right-to-left", includeDeletes: true, filters: { exclude: ["ignore.txt"] },
  }, deps, signal);
  expect(plan.copies[0].items.map(({ source, target }) => [source, target])).toEqual([[
    { endpoint: "host:right", path: { segments: [{ t: "extra.txt" }] } },
    { endpoint: "host:left", path: { segments: [{ t: "extra.txt" }] } },
  ]]);
  expect(plan.deletes?.items.map(({ source }) => source?.path)).toEqual([{ segments: [{ t: "a.txt" }] }]);
  expect(plan.conflicts).toEqual([]);
});

test("refuses deletions from a partial directory scan", async () => {
  const { req, deps, left } = fixture();
  for (let index = 0; index < 1000; index++) {
    left.put(parsePosix("/a-" + index), Uint8Array.of(1));
  }
  await expect(buildSyncPlan({ ...req, includeDeletes: true }, deps, signal)).rejects.toMatchObject({ code: "limit_exceeded" });
});

test("revalidate rejects a syncId substituted after the plan was signed", async () => {
  const { req, deps } = fixture();
  const [plan] = (await buildSyncPlan(req, deps, signal)).copies;
  const tampered = { ...plan, syncId: "123e4567-e89b-42d3-a456-426614174002" };
  await expect(revalidate(tampered, deps, signal)).rejects.toMatchObject({
    code: "internal", message: "The plan does not match its digest",
  });
});

const extra = parsePosix("/extra.txt");
const absence = { endpoint: "host:left", path: { segments: [{ t: "extra.txt" }] } };

test.each(["at launch", "after owner approval", "immediately before remove"] as const)(
  "keeps both /extra.txt copies when the counterpart appears %s",
  async (point) => {
    const { req, deps, left, right, runner, store } = fixture();
    try {
      const { deletes } = await buildSyncPlan({ ...req, includeDeletes: true }, deps, signal);
      expect(deletes?.items[0]).toMatchObject({ requireAbsent: absence });
      if (point === "at launch") {
        left.put(extra, Uint8Array.of(23));
        expect(await revalidate(deletes!, deps, signal)).toEqual({
          ok: false, changed: [{ index: 0, reason: "target_changed" }],
        });
      } else if (point === "immediately before remove") {
        // Checkpoint persistence follows the first absence check and precedes provider.remove.
        const checkpoint = store.checkpoint.bind(store);
        vi.spyOn(store, "checkpoint").mockImplementation(async (value) => {
          await checkpoint(value);
          left.put(extra, Uint8Array.of(23));
        });
      }
      const { id } = await runner.submit(deletes!, { awaitsOwner: point === "after owner approval" });
      if (point === "after owner approval") {
        expect((await store.get(id))?.awaitsOwner).toBe(true);
        left.put(extra, Uint8Array.of(23));
        await runner.approve(id);
      }
      await vi.waitFor(async () => expect((await store.get(id))?.pendingConflict).toMatchObject({
        itemIndex: 0, reason: "target_changed", allowedResolutions: ["skip", "cancel"],
      }));
      expect(left.contents(extra)).toEqual(Uint8Array.of(23));
      expect(right.contents(extra)).toEqual(Uint8Array.of(17));
      expect(right.calls.filter(({ op }) => op === "remove")).toEqual([]);
    } finally { await runner.shutdown(); }
  },
);

test("protects every entry of a removed directory and counts nested files in the plan", async () => {
  const { req, deps, right } = fixture();
  await right.mkdir(parsePosix("/old"), signal);
  await right.mkdir(parsePosix("/old/sub"), signal);
  right.put(parsePosix("/old/sub/a.txt"), Uint8Array.of(1, 2));
  right.put(parsePosix("/old/b.txt"), Uint8Array.of(3, 4, 5));
  const { deletes } = await buildSyncPlan({
    ...req, includeDeletes: true, filters: { exclude: ["extra.txt"] },
  }, deps, signal);
  expect(deletes?.items.map((item) => item.requireAbsent)).toEqual([
    { endpoint: "host:left", path: { segments: [{ t: "old" }] } },
    { endpoint: "host:left", path: { segments: [{ t: "old" }] } },
    { endpoint: "host:left", path: { segments: [{ t: "old" }] } },
    { endpoint: "host:left", path: { segments: [{ t: "old" }] } },
  ]);
  expect(deletes?.items).toHaveLength(4);
  expect(deletes?.totalBytes).toBe("5");
});

test("only a sync deletion may carry an absence predicate, which is bound to its digest", async () => {
  const { req, deps } = fixture();
  const { copies: [copy], deletes } = await buildSyncPlan({ ...req, includeDeletes: true }, deps, signal);
  expect(OperationPlan.safeParse({ ...copy, items: [{ ...copy.items[0], requireAbsent: absence }] }).success).toBe(false);
  const { syncId: _syncId, ...ordinaryDelete } = deletes!;
  expect(OperationPlan.safeParse(ordinaryDelete).success).toBe(false);
  const tampered = { ...deletes!, items: [{ ...deletes!.items[0], requireAbsent: { ...absence, path: parsePosix("/other.txt") } }] };
  expect(await planDigest(tampered)).not.toBe(deletes?.digest);
  await expect(revalidate(tampered, deps, signal)).rejects.toMatchObject({
    code: "internal", message: "The plan does not match its digest",
  });
});

test("an empty counterpart /old appearing after the checkpoint protects /old/b.txt", async () => {
  const { req, deps, left, right, runner, store } = fixture();
  const old = parsePosix("/old");
  const nested = parsePosix("/old/b.txt");
  try {
    await right.mkdir(old, signal);
    right.put(nested, Uint8Array.of(17));
    const { deletes } = await buildSyncPlan({
      ...req, includeDeletes: true, filters: { exclude: ["extra.txt"] },
    }, deps, signal);
    const checkpoint = store.checkpoint.bind(store);
    vi.spyOn(store, "checkpoint").mockImplementation(async (value) => {
      await checkpoint(value);
      await left.mkdir(old, signal);
    });
    const { id } = await runner.submit(deletes!);
    await vi.waitFor(async () => expect((await store.get(id))?.pendingConflict).toMatchObject({
      itemIndex: 0, reason: "target_changed",
    }));
    expect(right.calls.filter(({ op }) => op === "remove")).toHaveLength(0);
    expect(right.contents(nested)).toEqual(Uint8Array.of(17));
  } finally { await runner.shutdown(); }
});
