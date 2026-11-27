import { expect, test, vi } from "vitest";
import { CommanderError } from "./errors.ts";
import { JobRunner, type RunnerDeps } from "./job-runner.ts";
import { Conflict, OperationJob, planDigest, type JobState, type OperationPlan } from "./model.ts";
import { parsePosix } from "./path.ts";
import { buildPlan } from "./planner.ts";
import { FakeProvider } from "./testing/fake-provider.ts";
import { tempNameFor } from "./reconcile.ts";
import type { Checkpoint } from "./job-store.ts";
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
  revalidate?: RunnerDeps["revalidate"];
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
      expectTarget: "absent" as const,
    };
  });
  const unsigned: Omit<OperationPlan, "digest"> = {
    id: "123e4567-e89b-42d3-a456-426614174000",
    createdAt: date,
    initiator: { kind: "owner" },
    kind: options.kind ?? "copy",
    sourceEndpoint: "host:from",
    targetEndpoint: "host:to",
    targetDir: options.kind === "delete" || options.kind === "rename" ? null : { endpoint: "host:to", path: { segments: [] } },
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
  const newRunner = () => new JobRunner({
    store,
    provider: (id) => id === "host:from" ? from : to,
    now: () => new Date(date),
    uuid: () => "223e4567-e89b-42d3-a456-" + String(++nextId).padStart(12, "0"),
    chunkBytes: mib,
    retryDelay,
    revalidate: options.revalidate,
    onEvent: () => {},
  });
  const runner = newRunner();
  async function at(id: string, state: JobState, item?: number): Promise<OperationJob> {
    return vi.waitFor(async () => {
      const job = (await store.get(id))!;
      expect(job.state).toBe(state);
      if (item !== undefined) expect(job.currentItem).toBe(item);
      return job;
    });
  }
  return { runner, newRunner, plan, store, from, to, retryDelay, at };
}

/** Rebuild the plan the way the planner would after a target already exists. */
async function planningExisting(plan: OperationPlan, provider: FakeProvider): Promise<OperationPlan> {
  const { digest: _digest, ...unsigned } = plan;
  for (const item of unsigned.items) {
    const entry = item.target && await provider.stat(item.target.path, new AbortController().signal);
    if (item.target) item.expectTarget = entry ? { size: entry.size, mtimeNs: entry.mtimeNs } : "absent";
  }
  return { ...unsigned, digest: await planDigest(unsigned) };
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
  const { id } = await runner.submit(await planningExisting(plan, to));
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
  const { id } = await runner.submit(await planningExisting(plan, to));
  const conflict = (await at(id, "awaiting_decision", 0)).pendingConflict!;
  expect(conflict.reason).toBe("exists");
  to.delay = async (op) => {
    if (op === "commit") to.put(target, Uint8Array.of(8), "2");
  };
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
  const temp = phase === "copying" ? (await to.openWrite(target, { tempName: tempNameFor(submitted.id, 0) }, new AbortController().signal)).tempPath : null;
  if (phase === "committed") to.put(target, Uint8Array.of(42, 42, 42), "2");
  await store.checkpoint({
    jobId: submitted.id,
    itemIndex: 0,
    phase: phase === "committed" ? "committed" : "copying",
    bytesDone: temp ? "0" : "3",
    tempPath: temp, tempFingerprint: temp ? { size: "0", mtimeNs: "101" } : undefined, targetPath: null, expectTarget: null, verified: null,
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
  unsigned.targetDir = { endpoint: "host:from", path: { segments: [] } };
  unsigned.conflictPolicy = "overwrite";
  unsigned.items[0].target!.endpoint = "host:from";
  unsigned.items[0].expectTarget = { size: "1", mtimeNs: "1" };
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
  expect((await at(id, "unknown")).items.map(({ outcome }) => outcome)).toEqual(["unknown", "pending"]);
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
  await store.checkpoint({ jobId: id, itemIndex: 0, phase: "verified", bytesDone: "3", tempPath: null, targetPath: null, expectTarget: null, verified: null });
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
  expect((await at(id, "unknown")).items[0].outcome).toBe("unknown");
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
    expectTarget: "absent",
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

test("treats sha256 drift with the same size and mtime as a changed source", async () => {
  const { runner, plan, from, to } = await setup();
  const { digest: _oldDigest, ...unsigned } = plan;
  unsigned.items[0].fingerprint!.sha256 = "596f4162a52f315b2ad0fa53fd30a2769d02a41ed7439123790966eee4ceb5cd";
  const { id } = await runner.submit({ ...unsigned, digest: await planDigest(unsigned) }, { awaitsOwner: true });
  from.put(source, Uint8Array.of(1, 2, 3), "1");
  await expect(runner.approve(id)).rejects.toMatchObject({ code: "changed_since_plan" });
  expect(to.calls).toEqual([]);
});

test("does not persist decisions for later source changes", async () => {
  const { runner, plan, from, to, at } = await setup({ count: 2 });
  from.put(source, Uint8Array.of(7), "2");
  from.put(parsePosix("/a1"), Uint8Array.of(8), "2");
  const { id } = await runner.submit(plan);
  const first = (await at(id, "awaiting_decision", 0)).pendingConflict!;
  await runner.decide(id, { conflictId: first.id, action: "skip", applyTo: "remaining_same_reason" });
  expect((await at(id, "awaiting_decision", 1)).pendingConflict?.reason).toBe("source_changed");
  expect(to.contents(parsePosix("/b1"))).toBeNull();
});

test("does not retry a mutation whose outcome is unknown or run later items", async () => {
  const { runner, plan, at, to } = await setup({ count: 2 });
  to.failOn.push({ op: "commit", path: target, times: 1, error: new CommanderError("outcome_unknown", "Commit reply lost", true) });
  const { id } = await runner.submit(plan);
  expect((await at(id, "unknown")).items.map(({ outcome }) => outcome)).toEqual(["unknown", "pending"]);
  expect(to.calls.filter(({ op }) => op === "commit")).toHaveLength(1);
});

test("reconciles an untouched overwrite target after a restart", async () => {
  const { runner, plan, store, to, at } = await setup({ policy: "overwrite" });
  const { id } = await runner.submit(plan, { awaitsOwner: true });
  await store.update(id, { state: "running", awaitsOwner: false, currentItem: 0 }, "pending");
  to.put(target, Uint8Array.of(7), "2");
  const { tempPath } = await to.openWrite(target, { tempName: tempNameFor(id, 0) }, new AbortController().signal);
  await store.checkpoint({ jobId: id, itemIndex: 0, bytesDone: "0", phase: "copying",
    tempPath, tempFingerprint: { size: "0", mtimeNs: "101" }, targetPath: target,
    expectTarget: { size: "1", mtimeNs: "2" }, verified: null });
  expect(await runner.recover()).toEqual({ resumed: [id], unknown: [] });
  expect((await at(id, "completed")).items[0].outcome).toBe("done");
  expect(to.contents(target)).toEqual(Uint8Array.of(42, 42, 42));
});

test.each(["cancel_requested", "interrupted"] as const)(
  "finishes a durable cancellation found in %s without restarting the transfer",
  async (state) => {
    const { runner, plan, store, to, at } = await setup({ count: 2 });
    const { id } = await runner.submit(plan, { awaitsOwner: true });
    await store.update(id, { state, currentItem: 0, error: { code: "cancelled", message: "Job cancelled", retryable: false } }, "pending");
    const { tempPath } = await to.openWrite(target, { tempName: tempNameFor(id, 0) }, new AbortController().signal);
    await store.checkpoint({ jobId: id, itemIndex: 0, bytesDone: "0", phase: "copying",
      tempPath, tempFingerprint: { size: "0", mtimeNs: "101" }, targetPath: target, expectTarget: "absent", verified: null });
    to.calls.length = 0;
    expect(await runner.recover()).toEqual({ resumed: [], unknown: [] });
    expect((await at(id, "cancelled")).items.map(({ outcome }) => outcome)).toEqual(["pending", "pending"]);
    expect(to.temporaryCount).toBe(0);
    expect(to.calls.some(({ op }) => op === "openWrite")).toBe(false);
  },
);

test("preserves a changed move source at the remove boundary", async () => {
  const { runner, plan, from, to, at } = await setup({ kind: "move" });
  from.delay = async (op) => {
    if (op === "remove") from.put(source, Uint8Array.of(7), "2");
  };
  const { id } = await runner.submit(plan);
  const completed = await at(id, "completed");
  expect(completed.items[0]).toEqual({ outcome: "done", error: "Source changed; source retained" });
  expect(from.contents(source)).toEqual(Uint8Array.of(7));
  expect(to.contents(target)).toEqual(Uint8Array.of(42, 42, 42));
});

test("does not verify source_removed using only a matching file length", async () => {
  const { runner, plan, store, from, to, at } = await setup({ kind: "move" });
  const { id } = await runner.submit(plan, { awaitsOwner: true });
  await store.update(id, { state: "running", currentItem: 0 }, "pending");
  await from.remove(source, { kind: "file" }, new AbortController().signal);
  to.put(target, Uint8Array.of(1, 2, 3), "2");
  await store.checkpoint({ jobId: id, itemIndex: 0, bytesDone: "3", phase: "source_removed",
    tempPath: null, targetPath: target, expectTarget: "absent",
    verified: { size: "3", sha256: "596f4162a52f315b2ad0fa53fd30a2769d02a41ed7439123790966eee4ceb5cd" } });
  expect(await runner.recover()).toEqual({ resumed: [], unknown: [id] });
  expect((await at(id, "unknown")).items[0].outcome).toBe("unknown");
});

test("accepts both legacy conflicts and conflicts with explicit resolutions", () => {
  const conflict = {
    id: "333e4567-e89b-42d3-a456-426614174000",
    jobId: "223e4567-e89b-42d3-a456-426614174000",
    itemIndex: 0,
    reason: "target_changed",
    source: null,
    target: null,
  };
  expect(Conflict.parse(conflict)).toEqual(conflict);
  expect(Conflict.parse({ ...conflict, allowedResolutions: ["skip", "cancel"] }).allowedResolutions).toEqual(["skip", "cancel"]);
});

function pause() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

function delayUpdate(store: MemoryJobStore, state: JobState) {
  const entered = pause();
  const proceed = pause();
  const update = store.update.bind(store);
  vi.spyOn(store, "update").mockImplementation(async (id, patch, expected) => {
    if (patch.state === state) {
      entered.release();
      await proceed.promise;
    }
    return update(id, patch, expected);
  });
  return { entered: entered.promise, release: proceed.release };
}

test.each(["approve", "reject"] as const)("only %s wins the approval CAS", async (winner) => {
  const { runner, plan, store, at } = await setup();
  const { id } = await runner.submit(plan, { awaitsOwner: true });
  const gate = delayUpdate(store, winner === "approve" ? "cancel_requested" : "running");
  const loser = winner === "approve" ? runner.reject(id) : runner.approve(id);
  const rejected = expect(loser).rejects.toMatchObject({ code: "changed_since_plan" });
  await gate.entered;
  try {
    await runner[winner](id);
  } finally {
    gate.release();
  }
  await rejected;
  expect((await at(id, winner === "approve" ? "completed" : "cancelled")).awaitsOwner).toBe(false);
});

test.each(["skip", "cancel"] as const)("only %s wins the decision CAS", async (winner) => {
  const { runner, plan, store, at, to } = await setup();
  to.put(target, Uint8Array.of(5), "2");
  const { id } = await runner.submit(await planningExisting(plan, to));
  const pending = (await at(id, "awaiting_decision")).pendingConflict!;
  expect(pending.reason).toBe("exists");
  const conflictId = pending.id;
  const gate = delayUpdate(store, winner === "skip" ? "cancel_requested" : "running");
  const loser = runner.decide(id, { conflictId, action: winner === "skip" ? "cancel" : "skip", applyTo: "this" });
  const rejected = expect(loser).rejects.toMatchObject({ code: "changed_since_plan" });
  await gate.entered;
  try {
    await runner.decide(id, { conflictId, action: winner, applyTo: "this" });
  } finally {
    gate.release();
  }
  await rejected;
  expect((await at(id, winner === "skip" ? "completed" : "cancelled")).items[0].outcome)
    .toBe(winner === "skip" ? "skipped" : "pending");
});

test.each(["delete", "mkdir", "rename"] as const)("executes a %s plan", async (kind) => {
  const { runner, plan, from, to, at } = await setup({ kind });
  const { digest: _digest, ...unsigned } = plan;
  const item = unsigned.items[0];
  if (kind === "delete") {
    item.target = null;
    item.expectTarget = null;
    unsigned.targetEndpoint = null;
  } else if (kind === "mkdir") {
    item.kind = "dir";
    item.source = null;
    item.fingerprint = null;
    unsigned.sourceEndpoint = null;
    unsigned.totalBytes = "0";
  } else {
    item.target!.endpoint = "host:from";
    unsigned.targetEndpoint = "host:from";
    unsigned.route = "same-endpoint";
  }
  const { id } = await runner.submit({ ...unsigned, digest: await planDigest(unsigned) });
  expect((await at(id, "completed")).items[0].outcome).toBe("done");
  if (kind === "mkdir") {
    expect((await to.stat(target, new AbortController().signal))?.kind).toBe("dir");
  } else {
    expect(from.contents(source)).toBeNull();
    if (kind === "rename") expect(from.contents(target)).toEqual(Uint8Array.of(42, 42, 42));
  }
});

test.each(["remove", "rename"] as const)("checks both locations after interruption during %s", async (operation) => {
  const { runner, plan, from, at } = await setup({ kind: operation === "remove" ? "delete" : "rename" });
  const { digest: _digest, ...unsigned } = plan;
  if (operation === "remove") {
    unsigned.items[0].target = null;
    unsigned.items[0].expectTarget = null;
    unsigned.targetEndpoint = null;
  } else {
    unsigned.items[0].target!.endpoint = "host:from";
    unsigned.targetEndpoint = "host:from";
  }
  const ready = pause();
  from.delay = async (op, _path, signal) => {
    if (operation !== op) return;
    ready.release();
    await new Promise<void>((_, reject) => signal.addEventListener("abort", () => {
      // An external change makes it impossible to tell which mutation took effect.
      from.put(source, Uint8Array.of(6), "2");
      reject(signal.reason);
    }, { once: true }));
  };
  const { id } = await runner.submit({ ...unsigned, digest: await planDigest(unsigned) });
  await ready.promise;
  await runner.cancel(id);
  expect((await at(id, "unknown")).items[0].outcome).toBe("unknown");
  expect(from.contents(source)).toEqual(Uint8Array.of(6));
  expect(from.calls.filter(({ op }) => op === operation)).toHaveLength(1);
});

test("flags a target that appeared after an explicitly absent plan target", async () => {
  const { runner, plan, to, at } = await setup({ policy: "overwrite" });
  const job = await runner.submit(plan, { awaitsOwner: true });
  to.put(target, Uint8Array.of(7), "2");
  await runner.approve(job.id);
  expect((await at(job.id, "awaiting_decision")).pendingConflict?.reason).toBe("target_changed");
  expect(to.contents(target)).toEqual(Uint8Array.of(7));
  expect(to.calls.some(({ op }) => op === "openWrite")).toBe(false);
});

test("retains a target selected by rename when restoring a prepared checkpoint", async () => {
  const { runner, plan, store, to, at } = await setup({ verify: "sha256" });
  const { id } = await runner.submit(plan, { awaitsOwner: true });
  const renamed = parsePosix("/b (2)");
  to.put(target, Uint8Array.of(7), "2");
  await store.update(id, { state: "running", currentItem: 0 }, "pending");
  await store.checkpoint({ jobId: id, itemIndex: 0, bytesDone: "0", phase: "prepared",
    tempPath: null, targetPath: renamed, expectTarget: "absent", verified: null });
  expect(await runner.recover()).toEqual({ resumed: [id], unknown: [] });
  expect((await at(id, "completed")).items[0].outcome).toBe("done");
  expect(to.contents(target)).toEqual(Uint8Array.of(7));
  expect(to.contents(renamed)).toEqual(Uint8Array.of(42, 42, 42));
});

test("can finish cancellation after a second restart following temporary cleanup", async () => {
  const { runner, plan, store, to, at } = await setup({ count: 2 });
  const { id } = await runner.submit(plan, { awaitsOwner: true });
  await store.update(id, { state: "interrupted", currentItem: 0,
    error: { code: "cancelled", message: "Job cancelled", retryable: false } }, "pending");
  const signal = new AbortController().signal;
  const session = await to.openWrite(target, { tempName: tempNameFor(id, 0) }, signal);
  await store.checkpoint({ jobId: id, itemIndex: 0, bytesDone: "0", phase: "prepared",
    tempPath: session.tempPath, targetPath: target, expectTarget: "absent", verified: null });
  await session.abort();
  to.calls.length = 0;
  expect(await runner.recover()).toEqual({ resumed: [], unknown: [] });
  expect((await at(id, "cancelled")).items.map(({ outcome }) => outcome)).toEqual(["pending", "pending"]);
  expect(to.calls.map(({ op }) => op)).toEqual(["stat", "stat"]);
});

test("does not replay commit after a retryable failure if the destination changed", async () => {
  const { runner, plan, at, to } = await setup({ count: 2 });
  to.delay = async (op) => {
    if (op !== "commit") return;
    to.put(target, Uint8Array.of(9, 9, 9), "10");
    throw new CommanderError("timeout", "Commit reply lost", true);
  };
  const { id } = await runner.submit(plan);
  expect((await at(id, "unknown")).items.map(({ outcome }) => outcome)).toEqual(["unknown", "pending"]);
  expect(to.calls.filter(({ op }) => op === "commit")).toHaveLength(1);
  expect(to.contents(target)).toEqual(Uint8Array.of(9, 9, 9));
});

test("persists the exact temporary path before openWrite and recovers a created temp", async () => {
  const { runner, newRunner, plan, store, to, at } = await setup();
  const started = pause();
  const openWrite = to.openWrite.bind(to);
  const intercept = vi.spyOn(to, "openWrite").mockImplementationOnce(async (...args) => {
    await openWrite(...args);
    started.release();
    return new Promise(() => {});
  });
  const { id } = await runner.submit(plan);
  await started.promise;
  const tempPath = parsePosix("/.commander-223e4567-e89b-42d3-a456-000000000001-0.part");
  expect(await store.lastCheckpoint(id, 0)).toEqual({
    jobId: id, itemIndex: 0, phase: "prepared", bytesDone: "0", tempPath, via: "copy",
    targetPath: { segments: [{ t: "b" }] }, expectTarget: "absent", verified: null,
  });
  const foreign = parsePosix("/.other-job.part");
  to.put(foreign, Uint8Array.of(19));
  expect(await newRunner().recover()).toEqual({ resumed: [id], unknown: [] });
  expect((await at(id, "completed")).items[0].outcome).toBe("done");
  expect(to.contents(tempPath)).toBeNull();
  expect(to.contents(foreign)).toEqual(Uint8Array.of(19));
  expect(intercept).toHaveBeenCalledTimes(2);
});

test("retains another item's temp even if a checkpoint points at it", async () => {
  const { runner, plan, store, to, at } = await setup();
  const { id } = await runner.submit(plan, { awaitsOwner: true });
  await store.update(id, { state: "running", currentItem: 0 }, "pending");
  const { tempPath } = await to.openWrite(target, { tempName: { t: ".other-job.part" } }, new AbortController().signal);
  await store.checkpoint({ jobId: id, itemIndex: 0, phase: "prepared", bytesDone: "0", tempPath, targetPath: target,
    expectTarget: "absent", verified: null });
  expect(await runner.recover()).toEqual({ resumed: [], unknown: [id] });
  expect((await at(id, "unknown")).items[0].outcome).toBe("unknown");
  expect(to.temporaryCount).toBe(1);
});

test("preserves a target conflict if a second restart interrupts conflict recovery", async () => {
  const { runner, newRunner, plan, store, to, at } = await setup({ policy: "overwrite" });
  to.put(target, Uint8Array.of(7), "2");
  to.delay = async (op) => {
    if (op === "commit") to.put(target, Uint8Array.of(8), "3");
  };
  const { id } = await runner.submit(await planningExisting(plan, to));
  const initial = await at(id, "awaiting_decision", 0);
  expect(initial.pendingConflict?.reason).toBe("target_changed");
  const update = store.update.bind(store);
  const interrupt = vi.spyOn(store, "update").mockImplementation(async (...args) => {
    const updated = await update(...args);
    if (args[1].state === "interrupted") throw new Error("Process lost after interrupted was saved");
    return updated;
  });
  await expect(newRunner().recover()).rejects.toThrow("Process lost");
  const interrupted = await at(id, "interrupted", 0);
  expect(OperationJob.parse(interrupted).pendingConflict).toEqual(initial.pendingConflict);
  interrupt.mockRestore();
  await newRunner().recover();
  expect((await at(id, "awaiting_decision", 0)).pendingConflict).toEqual(initial.pendingConflict);
  expect(to.contents(target)).toEqual(Uint8Array.of(8));
  expect(to.calls.filter(({ op }) => op === "commit")).toHaveLength(1);
});

test("reports loss of a verified destination and preserves the move source", async () => {
  const { runner, plan, store, from, to, at } = await setup({ kind: "move" });
  const checkpoint = store.checkpoint.bind(store);
  vi.spyOn(store, "checkpoint").mockImplementation(async (point) => {
    await checkpoint(point);
    if (point.phase === "verified") to.put(target, Uint8Array.of(99, 99, 99), "700");
  });
  const { id } = await runner.submit(plan);
  const job = await at(id, "unknown");
  expect(job.items[0]).toEqual({ outcome: "unknown", error: "Verified destination was lost or replaced; source retained" });
  expect(from.contents(source)).toEqual(Uint8Array.of(42, 42, 42));
  expect(from.calls.some(({ op }) => op === "remove")).toBe(false);
});

test("records a verified copy if cancelled during the post-verify target check", async () => {
  const { runner, plan, store, from, to, at } = await setup({ kind: "move" });
  const waiting = pause();
  const checkpoint = store.checkpoint.bind(store);
  vi.spyOn(store, "checkpoint").mockImplementation(async (point) => {
    await checkpoint(point);
    if (point.phase !== "verified") return;
    to.delay = async (op, _path, signal) => {
      if (op !== "stat" || to.delay === undefined) return;
      to.delay = undefined;
      waiting.release();
      await new Promise<void>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    };
  });
  const { id } = await runner.submit(plan);
  await waiting.promise;
  await runner.cancel(id);
  expect((await at(id, "cancelled")).items[0]).toEqual({ outcome: "done", error: "Move cancelled; source retained" });
  expect(from.contents(source)).toEqual(Uint8Array.of(42, 42, 42));
  expect(to.contents(target)).toEqual(Uint8Array.of(42, 42, 42));
});

test("restores a staged parent directory after restarting during a child move", async () => {
  const { runner, newRunner, plan, store, from, to, at } = await setup({ kind: "move" });
  const input = parsePosix("/tree");
  const output = parsePosix("/tree-copy");
  const child = parsePosix("/tree/child");
  const copy = parsePosix("/tree-copy/child");
  const signal = new AbortController().signal;
  await from.mkdir(input, signal);
  const dir = (await from.stat(input, signal))!;
  from.put(child, Uint8Array.of(42, 42, 42), "1");
  const { digest: _digest, ...unsigned } = plan;
  unsigned.items[0].source!.path = child;
  unsigned.items[0].target!.path = copy;
  unsigned.items.unshift({ source: { endpoint: "host:from", path: input }, target: { endpoint: "host:to", path: output },
    kind: "dir", fingerprint: { size: "0", mtimeNs: dir.mtimeNs }, expectTarget: "absent" });
  const waiting = pause();
  const checkpoint = store.checkpoint.bind(store);
  vi.spyOn(store, "checkpoint").mockImplementation(async (point) => {
    await checkpoint(point);
    if (point.itemIndex === 1 && point.phase === "copying") {
      waiting.release();
      return new Promise(() => {});
    }
  });
  const { id } = await runner.submit({ ...unsigned, digest: await planDigest(unsigned) });
  await waiting.promise;
  vi.mocked(store.checkpoint).mockRestore();
  expect(await newRunner().recover()).toEqual({ resumed: [id], unknown: [] });
  expect((await at(id, "completed")).items.map(({ outcome }) => outcome)).toEqual(["done", "done"]);
  expect(await from.stat(input, signal)).toBeNull();
  expect(to.contents(copy)).toEqual(Uint8Array.of(42, 42, 42));
  expect(to.calls.filter(({ op }) => op === "mkdir")).toHaveLength(1);
});

test("leaves approval pending when revalidate fails even if a target conflict is observable", async () => {
  const { runner, plan, to, at } = await setup({
    policy: "overwrite",
    revalidate: async (snapshot) => {
      Object.assign(snapshot.items[0], { expectTarget: "absent" });
      return { ok: false, changed: [{ index: 0, reason: "target_changed" }] } as const;
    },
  });
  const { id } = await runner.submit(plan, { awaitsOwner: true });
  to.put(target, Uint8Array.of(9), "2");
  await expect(runner.approve(id)).rejects.toMatchObject({ code: "changed_since_plan" });
  expect((await at(id, "pending")).awaitsOwner).toBe(true);
  expect(to.contents(target)).toEqual(Uint8Array.of(9));
});

test("reconciles mkdir as done when its prepared destination is already a directory", async () => {
  const { runner, plan, store, to, at } = await setup({ kind: "mkdir" });
  const { digest: _digest, ...unsigned } = plan;
  Object.assign(unsigned.items[0], { source: null, kind: "dir", fingerprint: null });
  unsigned.sourceEndpoint = null;
  unsigned.totalBytes = "0";
  const { id } = await runner.submit({ ...unsigned, digest: await planDigest(unsigned) }, { awaitsOwner: true });
  await store.update(id, { state: "running", currentItem: 0 }, "pending");
  await store.checkpoint({ jobId: id, itemIndex: 0, phase: "prepared", bytesDone: "0", tempPath: null,
    targetPath: target, expectTarget: "absent", verified: null });
  await to.mkdir(target, new AbortController().signal);
  expect(await runner.recover()).toEqual({ resumed: [id], unknown: [] });
  expect((await at(id, "completed")).items[0].outcome).toBe("done");
  expect(to.calls.filter(({ op }) => op === "mkdir")).toHaveLength(1);
});

test("restarts from a verified move checkpoint written by the runner", async () => {
  const { runner, newRunner, plan, store, from, to, at } = await setup({ kind: "move", verify: "sha256" });
  const paused = pause();
  const checkpoint = store.checkpoint.bind(store);
  const write = vi.spyOn(store, "checkpoint").mockImplementation(async (point) => {
    await checkpoint(point);
    if (point.phase === "copying" && point.bytesDone === "3") {
      expect(point.tempFingerprint).toEqual({ size: "3", mtimeNs: "102" });
    }
    if (point.phase === "verified") {
      paused.release();
      return new Promise(() => {});
    }
  });
  const { id } = await runner.submit(plan);
  await paused.promise;
  expect(await store.lastCheckpoint(id, 0)).toEqual({
    jobId: "223e4567-e89b-42d3-a456-000000000001", itemIndex: 0,
    phase: "verified", bytesDone: "3", tempPath: null, via: "copy",
    targetPath: { segments: [{ t: "b" }] }, expectTarget: "absent",
    committed: { size: "3", mtimeNs: "103" },
    verified: { size: "3", sha256: "596f4162a52f315b2ad0fa53fd30a2769d02a41ed7439123790966eee4ceb5cd" },
  });
  write.mockRestore();
  expect(await newRunner().recover()).toEqual({ resumed: [id], unknown: [] });
  expect((await at(id, "completed")).items[0]).toEqual({ outcome: "done", error: null });
  expect(from.contents(source)).toBeNull();
  expect(to.contents(target)).toEqual(Uint8Array.of(42, 42, 42));
  expect(from.calls.filter(({ op }) => op === "remove")).toHaveLength(1);
});

test("restores staged parent directories when a restarted child conflict is decided", async () => {
  const { runner, newRunner, plan, from, to, at } = await setup({ kind: "move" });
  const input = parsePosix("/tree");
  const output = parsePosix("/tree-copy");
  const child = parsePosix("/tree/child");
  const copy = parsePosix("/tree-copy/child");
  const signal = new AbortController().signal;
  await from.mkdir(input, signal);
  const dir = (await from.stat(input, signal))!;
  from.put(child, Uint8Array.of(42, 42, 42), "1");
  to.put(copy, Uint8Array.of(7), "2");
  const { digest: _digest, ...unsigned } = plan;
  unsigned.items[0].source!.path = child;
  unsigned.items[0].target!.path = copy;
  unsigned.items.unshift({ source: { endpoint: "host:from", path: input }, target: { endpoint: "host:to", path: output },
    kind: "dir", fingerprint: { size: "0", mtimeNs: dir.mtimeNs }, expectTarget: "absent" });
  const { id } = await runner.submit(await planningExisting({ ...unsigned, digest: await planDigest(unsigned) }, to));
  const conflict = (await at(id, "awaiting_decision", 1)).pendingConflict!;
  expect(conflict.reason).toBe("exists");
  const restarted = newRunner();
  await restarted.recover();
  await restarted.decide(id, { conflictId: conflict.id, action: "overwrite", applyTo: "this" });
  expect((await at(id, "completed")).items.map(({ outcome }) => outcome)).toEqual(["done", "done"]);
  expect(await from.stat(input, signal)).toBeNull();
  expect(to.contents(copy)).toEqual(Uint8Array.of(42, 42, 42));
  expect(to.calls.filter(({ op }) => op === "mkdir")).toHaveLength(1);
});

test("marks a prepared job unknown if cleanup of its owned temporary file fails", async () => {
  const { runner, plan, store, to, at } = await setup();
  const { id } = await runner.submit(plan, { awaitsOwner: true });
  await store.update(id, { state: "running", currentItem: 0 }, "pending");
  const { tempPath } = await to.openWrite(target, { tempName: tempNameFor(id, 0) }, new AbortController().signal);
  await store.checkpoint({ jobId: id, itemIndex: 0, bytesDone: "0", phase: "prepared", tempPath, targetPath: target,
    expectTarget: "absent", verified: null });
  to.failOn.push({ op: "remove", path: tempPath, times: 1, error: new CommanderError("timeout", "Remove reply lost", true) });
  expect(await runner.recover()).toEqual({ resumed: [], unknown: [id] });
  expect((await at(id, "unknown")).items[0].outcome).toBe("unknown");
  expect(to.calls.filter(({ op }) => op === "remove")).toHaveLength(1);
  expect(to.temporaryCount).toBe(1);
});

test.each([
  ["prepared", "3", "unknown"],
  ["copying", "4", "unknown"],
  ["copying", "3", "cancelled"],
] as const)("only cleans a temp with recorded evidence in %s at size %s", async (phase, actualSize, state) => {
  const { runner, plan, store, to, at } = await setup();
  const { id } = await runner.submit(plan, { awaitsOwner: true });
  await store.update(id, { state: "cancel_requested", currentItem: 0 }, "pending");
  const tempPath = parsePosix("/.commander-223e4567-e89b-42d3-a456-000000000001-0.part");
  const contents = new Uint8Array(Number(actualSize)).fill(7);
  to.put(tempPath, contents, "100");
  await store.checkpoint({ jobId: id, itemIndex: 0, phase, bytesDone: "3", tempPath,
    tempFingerprint: phase === "copying" ? { size: "3", mtimeNs: "100" } : undefined,
    via: "copy", targetPath: target, expectTarget: "absent", verified: null });
  expect(await runner.recover()).toEqual({ resumed: [], unknown: state === "unknown" ? [id] : [] });
  expect((await at(id, state)).items[0].outcome).toBe(state === "unknown" ? "unknown" : "pending");
  expect(to.contents(tempPath)).toEqual(state === "unknown" ? contents : null);
});

test("does not infer a cross-endpoint move from matching metadata in copying", async () => {
  const { runner, plan, store, from, to, at } = await setup({ kind: "move" });
  const { id } = await runner.submit(plan, { awaitsOwner: true });
  await store.update(id, { state: "running", currentItem: 0 }, "pending");
  await from.remove(source, { kind: "file" }, new AbortController().signal);
  to.put(target, Uint8Array.of(9, 9, 9), "1");
  await store.checkpoint({ jobId: id, itemIndex: 0, phase: "copying", bytesDone: "3", tempPath: null,
    via: "copy", targetPath: target, expectTarget: "absent", verified: null });
  expect(await runner.recover()).toEqual({ resumed: [], unknown: [id] });
  expect((await at(id, "unknown")).items[0].outcome).toBe("unknown");
});

test("keeps the source directory if a completed child's destination disappears", async () => {
  const { runner, plan, store, from, to, at } = await setup({ kind: "move" });
  const input = parsePosix("/tree");
  const output = parsePosix("/tree-copy");
  const child = parsePosix("/tree/child");
  const copy = parsePosix("/tree-copy/child");
  const signal = new AbortController().signal;
  await from.mkdir(input, signal);
  const dir = (await from.stat(input, signal))!;
  from.put(child, Uint8Array.of(42, 42, 42), "1");
  const { digest: _digest, ...unsigned } = plan;
  unsigned.items[0].source!.path = child;
  unsigned.items[0].target!.path = copy;
  unsigned.items.unshift({ source: { endpoint: "host:from", path: input }, target: { endpoint: "host:to", path: output },
    kind: "dir", fingerprint: { size: "0", mtimeNs: dir.mtimeNs }, expectTarget: "absent" });
  const update = store.update.bind(store);
  vi.spyOn(store, "update").mockImplementation(async (...args) => {
    const updated = await update(...args);
    if (updated && args[1].items?.[1].outcome === "done" && args[1].items[0].outcome === "pending") {
      await to.remove(copy, { kind: "file" }, signal);
      await to.remove(output, { kind: "dir" }, signal);
      await to.mkdir(output, signal);
    }
    return updated;
  });
  const { id } = await runner.submit({ ...unsigned, digest: await planDigest(unsigned) });
  expect((await at(id, "unknown")).items.map(({ outcome }) => outcome)).toEqual(["unknown", "done"]);
  expect((await from.stat(input, signal))?.kind).toBe("dir");
  expect(from.calls.filter(({ op, path }) => op === "remove" && path.segments.length === 1)).toHaveLength(0);
});

test("treats already_exists from write as unknown rather than a target conflict", async () => {
  const { runner, plan, to, at } = await setup();
  to.failOn.push({ op: "write", path: target, times: 1, error: new CommanderError("already_exists", "Write reported a collision") });
  const { id } = await runner.submit(plan);
  expect((await at(id, "unknown")).items[0].outcome).toBe("unknown");
  expect(to.calls.filter(({ op }) => op === "commit")).toHaveLength(0);
  expect(to.contents(target)).toBeNull();
});

test.each(["retryable", "cancelled", "non-empty"] as const)("reconciles a temp left by an openWrite failure: %s", async (mode) => {
  const { runner, plan, store, to, at } = await setup();
  const opened = pause();
  const openWrite = to.openWrite.bind(to);
  vi.spyOn(to, "openWrite").mockImplementationOnce(async (...args) => {
    const session = await openWrite(...args);
    opened.release();
    if (mode === "cancelled") {
      const signal = args[2];
      await new Promise<void>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    }
    if (mode === "non-empty") to.put(session.tempPath, Uint8Array.of(7), "100");
    throw new CommanderError("timeout", "Open reply lost", true);
  });
  const { id } = await runner.submit(plan);
  await opened.promise;
  if (mode === "cancelled") await runner.cancel(id);
  await at(id, mode === "cancelled" ? "cancelled" : mode === "non-empty" ? "unknown" : "failed");
  const point = await store.lastCheckpoint(id, 0);
  expect(point?.phase).toBe("prepared");
  expect(to.contents(point!.tempPath!)).toEqual(mode === "non-empty" ? Uint8Array.of(7) : null);
  expect(to.calls.filter(({ op }) => op === "remove")).toHaveLength(mode === "non-empty" ? 0 : 1);
});

test.each(["copying", "committed"] as const)("recovers a missing move source in %s only with matching commit evidence", async (phase) => {
  const { runner, plan, store, from, to, at } = await setup({ kind: "move" });
  const { id } = await runner.submit(plan, { awaitsOwner: true });
  await store.update(id, { state: "running", currentItem: 0 }, "pending");
  await from.remove(source, { kind: "file" }, new AbortController().signal);
  to.put(target, Uint8Array.of(42, 42, 42), "50");
  await store.checkpoint({ jobId: id, itemIndex: 0, phase, bytesDone: "3", tempPath: null,
    via: "copy", targetPath: target, expectTarget: "absent", verified: null, committed: { size: "3", mtimeNs: "50" } });
  const done = phase === "committed";
  expect(await runner.recover()).toEqual({ resumed: done ? [id] : [], unknown: done ? [] : [id] });
  expect((await at(id, done ? "completed" : "unknown")).items[0].outcome).toBe(done ? "done" : "unknown");
  expect(to.calls.filter(({ op }) => op === "openWrite")).toHaveLength(0);
});

const signal = () => new AbortController().signal;
const sha42 = "596f4162a52f315b2ad0fa53fd30a2769d02a41ed7439123790966eee4ceb5cd";

async function interruptedCopy(ctx: Awaited<ReturnType<typeof setup>>, written: number, fields: Partial<Checkpoint>) {
  const { runner, plan, store, to } = ctx;
  const { id } = await runner.submit(plan, { awaitsOwner: true });
  await store.update(id, { state: "running", currentItem: 0 }, "pending");
  const { tempPath, write } = await to.openWrite(target, { tempName: tempNameFor(id, 0) }, signal());
  const empty = (await to.stat(tempPath, signal()))!;
  if (written) await write(0n, new Uint8Array(written).fill(42), signal());
  await store.checkpoint({ jobId: id, itemIndex: 0, phase: "copying", bytesDone: "0", tempPath,
    tempFingerprint: { size: empty.size, mtimeNs: empty.mtimeNs }, via: "copy", targetPath: target,
    expectTarget: "absent", verified: null, ...fields });
  return { id, tempPath, empty };
}

test("records write intent before every write and recovers an interrupted write", async () => {
  const ctx = await setup();
  const { runner, newRunner, plan, store, to, at } = ctx;
  const hanging = pause();
  to.delay = async (op) => {
    if (op !== "write") return;
    hanging.release();
    await new Promise<void>(() => {});
  };
  const { id } = await runner.submit(plan);
  await hanging.promise;
  expect(await store.lastCheckpoint(id, 0)).toMatchObject({ phase: "copying", bytesDone: "0", writing: { offset: "0", length: 3 } });
  to.delay = undefined;
  expect(await newRunner().recover()).toEqual({ resumed: [id], unknown: [] });
  expect((await at(id, "completed")).items[0].outcome).toBe("done");
  expect(to.temporaryCount).toBe(0);
  expect(to.contents(target)).toEqual(Uint8Array.of(42, 42, 42));
});

test.each([[2, "completed"], [4, "unknown"]] as const)("a temp of %s bytes after write intent {0,3} leads to %s", async (written, state) => {
  const ctx = await setup();
  const { runner, store, to, at } = ctx;
  const { id, tempPath } = await interruptedCopy(ctx, written, { writing: { offset: "0", length: 3 } });
  const result = await runner.recover();
  expect(result).toEqual({ resumed: state === "completed" ? [id] : [], unknown: state === "unknown" ? [id] : [] });
  await at(id, state);
  if (state === "unknown") expect((await to.stat(tempPath, signal()))?.size).toBe(String(written));
  else expect(to.contents(target)).toEqual(Uint8Array.of(42, 42, 42));
  expect(to.temporaryCount).toBe(state === "unknown" ? 1 : 0);
  expect((await store.lastCheckpoint(id, 0))?.writing).toEqual(state === "unknown" ? { offset: "0", length: 3 } : undefined);
});

test("does not fail when stat of the temp lags behind an acknowledged write", async () => {
  const { runner, plan, to, at } = await setup();
  to.tempStatLag = 1;
  const { id } = await runner.submit(plan);
  expect((await at(id, "completed")).items[0].outcome).toBe("done");
  expect(to.contents(target)).toEqual(Uint8Array.of(42, 42, 42));
});

test.each([
  [Uint8Array.of(42, 42, 42), "completed"],
  [Uint8Array.of(9, 9, 9), "unknown"],
] as const)("move with a missing source after commit is verified by sha256 (%s)", async (bytes, state) => {
  const { runner, plan, store, from, to, at } = await setup({ kind: "move", verify: "sha256" });
  const { digest: _digest, ...unsigned } = plan;
  unsigned.items[0].fingerprint = { size: "3", mtimeNs: "1", sha256: sha42 };
  const { id } = await runner.submit({ ...unsigned, digest: await planDigest(unsigned) }, { awaitsOwner: true });
  await store.update(id, { state: "running", currentItem: 0 }, "pending");
  await from.remove(source, { kind: "file" }, signal());
  to.put(target, bytes, "50");
  await store.checkpoint({ jobId: id, itemIndex: 0, phase: "committed", bytesDone: "3", tempPath: null, via: "copy",
    targetPath: target, expectTarget: "absent", verified: null, committed: { size: "3", mtimeNs: "50" } });
  expect(await runner.recover()).toEqual({ resumed: state === "completed" ? [id] : [], unknown: state === "unknown" ? [id] : [] });
  await at(id, state);
});

test("a move without a source hash cannot prove a sha256 commit after the source is gone", async () => {
  const { runner, plan, store, from, to, at } = await setup({ kind: "move", verify: "sha256" });
  const { id } = await runner.submit(plan, { awaitsOwner: true });
  await store.update(id, { state: "running", currentItem: 0 }, "pending");
  await from.remove(source, { kind: "file" }, signal());
  to.put(target, Uint8Array.of(42, 42, 42), "50");
  await store.checkpoint({ jobId: id, itemIndex: 0, phase: "committed", bytesDone: "3", tempPath: null, via: "copy",
    targetPath: target, expectTarget: "absent", verified: null, committed: { size: "3", mtimeNs: "50" } });
  expect(await runner.recover()).toEqual({ resumed: [], unknown: [id] });
  await at(id, "unknown");
});

test("records verified evidence for a child recovered after rename before the directory is finished", async () => {
  const ctx = await setup({ kind: "move" });
  const { runner, newRunner, plan, store, from, at } = ctx;
  const input = parsePosix("/tree");
  const output = parsePosix("/tree-copy");
  await from.mkdir(input, signal());
  const dir = (await from.stat(input, signal()))!;
  from.put(parsePosix("/tree/child"), Uint8Array.of(42, 42, 42), "1");
  const { digest: _digest, ...unsigned } = plan;
  unsigned.items = [
    { source: { endpoint: "host:from", path: input }, target: { endpoint: "host:from", path: output }, kind: "dir",
      fingerprint: { size: "0", mtimeNs: dir.mtimeNs }, expectTarget: "absent" },
    { source: { endpoint: "host:from", path: parsePosix("/tree/child") },
      target: { endpoint: "host:from", path: parsePosix("/tree-copy/child") }, kind: "file", fingerprint: { size: "3", mtimeNs: "1" }, expectTarget: "absent" },
  ];
  unsigned.targetEndpoint = "host:from";
  unsigned.targetDir = { endpoint: "host:from", path: { segments: [] } };
  const lost = pause();
  const checkpoint = store.checkpoint.bind(store);
  vi.spyOn(store, "checkpoint").mockImplementation(async (point) => {
    if (point.itemIndex === 1 && point.phase === "verified") {
      lost.release();
      return new Promise(() => {});
    }
    await checkpoint(point);
  });
  const { id } = await runner.submit({ ...unsigned, digest: await planDigest(unsigned) });
  await lost.promise;
  vi.mocked(store.checkpoint).mockRestore();
  expect(await newRunner().recover()).toEqual({ resumed: [id], unknown: [] });
  expect((await at(id, "completed")).items.map(({ outcome }) => outcome)).toEqual(["done", "done"]);
  expect(await from.stat(input, signal())).toBeNull();
  expect(from.contents(parsePosix("/tree-copy/child"))).toEqual(Uint8Array.of(42, 42, 42));
  expect(await store.lastCheckpoint(id, 1)).toMatchObject({ phase: "verified", committed: { size: "3", mtimeNs: "1" }, verified: { size: "3" } });
});

test("saves the cleanup intent before removing a recovered temp and survives a crash before the follow-up save", async () => {
  const ctx = await setup();
  const { runner, newRunner, store, to, at } = ctx;
  const { id, tempPath } = await interruptedCopy(ctx, 3, { bytesDone: "3" });
  const staged = (await to.stat(tempPath, signal()))!;
  const lost = pause();
  const checkpoint = store.checkpoint.bind(store);
  vi.spyOn(store, "checkpoint").mockImplementation(async (point) => {
    if (point.phase === "prepared" && !point.cleanup) {
      lost.release();
      return new Promise(() => {});
    }
    await checkpoint(point);
  });
  void runner.recover();
  await lost.promise;
  vi.mocked(store.checkpoint).mockRestore();
  expect(to.contents(tempPath)).toBeNull();
  expect((await store.lastCheckpoint(id, 0))?.cleanup).toEqual({
    tempPath, tempFingerprint: { size: "3", mtimeNs: staged.mtimeNs },
  });
  expect(await newRunner().recover()).toEqual({ resumed: [id], unknown: [] });
  expect((await at(id, "completed")).items[0].outcome).toBe("done");
});

test("removes a temp named by a stored cleanup intent only when it still has that fingerprint", async () => {
  const ctx = await setup();
  const { runner, to, at } = ctx;
  const { id, tempPath } = await interruptedCopy(ctx, 3, {
    bytesDone: "3", cleanup: undefined,
  });
  const staged = (await to.stat(tempPath, signal()))!;
  await ctx.store.checkpoint({ ...(await ctx.store.lastCheckpoint(id, 0))!, cleanup: {
    tempPath, tempFingerprint: { size: "3", mtimeNs: String(Number(staged.mtimeNs) + 7) },
  } });
  expect(await runner.recover()).toEqual({ resumed: [], unknown: [id] });
  await at(id, "unknown");
  expect((await to.stat(tempPath, signal()))?.size).toBe("3");
});

test("treats a copying item without a temp as pending when source and recorded target are unchanged", async () => {
  const { runner, plan, store, to, at } = await setup();
  const { id } = await runner.submit(plan, { awaitsOwner: true });
  await store.update(id, { state: "running", currentItem: 0 }, "pending");
  await store.checkpoint({ jobId: id, itemIndex: 0, phase: "copying", bytesDone: "0", tempPath: null, via: "copy",
    targetPath: target, expectTarget: "absent", verified: null });
  expect(await runner.recover()).toEqual({ resumed: [id], unknown: [] });
  expect((await at(id, "completed")).items[0].outcome).toBe("done");
  expect(to.contents(target)).toEqual(Uint8Array.of(42, 42, 42));
});

test.each(["mkdir", "rename"] as const)("reports already_exists from %s as a target_changed conflict", async (kind) => {
  const { runner, plan, from, to, at } = await setup({ kind });
  const { digest: _digest, ...unsigned } = plan;
  const item = unsigned.items[0];
  if (kind === "mkdir") {
    item.kind = "dir";
    item.source = null;
    item.fingerprint = null;
    unsigned.sourceEndpoint = null;
    unsigned.totalBytes = "0";
  } else {
    item.target!.endpoint = "host:from";
    unsigned.targetEndpoint = "host:from";
    unsigned.route = "same-endpoint";
  }
  (kind === "mkdir" ? to : from).failOn.push({ op: kind, path: target, times: 1,
    error: new CommanderError("already_exists", "Target exists") });
  const { id } = await runner.submit({ ...unsigned, digest: await planDigest(unsigned) });
  expect((await at(id, "awaiting_decision")).pendingConflict?.reason).toBe("target_changed");
});

test.each([["1", "completed"], ["9999", "unknown"]] as const)(
  "without write intent a temp is ours only if mtime is not older than recorded (%s)", async (recordedMtime, state) => {
    const ctx = await setup();
    const { runner, to, at } = ctx;
    const { id, tempPath } = await interruptedCopy(ctx, 6, { bytesDone: "6", tempFingerprint: { size: "3", mtimeNs: recordedMtime } });
    expect(await runner.recover()).toEqual({ resumed: state === "completed" ? [id] : [], unknown: state === "unknown" ? [id] : [] });
    await at(id, state);
    expect((await to.stat(tempPath, signal()))?.size ?? null).toBe(state === "unknown" ? "6" : null);
  });

test.each([["absent", "completed"], ["changed", "unknown"]] as const)(
  "a recorded temp that is physically missing falls back to source and target checks (%s)", async (target_, state) => {
    const ctx = await setup();
    const { runner, to, at } = ctx;
    const { id, tempPath } = await interruptedCopy(ctx, 0, {});
    await to.remove(tempPath, { kind: "file" }, signal());
    if (target_ === "changed") to.put(target, Uint8Array.of(7), "5");
    expect(await runner.recover()).toEqual({ resumed: state === "completed" ? [id] : [], unknown: state === "unknown" ? [id] : [] });
    await at(id, state);
    if (state === "completed") expect(to.contents(target)).toEqual(Uint8Array.of(42, 42, 42));
    else expect(to.contents(target)).toEqual(Uint8Array.of(7));
  });

test.each([
  [Uint8Array.of(42, 42, 42), "completed"],
  [Uint8Array.of(9, 9, 9), "unknown"],
] as const)("recovers a sha256 move from the checkpoint's source hash when the plan has none (%s)", async (bytes, state) => {
  const { runner, plan, store, from, to, at } = await setup({ kind: "move", verify: "sha256" });
  const { id } = await runner.submit(plan, { awaitsOwner: true });
  await store.update(id, { state: "running", currentItem: 0 }, "pending");
  await from.remove(source, { kind: "file" }, signal());
  to.put(target, bytes, "50");
  await store.checkpoint({ jobId: id, itemIndex: 0, phase: "committed", bytesDone: "3", tempPath: null, via: "copy",
    targetPath: target, expectTarget: "absent", verified: null, committed: { size: "3", mtimeNs: "50" }, sourceHash: sha42 });
  expect(await runner.recover()).toEqual({ resumed: state === "completed" ? [id] : [], unknown: state === "unknown" ? [id] : [] });
  await at(id, state);
});

test("saves the transferred source hash with the committed checkpoint", async () => {
  const { runner, plan, store, at } = await setup({ kind: "move", verify: "sha256" });
  const spy = vi.spyOn(store, "checkpoint");
  const { id } = await runner.submit(plan);
  await at(id, "completed");
  const committed = spy.mock.calls.map(([point]) => point).filter((point) => point.phase === "committed");
  expect(committed).toHaveLength(1);
  expect(committed[0].sourceHash).toBe(sha42);
});

test.each([["-1", "completed"], ["-3", "unknown"]] as const)(
  "compares signed mtimeNs without throwing: recorded -2, current %s", async (current, state) => {
    const { runner, plan, store, to, at } = await setup();
    const { id } = await runner.submit(plan, { awaitsOwner: true });
    await store.update(id, { state: "running", currentItem: 0 }, "pending");
    const tempPath = parsePosix("/" + (tempNameFor(id, 0) as { t: string }).t);
    to.put(tempPath, new Uint8Array(6).fill(42), current);
    await store.checkpoint({ jobId: id, itemIndex: 0, phase: "copying", bytesDone: "6", tempPath,
      tempFingerprint: { size: "3", mtimeNs: "-2" }, via: "copy", targetPath: target, expectTarget: "absent", verified: null });
    expect(await runner.recover()).toEqual({ resumed: state === "completed" ? [id] : [], unknown: state === "unknown" ? [id] : [] });
    await at(id, state);
  });

test("a recorded temp that is missing is unknown without a recorded expectTarget, and nothing is reopened", async () => {
  const ctx = await setup();
  const { runner, to, at } = ctx;
  const { id, tempPath } = await interruptedCopy(ctx, 0, { expectTarget: null });
  await to.remove(tempPath, { kind: "file" }, signal());
  to.calls.length = 0;
  expect(await runner.recover()).toEqual({ resumed: [], unknown: [id] });
  await at(id, "unknown");
  expect(to.calls.filter(({ op }) => op === "openWrite")).toHaveLength(0);
});

async function committedMove(sourceBytes: Uint8Array, targetBytes: Uint8Array) {
  const ctx = await setup({ kind: "move", verify: "sha256" });
  const { runner, plan, store, from, to } = ctx;
  const { id } = await runner.submit(plan, { awaitsOwner: true });
  await store.update(id, { state: "running", currentItem: 0 }, "pending");
  from.put(source, sourceBytes, "1");
  to.put(target, targetBytes, "50");
  await store.checkpoint({ jobId: id, itemIndex: 0, phase: "committed", bytesDone: "3", tempPath: null, via: "copy",
    targetPath: target, expectTarget: "absent", verified: null, committed: { size: "3", mtimeNs: "50" }, sourceHash: sha42 });
  return { ...ctx, id };
}

test("does not remove a surviving source whose bytes differ from the transferred hash", async () => {
  const { runner, from, to, at, id } = await committedMove(Uint8Array.of(9, 9, 9), Uint8Array.of(9, 9, 9));
  expect(await runner.recover()).toEqual({ resumed: [], unknown: [id] });
  await at(id, "unknown");
  expect(from.contents(source)).toEqual(Uint8Array.of(9, 9, 9));
  expect(from.calls.filter(({ op }) => op === "remove")).toHaveLength(0);
  expect(to.contents(target)).toEqual(Uint8Array.of(9, 9, 9));
});

test("clears the source hash when recovery reaches verified", async () => {
  const { runner, store, from, at, id } = await committedMove(Uint8Array.of(42, 42, 42), Uint8Array.of(42, 42, 42));
  expect(await runner.recover()).toEqual({ resumed: [id], unknown: [] });
  await at(id, "completed");
  expect(from.contents(source)).toBeNull();
  const point = await store.lastCheckpoint(id, 0);
  expect(point?.phase).toBe("source_removed");
  expect(point?.sourceHash).toBeUndefined();
});

test("clears the source hash when a missing-source recovery is recorded as verified", async () => {
  const { runner, store, from, at, id } = await committedMove(Uint8Array.of(42, 42, 42), Uint8Array.of(42, 42, 42));
  await from.remove(source, { kind: "file" }, signal());
  expect(await runner.recover()).toEqual({ resumed: [id], unknown: [] });
  await at(id, "completed");
  const point = await store.lastCheckpoint(id, 0);
  expect(point?.phase).toBe("verified");
  expect(point?.sourceHash).toBeUndefined();
});

test("renames only the case of a name on a case-insensitive endpoint, from the real S2 plan to the final spelling", async () => {
  const fake = new FakeProvider("host:ci", false);
  const dir = parsePosix("/d");
  const upper = parsePosix("/d/A");
  await fake.mkdir(dir, signal());
  fake.put(upper, Uint8Array.of(1, 2, 3), "7");
  const plan = await buildPlan({
    kind: "rename", initiator: { kind: "owner" }, sources: [{ endpoint: "host:ci", path: upper }], targetDir: null,
    newName: { t: "a" }, conflictPolicy: "ask", verify: "size",
  }, {
    provider: () => fake, now: () => new Date(date), uuid: () => "323e4567-e89b-42d3-a456-426614174000",
    limits: { maxItems: 100, maxDepth: 10 }, protectedPathsFor: () => [],
  }, signal());
  expect(plan.items[0].expectTarget).toBe("absent");
  const store = new MemoryJobStore();
  let next = 0;
  const runner = new JobRunner({
    store, provider: () => fake, now: () => new Date(date), uuid: () => "423e4567-e89b-42d3-a456-" + String(++next).padStart(12, "0"),
    onEvent: () => {},
  });
  const { id } = await runner.submit(plan, { awaitsOwner: true });
  await runner.approve(id);
  const job = await vi.waitFor(async () => {
    const current = (await store.get(id))!;
    expect(current.state).toBe("completed");
    return current;
  });
  expect(job.items[0].outcome).toBe("done");
  const names = (await fake.list(dir, { cursor: null, limit: 10 }, signal())).entries.map(({ name }) => name);
  expect(names).toEqual([{ t: "a" }]);
  expect(fake.contents(upper)).toEqual(Uint8Array.of(1, 2, 3));
});

test("still rejects a copy whose target folds onto its own source", async () => {
  const fake = new FakeProvider("host:ci", false);
  fake.put(parsePosix("/A"), Uint8Array.of(1), "7");
  const entry = (await fake.stat(parsePosix("/A"), signal()))!;
  const unsigned: Omit<OperationPlan, "digest"> = {
    id: "123e4567-e89b-42d3-a456-426614174000", createdAt: date, initiator: { kind: "owner" }, kind: "copy",
    sourceEndpoint: "host:ci", targetEndpoint: "host:ci", targetDir: { endpoint: "host:ci", path: { segments: [] } },
    items: [{ source: { endpoint: "host:ci", path: parsePosix("/A") }, target: { endpoint: "host:ci", path: parsePosix("/a") },
      kind: "file", fingerprint: { size: entry.size, mtimeNs: entry.mtimeNs }, expectTarget: "absent" }],
    route: "same-endpoint", conflictPolicy: "ask", verify: "size", totalBytes: "1",
  };
  const store = new MemoryJobStore();
  const runner = new JobRunner({ store, provider: () => fake, now: () => new Date(date), uuid: () => "523e4567-e89b-42d3-a456-000000000001", onEvent: () => {} });
  const { id } = await runner.submit({ ...unsigned, digest: await planDigest(unsigned) });
  const job = await vi.waitFor(async () => {
    const current = (await store.get(id))!;
    expect(["failed", "awaiting_decision", "completed", "unknown"]).toContain(current.state);
    return current;
  });
  expect(job.state).toBe("failed");
  expect(job.items[0].error).toBe("Destination overlaps source");
  expect(fake.contents(parsePosix("/A"))).toEqual(Uint8Array.of(1));
});

async function caseRename() {
  const fake = new FakeProvider("host:ci", false);
  const dir = parsePosix("/d");
  const upper = parsePosix("/d/A");
  await fake.mkdir(dir, signal());
  fake.put(upper, Uint8Array.of(1, 2, 3), "7");
  const plan = await buildPlan({
    kind: "rename", initiator: { kind: "owner" }, sources: [{ endpoint: "host:ci", path: upper }], targetDir: null,
    newName: { t: "a" }, conflictPolicy: "ask", verify: "size",
  }, {
    provider: () => fake, now: () => new Date(date), uuid: () => "323e4567-e89b-42d3-a456-426614174000",
    limits: { maxItems: 100, maxDepth: 10 }, protectedPathsFor: () => [],
  }, signal());
  const store = new MemoryJobStore();
  let next = 0;
  const newRunner = () => new JobRunner({
    store, provider: () => fake, now: () => new Date(date),
    uuid: () => "423e4567-e89b-42d3-a456-" + String(++next).padStart(12, "0"), onEvent: () => {},
  });
  const names = async () => (await fake.list(dir, { cursor: null, limit: 10 }, signal())).entries.map(({ name }) => name);
  const at = (id: string, state: JobState) => vi.waitFor(async () => {
    const job = (await store.get(id))!;
    expect(job.state).toBe(state);
    return job;
  });
  return { fake, dir, upper, plan, store, newRunner, runner: newRunner(), names, at, renames: () => fake.calls.filter(({ op }) => op === "rename") };
}

test("a rename decision on a changed case-only source targets a new name without replacing anything", async () => {
  const { fake, upper, plan, runner, names, at } = await caseRename();
  fake.put(upper, Uint8Array.of(1, 2, 3), "8");
  const rename = vi.spyOn(fake, "rename");
  const { id } = await runner.submit(plan);
  const conflict = (await at(id, "awaiting_decision")).pendingConflict!;
  expect(conflict.reason).toBe("source_changed");
  await runner.decide(id, { conflictId: conflict.id, action: "rename", applyTo: "this" });
  expect((await at(id, "completed")).items[0].outcome).toBe("done");
  expect(rename).toHaveBeenCalledTimes(1);
  expect(rename.mock.calls[0].slice(0, 3)).toEqual([upper, parsePosix("/d/a (2)"), { replace: false, expectTarget: "absent" }]);
  expect(await names()).toEqual([{ t: "a (2)" }]);
});

test("a lost reply after a successful case-only rename is done without a second rename", async () => {
  const { fake, plan, runner, names, at, renames } = await caseRename();
  const original = fake.rename.bind(fake);
  vi.spyOn(fake, "rename").mockImplementationOnce(async (...args) => {
    await original(...args);
    throw new CommanderError("timeout", "Reply lost", true);
  });
  const { id } = await runner.submit(plan);
  expect((await at(id, "completed")).items[0].outcome).toBe("done");
  expect(renames()).toHaveLength(1);
  expect(await names()).toEqual([{ t: "a" }]);
});

test("a case-only rename that failed before applying stays failed, not done", async () => {
  const { fake, plan, runner, names, at } = await caseRename();
  vi.spyOn(fake, "rename").mockImplementationOnce(async () => {
    throw new CommanderError("timeout", "Reply lost", true);
  });
  const { id } = await runner.submit(plan);
  expect((await at(id, "failed")).items[0].outcome).toBe("failed");
  expect(await names()).toEqual([{ t: "A" }]);
});

test("restarting between a case-only rename and its verified checkpoint finishes it as done", async () => {
  const { fake, plan, store, runner, newRunner, names, at, renames } = await caseRename();
  const lost = pause();
  const checkpoint = store.checkpoint.bind(store);
  vi.spyOn(store, "checkpoint").mockImplementation(async (point) => {
    if (point.phase === "verified") {
      lost.release();
      return new Promise(() => {});
    }
    await checkpoint(point);
  });
  const { id } = await runner.submit(plan);
  await lost.promise;
  vi.mocked(store.checkpoint).mockRestore();
  expect(await names()).toEqual([{ t: "a" }]);
  expect(await newRunner().recover()).toEqual({ resumed: [id], unknown: [] });
  expect((await at(id, "completed")).items[0].outcome).toBe("done");
  expect(renames()).toHaveLength(1);
  expect(fake.contents(parsePosix("/d/a"))).toEqual(Uint8Array.of(1, 2, 3));
});

test("restarting before a case-only rename was applied leaves it pending and runs it once", async () => {
  const { plan, store, runner, newRunner, names, at, renames } = await caseRename();
  const lost = pause();
  const checkpoint = store.checkpoint.bind(store);
  vi.spyOn(store, "checkpoint").mockImplementation(async (point) => {
    await checkpoint(point);
    if (point.phase === "prepared" && point.via === "rename") {
      lost.release();
      return new Promise(() => {});
    }
  });
  const { id } = await runner.submit(plan);
  await lost.promise;
  vi.mocked(store.checkpoint).mockRestore();
  expect(await names()).toEqual([{ t: "A" }]);
  expect(await newRunner().recover()).toEqual({ resumed: [id], unknown: [] });
  expect((await at(id, "completed")).items[0].outcome).toBe("done");
  expect(renames()).toHaveLength(1);
  expect(await names()).toEqual([{ t: "a" }]);
});

test("cancelling during a case-only rename records its actual result", async () => {
  const { fake, plan, runner, names, at, renames } = await caseRename();
  const original = fake.rename.bind(fake);
  const applied = pause();
  vi.spyOn(fake, "rename").mockImplementationOnce(async (from, to, opts, stepSignal) => {
    await original(from, to, opts, stepSignal);
    applied.release();
    await new Promise<void>((_, reject) => stepSignal.addEventListener("abort", () => reject(stepSignal.reason), { once: true }));
  });
  const { id } = await runner.submit(plan);
  await applied.promise;
  await runner.cancel(id);
  expect((await at(id, "cancelled")).items[0].outcome).toBe("done");
  expect(renames()).toHaveLength(1);
  expect(await names()).toEqual([{ t: "a" }]);
});
