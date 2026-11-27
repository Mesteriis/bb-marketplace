import { expect, test, vi } from "vitest";
import { CommanderError } from "./errors.ts";
import { JobRunner } from "./job-runner.ts";
import { planDigest, type JobState, type OperationJob, type OperationPlan } from "./model.ts";
import { parsePosix } from "./path.ts";
import { FakeProvider } from "./testing/fake-provider.ts";
import { MemoryJobStore } from "./testing/memory-job-store.ts";

const date = "2026-11-27T00:00:00.000Z";
const source = parsePosix("/a");
const target = parsePosix("/b");
const mib = 1024 * 1024;

async function setup(options: {
  size?: number;
  count?: number;
  kind?: OperationPlan["kind"];
  policy?: OperationPlan["conflictPolicy"];
  verify?: OperationPlan["verify"];
} = {}) {
  const from = new FakeProvider("host:from");
  const to = new FakeProvider("host:to");
  const items = Array.from({ length: options.count ?? 1 }, (_, index) => {
    const size = options.size ?? 3;
    const input = index ? parsePosix("/a" + index) : source;
    const output = index ? parsePosix("/b" + index) : target;
    from.put(input, new Uint8Array(size).fill(42), "1");
    return {
      source: { endpoint: "host:from", path: input },
      target: { endpoint: "host:to", path: output },
      kind: "file" as const,
      fingerprint: { size: String(size), mtimeNs: "1" },
    };
  });
  const unsigned: Omit<OperationPlan, "digest"> = {
    id: "123e4567-e89b-42d3-a456-426614174000",
    createdAt: date,
    initiator: { kind: "owner" },
    kind: options.kind ?? "copy",
    sourceEndpoint: "host:from",
    targetEndpoint: "host:to",
    items,
    route: "relay-server",
    conflictPolicy: options.policy ?? "ask",
    verify: options.verify ?? "size",
    totalBytes: String((options.size ?? 3) * items.length),
  };
  const plan = { ...unsigned, digest: await planDigest(unsigned) };
  const store = new MemoryJobStore();
  let nextId = 0;
  const retryDelay = vi.fn(async () => {});
  const runner = new JobRunner({
    store,
    provider: (id) => id === "host:from" ? from : to,
    now: () => new Date(date),
    uuid: () => "223e4567-e89b-42d3-a456-" + String(++nextId).padStart(12, "0"),
    chunkBytes: mib,
    retryDelay,
    onEvent: () => {},
  });
  async function at(id: string, state: JobState, item?: number): Promise<OperationJob> {
    return vi.waitFor(async () => {
      const job = (await store.get(id))!;
      expect(job.state).toBe(state);
      if (item !== undefined) expect(job.currentItem).toBe(item);
      return job;
    });
  }
  return { runner, plan, store, from, to, retryDelay, at };
}

test("relays 10 MiB in ten sequential 1 MiB chunks", async () => {
  const { runner, plan, at, from, to } = await setup({ size: 10 * mib });
  from.trackRelayReads = true;
  const { id } = await runner.submit(plan);
  const job = await at(id, "completed");
  expect(from.calls.filter(({ op }) => op === "read")).toHaveLength(10);
  expect(from.peakReadBytes).toBe(1048576);
  expect(to.contents(target)?.byteLength).toBe(10485760);
  expect(job.progress.bytesDone).toBe("10485760");
});

test.each(["this", "remaining_same_reason"] as const)("scopes skip decisions to %s", async (applyTo) => {
  const { runner, plan, at, to } = await setup({ count: 2 });
  to.put(target, Uint8Array.of(7), "1");
  to.put(parsePosix("/b1"), Uint8Array.of(8), "1");
  const { id } = await runner.submit(plan);
  const first = await at(id, "awaiting_decision", 0);
  expect(first.pendingConflict?.reason).toBe("exists");
  await runner.decide(id, { conflictId: first.pendingConflict!.id, action: "skip", applyTo });
  if (applyTo === "this") {
    const second = await at(id, "awaiting_decision", 1);
    await runner.decide(id, { conflictId: second.pendingConflict!.id, action: "skip", applyTo });
  }
  expect((await at(id, "completed")).items.map(({ outcome }) => outcome)).toEqual(["skipped", "skipped"]);
  expect(to.contents(target)).toEqual(Uint8Array.of(7));
});

test("asks about a changed source despite overwrite policy", async () => {
  const { runner, plan, at, from, to } = await setup({ policy: "overwrite" });
  from.put(source, Uint8Array.of(7), "2");
  const { id } = await runner.submit(plan);
  expect((await at(id, "awaiting_decision")).pendingConflict?.reason).toBe("source_changed");
  expect(to.contents(target)).toBeNull();
});

test("checks the target fingerprint again at commit after overwrite approval", async () => {
  const { runner, plan, at, to } = await setup();
  to.put(target, Uint8Array.of(7), "1");
  const { id } = await runner.submit(plan);
  const conflict = (await at(id, "awaiting_decision", 0)).pendingConflict!;
  to.put(target, Uint8Array.of(8), "2");
  await runner.decide(id, { conflictId: conflict.id, action: "overwrite", applyTo: "this" });
  expect((await at(id, "awaiting_decision", 0)).pendingConflict?.reason).toBe("target_changed");
  expect(to.contents(target)).toEqual(Uint8Array.of(8));
});

test("keeps the move source on verification failure", async () => {
  const { runner, plan, at, from, to } = await setup({ kind: "move", verify: "sha256" });
  to.failOn.push({ op: "read", path: target, times: 1, error: new CommanderError("internal", "Read failed") });
  const { id } = await runner.submit(plan);
  expect((await at(id, "failed")).items[0].outcome).toBe("failed");
  expect(from.contents(source)).toEqual(Uint8Array.of(42, 42, 42));
});

test("verifies SHA-256 using a provider checksum against the relayed bytes", async () => {
  const { runner, plan, at, to } = await setup({ verify: "sha256" });
  to.enableChecksum();
  const { id } = await runner.submit(plan);
  expect((await at(id, "completed")).items[0].outcome).toBe("done");
  expect(await to.sha256!(target, new AbortController().signal)).toBe(
    "596f4162a52f315b2ad0fa53fd30a2769d02a41ed7439123790966eee4ceb5cd",
  );
});

test("cancels mid-write, removes temp and leaves further items pending", async () => {
  const { runner, plan, at, to } = await setup({ count: 3 });
  let writing!: () => void;
  const started = new Promise<void>((resolve) => { writing = resolve; });
  to.delay = async (op, path, signal) => {
    if (op !== "write" || !("t" in path.segments[0]) || path.segments[0].t !== "b1") return;
    writing();
    await new Promise<void>((_, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  };
  const { id } = await runner.submit(plan);
  await started;
  await runner.cancel(id);
  expect((await at(id, "cancelled")).items.map(({ outcome }) => outcome)).toEqual(["done", "pending", "pending"]);
  expect(to.temporaryCount).toBe(0);
  expect(to.contents(parsePosix("/b1"))).toBeNull();
});

test("keeps providers untouched until approval and when rejecting", async () => {
  const { runner, plan, at, from, to } = await setup();
  const rejected = await runner.submit(plan, { awaitsOwner: true });
  expect(rejected.state).toBe("pending");
  expect(from.calls).toEqual([]);
  expect(to.calls).toEqual([]);
  await runner.reject(rejected.id);
  expect((await at(rejected.id, "cancelled")).awaitsOwner).toBe(false);
  expect(from.calls).toEqual([]);
  expect(to.calls).toEqual([]);

  const approved = await runner.submit(plan, { awaitsOwner: true });
  await runner.approve(approved.id);
  expect((await at(approved.id, "completed")).awaitsOwner).toBe(false);
});

test.each([
  [true, 2, 3, "completed", "done"],
  [false, 3, 1, "failed", "failed"],
] as const)("retries provider failures only when retryable=%s", async (retryable, times, reads, state, outcome) => {
  const { runner, plan, at, from, retryDelay } = await setup();
  from.failOn.push({ op: "read", path: source, times, error: new CommanderError("timeout", "Read failed", retryable) });
  const { id } = await runner.submit(plan);
  expect((await at(id, state)).items[0].outcome).toBe(outcome);
  expect(from.calls.filter(({ op }) => op === "read")).toHaveLength(reads);
  expect(retryDelay).toHaveBeenCalledTimes(reads - 1);
});

test.each(["copying", "committed", "missing-temp"] as const)("recovers %s without blind replay", async (phase) => {
  const { runner, plan, store, to, at } = await setup();
  const submitted = await runner.submit(plan, { awaitsOwner: true });
  await store.update(submitted.id, { state: "running", awaitsOwner: false, currentItem: 0 }, "pending");
  const temp = phase === "copying" ? (await to.openWrite(target, new AbortController().signal)).tempPath.segments.at(-1) : null;
  if (phase === "committed") to.put(target, Uint8Array.of(42, 42, 42), "2");
  await store.checkpoint({
    jobId: submitted.id,
    itemIndex: 0,
    phase: phase === "committed" ? "committed" : "copying",
    bytesDone: "3",
    tempName: temp && "t" in temp ? temp.t : null,
  });
  to.calls.length = 0;
  const { resumed, unknown } = await runner.recover();
  if (phase === "missing-temp") {
    expect(resumed).toEqual([]);
    expect(unknown).toEqual([submitted.id]);
    expect((await at(submitted.id, "unknown")).items[0].outcome).toBe("unknown");
    expect(to.calls.some(({ op }) => op === "openWrite")).toBe(false);
  } else {
    expect(resumed).toEqual([submitted.id]);
    expect(unknown).toEqual([]);
    expect((await at(submitted.id, "completed")).items[0].outcome).toBe("done");
    expect(to.calls.filter(({ op }) => op === "openWrite")).toHaveLength(phase === "copying" ? 1 : 0);
    expect(to.temporaryCount).toBe(0);
  }
});

test("uses same-endpoint copy and refuses a late target replacement", async () => {
  const { runner, plan, at, from } = await setup();
  from.enableCopyWithin();
  from.put(target, Uint8Array.of(9), "1");
  const { digest: _digest, ...unsigned } = plan;
  unsigned.route = "same-endpoint";
  unsigned.targetEndpoint = "host:from";
  unsigned.conflictPolicy = "overwrite";
  unsigned.items[0].target!.endpoint = "host:from";
  from.delay = async (op) => {
    if (op === "copyWithin") from.put(target, Uint8Array.of(8), "2");
  };

  const { id } = await runner.submit({ ...unsigned, digest: await planDigest(unsigned) });
  const job = await at(id, "awaiting_decision");
  expect(job.pendingConflict?.reason).toBe("target_changed");
  expect(from.contents(target)).toEqual(Uint8Array.of(8));
  expect(from.calls.some(({ op }) => op === "read")).toBe(false);
});

test("records unknown when cancellation cannot confirm temporary-file cleanup", async () => {
  const { runner, plan, at, to } = await setup({ count: 2 });
  let writing!: () => void;
  const started = new Promise<void>((resolve) => { writing = resolve; });
  to.delay = async (op, _path, signal) => {
    if (op !== "write") return;
    writing();
    await new Promise<void>((_, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  };
  to.failOn.push({ op: "abort", path: target, times: 1, error: new CommanderError("timeout", "Abort failed") });
  const { id } = await runner.submit(plan);
  await started;
  await runner.cancel(id);
  expect((await at(id, "cancelled")).items.map(({ outcome }) => outcome)).toEqual(["unknown", "pending"]);
  expect(to.temporaryCount).toBe(1);
});

test("leaves the next item runnable after a permanent failure", async () => {
  const { runner, plan, at, from } = await setup({ count: 2 });
  from.failOn.push({ op: "read", path: source, times: 1, error: new CommanderError("permission_denied", "Read denied") });
  const { id } = await runner.submit(plan);
  expect((await at(id, "failed")).items.map(({ outcome }) => outcome)).toEqual(["failed", "done"]);
});

test("does not delete a changed source or replay an ambiguous move on recovery", async () => {
  const { runner, plan, store, from, to, at } = await setup({ kind: "move" });
  const { id } = await runner.submit(plan, { awaitsOwner: true });
  await store.update(id, { state: "running", awaitsOwner: false, currentItem: 0 }, "pending");
  to.put(target, Uint8Array.of(42, 42, 42), "2");
  from.put(source, Uint8Array.of(7, 7, 7), "2");
  await store.checkpoint({ jobId: id, itemIndex: 0, phase: "verified", bytesDone: "3", tempName: null });
  expect(await runner.recover()).toEqual({ resumed: [], unknown: [id] });
  expect((await at(id, "unknown")).items[0].outcome).toBe("unknown");
  expect(from.contents(source)).toEqual(Uint8Array.of(7, 7, 7));
  expect(to.calls.some(({ op }) => op === "openWrite")).toBe(false);
});

test("approval revalidates all sources before starting any write", async () => {
  const { runner, plan, from, to, at } = await setup({ count: 2 });
  const { id } = await runner.submit(plan, { awaitsOwner: true });
  from.put(parsePosix("/a1"), Uint8Array.of(7), "2");
  await expect(runner.approve(id)).rejects.toMatchObject({ code: "changed_since_plan" });
  expect((await at(id, "pending")).awaitsOwner).toBe(true);
  expect(to.calls).toEqual([]);
});

test("records a committed item as unknown if cancellation interrupts verification", async () => {
  const { runner, plan, at, to } = await setup({ verify: "sha256" });
  let verifying!: () => void;
  const started = new Promise<void>((resolve) => { verifying = resolve; });
  to.delay = async (op, _path, signal) => {
    if (op !== "read") return;
    verifying();
    await new Promise<void>((_, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  };
  const { id } = await runner.submit(plan);
  await started;
  await runner.cancel(id);
  expect((await at(id, "cancelled")).items[0].outcome).toBe("unknown");
  expect(to.contents(target)).toEqual(Uint8Array.of(42, 42, 42));
  expect(to.temporaryCount).toBe(0);
});

test("moves an expanded directory across endpoints and removes its source after its children", async () => {
  const { runner, plan, from, to, at } = await setup({ kind: "move" });
  const input = parsePosix("/tree");
  const output = parsePosix("/tree-copy");
  const signal = new AbortController().signal;
  await from.mkdir(input, signal);
  const dir = (await from.stat(input, signal))!;
  const child = parsePosix("/tree/child");
  from.put(child, Uint8Array.of(42, 42, 42), "1");

  const { digest: _digest, ...unsigned } = plan;
  unsigned.items[0].source!.path = child;
  unsigned.items[0].target!.path = parsePosix("/tree-copy/child");
  unsigned.items.unshift({
    source: { endpoint: "host:from", path: input },
    target: { endpoint: "host:to", path: output },
    kind: "dir",
    fingerprint: { size: "0", mtimeNs: dir.mtimeNs },
  });

  const { id } = await runner.submit({ ...unsigned, digest: await planDigest(unsigned) });
  expect((await at(id, "completed")).items.map(({ outcome }) => outcome)).toEqual(["done", "done"]);
  expect(await from.stat(input, signal)).toBeNull();
  expect(to.contents(parsePosix("/tree-copy/child"))).toEqual(Uint8Array.of(42, 42, 42));
  expect(from.calls.filter(({ op }) => op === "remove").map(({ path }) => path)).toEqual([child, input]);
});

test("keeps an unresolved target change pending after restart even with overwrite policy", async () => {
  const { runner, plan, store, at, to } = await setup({ policy: "overwrite" });
  const { id } = await runner.submit(plan, { awaitsOwner: true });
  await store.update(id, { state: "running", awaitsOwner: false, currentItem: 0 }, "pending");
  const conflict = {
    id: "333e4567-e89b-42d3-a456-426614174000",
    jobId: id, itemIndex: 0, reason: "target_changed" as const,
    source: { size: "3", mtimeNs: "1" },
    target: { size: "1", mtimeNs: "2" },
  };
  await store.update(id, { state: "awaiting_decision", pendingConflict: conflict }, "running");
  to.put(target, Uint8Array.of(8), "2");
  expect(await runner.recover()).toEqual({ resumed: [id], unknown: [] });
  expect((await at(id, "awaiting_decision")).pendingConflict).toEqual(conflict);
  expect(to.calls).toEqual([]);
});
