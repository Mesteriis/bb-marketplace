import { expect, test, vi } from "vitest";
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
  const runner = new JobRunner({ ...deps, store, onEvent: () => {} });
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

test("reports both_changed for differing files in both directions and copies neither version", async () => {
  const { req, deps, right } = fixture();
  right.put(path, Uint8Array.of(17, 18), "4000000000");
  const sync = await buildSyncPlan({ ...req, direction: "both" }, deps, signal);
  expect(sync.conflicts).toMatchObject([{ reason: "both_changed", left: { name: { t: "a.txt" } }, right: { name: { t: "a.txt" } } }]);
  expect(sync.copies.flatMap(({ items }) => items.map(({ source }) => source?.path))).toEqual([
    { segments: [{ t: "extra.txt" }] },
  ]);
});

test("leaves a newer destination untouched and reports the pair", async () => {
  const { req, deps, right } = fixture();
  right.put(path, Uint8Array.of(17, 18), "4000000000");
  const sync = await buildSyncPlan(req, deps, signal);
  expect(sync.copies).toEqual([]);
  expect(sync.conflicts).toMatchObject([{ left: { name: { t: "a.txt" } }, right: { name: { t: "a.txt" } } }]);
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
