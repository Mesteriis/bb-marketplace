import { expect, test, vi } from "vitest";
import { JobRunner } from "./job-runner.ts";
import { planDigest, type OperationPlan } from "./model.ts";
import { parsePosix } from "./path.ts";
import { buildPlan } from "./planner.ts";
import { FakeProvider } from "./testing/fake-provider.ts";
import { MemoryJobStore } from "./testing/memory-job-store.ts";

// S14a: the pack kind exists in the model and in permissions; starting it waits for S14b.
const signal = new AbortController().signal;

test("planning a pack is refused as unsupported and reads nothing", async () => {
  const from = new FakeProvider("host:from");
  from.put(parsePosix("/a"), Uint8Array.of(1), "1");
  const to = new FakeProvider("host:to");
  const read = vi.spyOn(from, "read");
  await expect(buildPlan({
    kind: "pack", initiator: { kind: "owner" }, sources: [{ endpoint: "host:from", path: parsePosix("/a") }],
    targetDir: { endpoint: "host:to", path: parsePosix("/") }, newName: { t: "x.zip" }, conflictPolicy: "ask", verify: "size",
  }, {
    provider: (id) => (id === "host:from" ? from : to), now: () => new Date(), uuid: () => "123e4567-e89b-42d3-a456-426614174000",
    limits: { maxItems: 100, maxDepth: 8 }, protectedPathsFor: () => [],
  }, signal)).rejects.toMatchObject({ code: "unsupported", message: "Creating archives is not available yet" });
  expect(read).not.toHaveBeenCalled();
});

test("the runner refuses a pack plan even when one is built by hand", async () => {
  const unsigned: Omit<OperationPlan, "digest"> = {
    id: "123e4567-e89b-42d3-a456-426614174001", createdAt: "2026-11-27T00:00:00.000Z", initiator: { kind: "owner" }, kind: "pack",
    sourceEndpoint: "host:from", targetEndpoint: "host:to", targetDir: null,
    items: [{ source: { endpoint: "host:from", path: parsePosix("/a") }, target: { endpoint: "host:to", path: parsePosix("/x.zip") },
      kind: "file", fingerprint: { size: "1", mtimeNs: "1" }, expectTarget: "absent" }],
    conflictPolicy: "ask", route: "relay-server", verify: "size", totalBytes: "1",
  };
  const store = new MemoryJobStore();
  const runner = new JobRunner({
    store, provider: () => new FakeProvider("host:from"), now: () => new Date(), uuid: () => "223e4567-e89b-42d3-a456-426614174000",
    onEvent: () => {},
  });
  await expect(runner.submit({ ...unsigned, digest: await planDigest(unsigned) } as OperationPlan))
    .rejects.toMatchObject({ code: "unsupported", message: "Creating archives is not available yet" });
  expect(await store.list({ limit: 10 })).toEqual([]);
});
