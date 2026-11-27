import { expect, test, vi } from "vitest";
import { CommanderError } from "./errors.ts";
import { JobRunner } from "./job-runner.ts";
import { planDigest, type JobState, type OperationPlan } from "./model.ts";
import { parsePosix } from "./path.ts";
import { FakeProvider } from "./testing/fake-provider.ts";
import { MemoryJobStore } from "./testing/memory-job-store.ts";

const date = "2026-11-27T00:00:00.000Z";
const ARCHIVE = "archive:123e4567-e89b-42d3-a456-426614174000";
// SHA-256 of three 0x2a bytes.
const SHA_42x3 = "596f4162a52f315b2ad0fa53fd30a2769d02a41ed7439123790966eee4ceb5cd";

async function setup(sourceEndpoint: string) {
  const from = new FakeProvider(sourceEndpoint);
  const to = new FakeProvider("host:to");
  from.put(parsePosix("/a"), new Uint8Array(3).fill(42), "1");
  const unsigned: Omit<OperationPlan, "digest"> = {
    id: "123e4567-e89b-42d3-a456-426614174001", createdAt: date, initiator: { kind: "owner" }, kind: "copy",
    sourceEndpoint, targetEndpoint: "host:to", targetDir: { endpoint: "host:to", path: { segments: [] } },
    items: [{
      source: { endpoint: sourceEndpoint as never, path: parsePosix("/a") },
      target: { endpoint: "host:to", path: parsePosix("/b") },
      kind: "file", fingerprint: { size: "3", mtimeNs: "1" }, expectTarget: "absent",
    }],
    route: "relay-server", conflictPolicy: "ask", verify: "size", totalBytes: "3",
  };
  const plan = { ...unsigned, digest: await planDigest(unsigned) };
  const store = new MemoryJobStore();
  const checkpoints = vi.spyOn(store, "checkpoint");
  let next = 0;
  const runner = new JobRunner({
    store, provider: (id) => (id === sourceEndpoint ? from : to), now: () => new Date(date),
    uuid: () => "223e4567-e89b-42d3-a456-" + String(++next).padStart(12, "0"), chunkBytes: 1024 * 1024,
    retryDelay: vi.fn(async () => {}), onEvent: () => {},
  });
  const at = (id: string, state: JobState) => vi.waitFor(async () => {
    const job = (await store.get(id))!;
    expect(job.state).toBe(state);
    return job;
  });
  return { runner, plan, store, from, to, checkpoints, at };
}

test("an archive-source copy saves commitIntent with the size and SHA-256 before it commits", async () => {
  const { runner, plan, at, checkpoints, from, to } = await setup(ARCHIVE);
  from.finishRead = vi.fn(async () => {});
  const finishSpy = from.finishRead as unknown as { mock: { invocationCallOrder: number[] } };
  const { id } = await runner.submit(plan);
  await at(id, "completed");
  const withIntent = checkpoints.mock.calls.map(([c]) => c).filter((c) => c.commitIntent);
  expect(withIntent).toHaveLength(1);
  expect(withIntent[0]?.commitIntent).toMatchObject({ size: "3", sha256: SHA_42x3, tempFingerprint: { size: "3" } });
  expect(withIntent[0]?.phase).toBe("copying");
  const intentOrder = checkpoints.mock.invocationCallOrder[checkpoints.mock.calls.findIndex(([c]) => c.commitIntent)]!;
  expect(finishSpy.mock.invocationCallOrder[0]).toBeLessThan(intentOrder);
  expect(to.contents(parsePosix("/b"))).toEqual(new Uint8Array(3).fill(42));
});

test("a host to host copy saves no commitIntent", async () => {
  const { runner, plan, at, checkpoints } = await setup("host:from");
  const { id } = await runner.submit(plan);
  await at(id, "completed");
  expect(checkpoints.mock.calls.some(([c]) => c.commitIntent)).toBe(false);
});

test("a failed integrity barrier means no commit and no target", async () => {
  const { runner, plan, at, from, to, checkpoints } = await setup(ARCHIVE);
  from.finishRead = vi.fn(async () => {
    throw new CommanderError("invalid_archive", "crc", false, "crc_mismatch");
  });
  const { id } = await runner.submit(plan);
  const job = await at(id, "failed");
  expect(job.error).toMatchObject({ code: "invalid_archive", reason: "crc_mismatch" });
  expect(to.contents(parsePosix("/b"))).toBeNull();
  expect(to.temporaryCount).toBe(0);
  expect(checkpoints.mock.calls.some(([c]) => c.commitIntent)).toBe(false);
});
