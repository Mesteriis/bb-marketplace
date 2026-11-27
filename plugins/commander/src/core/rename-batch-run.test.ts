import { afterEach, expect, test, vi } from "vitest";
import { CommanderError } from "./errors.ts";
import { JobRunner, type RunnerDeps } from "./job-runner.ts";
import { OperationJob, planDigest, type Fingerprint, type JobState, type OperationPlan, type PlanItem } from "./model.ts";
import { parsePosix, type ResourcePath } from "./path.ts";
import { FakeProvider } from "./testing/fake-provider.ts";
import { MemoryJobStore } from "./testing/memory-job-store.ts";
import { tempNameFor } from "./reconcile.ts";

const date = "2026-11-27T00:00:00.000Z";
const JOB_ID = "323e4567-e89b-42d3-a456-426614174000";
const PLAN_ID = "423e4567-e89b-42d3-a456-426614174000";
const mib = 1024 * 1024;

function text(bytes: Uint8Array | null): string | null {
  return bytes === null ? null : new TextDecoder().decode(bytes);
}

function fp(size: string, mtimeNs: string): Fingerprint {
  return { size, mtimeNs };
}

/** A rename plan written the way the planner writes one: same endpoint, sibling targets. */
async function renamePlan(items: Array<{ from: string; to: string; fingerprint: Fingerprint; expect: Fingerprint | "absent"; kind?: "file" | "dir" }>) {
  const plan: PlanItem[] = items.map((item) => ({
    source: { endpoint: "host:x", path: parsePosix(item.from) },
    target: { endpoint: "host:x", path: parsePosix(item.to) },
    kind: item.kind ?? "file",
    fingerprint: item.fingerprint,
    expectTarget: item.expect,
  }));
  const unsigned: Omit<OperationPlan, "digest"> = {
    id: PLAN_ID,
    createdAt: date,
    initiator: { kind: "owner" },
    kind: "rename",
    sourceEndpoint: "host:x",
    targetEndpoint: "host:x",
    targetDir: null,
    items: plan,
    conflictPolicy: "ask",
    route: "same-endpoint",
    verify: "size",
    totalBytes: String(items.reduce((sum, item) => sum + Number(item.fingerprint.size), 0)),
  };
  return { ...unsigned, digest: await planDigest(unsigned) };
}

/** The default for setup: the provider computes SHA-256 on the host, as a local endpoint does. `both` changes it. */
let checksumDefault = true;
afterEach(() => { checksumDefault = true; });

/** Runs a scenario twice: with SHA-256 computed on the host, and without it (SFTP). */
function both(name: string, body: () => Promise<void>) {
  for (const checksum of [true, false]) {
    test(name + " (sha256 " + (checksum ? "on" : "off") + ")", async () => {
      checksumDefault = checksum;
      await body();
    });
  }
}

/** The provider computes SHA-256 on the host by default; `checksum: false` models SFTP. */
async function setup(files: Array<[string, string, string]>, caseSensitive = true, options: { checksum?: boolean } = {}) {
  const provider = new FakeProvider("host:x", caseSensitive);
  if (options.checksum ?? checksumDefault) provider.enableChecksum();
  for (const [path, bytes, mtime] of files) {
    provider.put(parsePosix(path), new TextEncoder().encode(bytes), mtime);
  }
  const store = new MemoryJobStore();
  const newRunner = () => new JobRunner({
    store,
    provider: () => provider,
    now: () => new Date(date),
    uuid: () => JOB_ID,
    chunkBytes: mib,
    retryDelay: vi.fn(async () => {}),
    onEvent: () => {},
  } satisfies RunnerDeps);
  const runner = newRunner();
  async function at(id: string, state: JobState): Promise<OperationJob> {
    return vi.waitFor(async () => {
      const job = (await store.get(id))!;
      expect(job.state).toBe(state);
      return job;
    });
  }
  return { provider, store, runner, newRunner, at };
}

/** The leaf name's text, or "" for a non-text name or the root. */
function leaf(path: ResourcePath): string {
  const name = path.segments.at(-1);
  return name !== undefined && "t" in name ? name.t : "";
}

function isTemp(path: ResourcePath): boolean {
  return leaf(path).startsWith(".commander-");
}

test("a cycle a→b, b→a completes with the names swapped and nothing lost", async () => {
  const { provider, runner, at } = await setup([["/a.txt", "AAA", "1000"], ["/b.txt", "BB", "2000"]]);
  const plan = await renamePlan([
    { from: "/a.txt", to: "/b.txt", fingerprint: fp("3", "1000"), expect: fp("2", "2000") },
    { from: "/b.txt", to: "/a.txt", fingerprint: fp("2", "2000"), expect: fp("3", "1000") },
  ]);
  const { id } = await runner.submit(plan);
  const job = await at(id, "completed");
  expect(job.items.map(({ outcome }) => outcome)).toEqual(["done", "done"]);
  expect(text(provider.contents(parsePosix("/b.txt")))).toBe("AAA");
  expect(text(provider.contents(parsePosix("/a.txt")))).toBe("BB");
});

test("case-only A.txt → a.txt on a case-insensitive endpoint completes beside another rename", async () => {
  const { provider, runner, at } = await setup([["/A.txt", "X", "1000"], ["/c.txt", "C", "2000"]], false);
  const plan = await renamePlan([
    { from: "/A.txt", to: "/a.txt", fingerprint: fp("1", "1000"), expect: "absent" },
    { from: "/c.txt", to: "/d.txt", fingerprint: fp("1", "2000"), expect: "absent" },
  ]);
  const { id } = await runner.submit(plan);
  await at(id, "completed");
  expect(text(provider.contents(parsePosix("/a.txt")))).toBe("X");
  expect(text(provider.contents(parsePosix("/d.txt")))).toBe("C");
  expect(provider.contents(parsePosix("/c.txt"))).toBeNull();
  // The contents lookup folds case; the listing shows the spelling that actually landed.
  const page = await provider.list(parsePosix("/"), { cursor: null, limit: 100 }, new AbortController().signal);
  const names = page.entries.map((entry) => ("t" in entry.name ? entry.name.t : ""));
  expect(names).toContain("a.txt");
  expect(names).not.toContain("A.txt");
});

both("a crash between the phases resumes on restart and finishes the swap without losing a file", async () => {
  const { provider, runner, newRunner, store, at } = await setup([["/a.txt", "AAA", "1000"], ["/b.txt", "BB", "2000"]]);
  const plan = await renamePlan([
    { from: "/a.txt", to: "/b.txt", fingerprint: fp("3", "1000"), expect: fp("2", "2000") },
    { from: "/b.txt", to: "/a.txt", fingerprint: fp("2", "2000"), expect: fp("3", "1000") },
  ]);
  // Stop the runner at the first move to a target: both sources are already at their temporary names.
  // The delay hook receives the rename's destination: a temporary name in phase 1, a target in phase 2.
  let crashing: Promise<void> | null = null;
  provider.delay = async (op, path, signal) => {
    if (op !== "rename" || isTemp(path) || crashing) return;
    // shutdown aborts synchronously, so the wait is skipped when the signal is already aborted.
    crashing = runner.shutdown();
    if (!signal.aborted) {
      await new Promise((_, reject) => signal.addEventListener("abort", () => reject(new CommanderError("cancelled", "stop"))));
    }
    signal.throwIfAborted();
  };
  const { id } = await runner.submit(plan);
  await vi.waitFor(() => expect(crashing).not.toBeNull());
  await crashing;
  expect((await store.get(id))?.state).toBe("running");
  provider.delay = undefined;
  await newRunner().recover();
  await at(id, "completed");
  expect(text(provider.contents(parsePosix("/b.txt")))).toBe("AAA");
  expect(text(provider.contents(parsePosix("/a.txt")))).toBe("BB");
});

both("a target taken after staging fails the item, and the staged files return to their names", async () => {
  const { provider, runner, at } = await setup([["/a.txt", "A", "1000"], ["/c.txt", "C", "2000"]]);
  const plan = await renamePlan([
    { from: "/a.txt", to: "/x.txt", fingerprint: fp("1", "1000"), expect: "absent" },
    { from: "/c.txt", to: "/y.txt", fingerprint: fp("1", "2000"), expect: "absent" },
  ]);
  // A foreign file appears at the first target just before the first move to it (phase 2).
  provider.delay = async (op, path) => {
    if (op === "rename" && !isTemp(path) && leaf(path) === "x.txt") {
      provider.put(parsePosix("/x.txt"), new TextEncoder().encode("F"), "3000");
    }
  };
  const { id } = await runner.submit(plan);
  const job = await at(id, "failed");
  expect(job.items.map(({ outcome }) => outcome)).toEqual(["failed", "pending"]);
  expect(text(provider.contents(parsePosix("/a.txt")))).toBe("A");
  expect(text(provider.contents(parsePosix("/c.txt")))).toBe("C");
  expect(text(provider.contents(parsePosix("/x.txt")))).toBe("F");
  expect(provider.contents(parsePosix("/y.txt"))).toBeNull();
});

both("a cancel during the first phase returns every staged file to its name", async () => {
  const { provider, runner, store, at } = await setup([["/a.txt", "A", "1000"], ["/c.txt", "C", "2000"]]);
  const plan = await renamePlan([
    { from: "/a.txt", to: "/x.txt", fingerprint: fp("1", "1000"), expect: "absent" },
    { from: "/c.txt", to: "/y.txt", fingerprint: fp("1", "2000"), expect: "absent" },
  ]);
  // The run may reach the hook before submit returns, so the job id is the one setup fixes.
  const id = JOB_ID;
  const secondTemp = tempNameFor(JOB_ID, 1);
  provider.delay = async (op, path) => {
    // The second source is about to move to its temporary name. Request the cancel without
    // waiting for the run (cancel waits for it), and let the move go on only once the cancel is recorded.
    if (op !== "rename" || leaf(path) !== ("t" in secondTemp ? secondTemp.t : "")) return;
    void runner.cancel(id);
    await vi.waitFor(async () => expect((await store.get(id))?.state).toBe("cancel_requested"));
  };
  await runner.submit(plan);
  await at(id, "cancelled");
  expect(text(provider.contents(parsePosix("/a.txt")))).toBe("A");
  expect(text(provider.contents(parsePosix("/c.txt")))).toBe("C");
  expect(provider.contents(parsePosix("/x.txt"))).toBeNull();
  const temp = tempNameFor(id, 0);
  expect(provider.contents(parsePosix("/" + ("t" in temp ? temp.t : "")))).toBeNull();
});

test("a source changed after planning fails its item before anything moves", async () => {
  const { provider, runner, at } = await setup([["/a.txt", "A", "1000"], ["/c.txt", "C", "2000"]]);
  const plan = await renamePlan([
    { from: "/a.txt", to: "/x.txt", fingerprint: fp("1", "1000"), expect: "absent" },
    { from: "/c.txt", to: "/y.txt", fingerprint: fp("1", "2000"), expect: "absent" },
  ]);
  provider.put(parsePosix("/a.txt"), new TextEncoder().encode("AAAA"), "1500");
  const { id } = await runner.submit(plan);
  const job = await at(id, "failed");
  expect(job.items.map(({ outcome }) => outcome)).toEqual(["failed", "pending"]);
  expect(text(provider.contents(parsePosix("/a.txt")))).toBe("AAAA");
  expect(text(provider.contents(parsePosix("/c.txt")))).toBe("C");
});

both("a crash after the first move of a cycle's second phase restarts and finishes the swap", async () => {
  const { provider, runner, newRunner, store, at } = await setup([["/a.txt", "AAA", "1000"], ["/b.txt", "BB", "2000"]]);
  const plan = await renamePlan([
    { from: "/a.txt", to: "/b.txt", fingerprint: fp("3", "1000"), expect: fp("2", "2000") },
    { from: "/b.txt", to: "/a.txt", fingerprint: fp("2", "2000"), expect: fp("3", "1000") },
  ]);
  // Stop when the second item's phase-2 move (to /a.txt) is about to run: /b.txt already holds AAA.
  let crashing: Promise<void> | null = null;
  provider.delay = async (op, path, signal) => {
    if (op !== "rename" || isTemp(path) || leaf(path) !== "a.txt" || crashing) return;
    crashing = runner.shutdown();
    if (!signal.aborted) {
      await new Promise((_, reject) => signal.addEventListener("abort", () => reject(new CommanderError("cancelled", "stop"))));
    }
    signal.throwIfAborted();
  };
  const { id } = await runner.submit(plan);
  await vi.waitFor(() => expect(crashing).not.toBeNull());
  await crashing;
  expect((await store.get(id))?.state).toBe("running");
  provider.delay = undefined;
  await newRunner().recover();
  await at(id, "completed");
  expect(text(provider.contents(parsePosix("/b.txt")))).toBe("AAA");
  expect(text(provider.contents(parsePosix("/a.txt")))).toBe("BB");
});

test("retry of a finished batch rename is refused with the 2a text and plans nothing", async () => {
  const { provider, runner, at } = await setup([["/a.txt", "A", "1000"], ["/c.txt", "C", "2000"]]);
  const plan = await renamePlan([
    { from: "/a.txt", to: "/x.txt", fingerprint: fp("1", "1000"), expect: "absent" },
    { from: "/c.txt", to: "/y.txt", fingerprint: fp("1", "2000"), expect: "absent" },
  ]);
  provider.put(parsePosix("/a.txt"), new TextEncoder().encode("AAAA"), "1500");
  const { id } = await runner.submit(plan);
  await at(id, "failed");
  await expect(runner.retryJob(id, { kind: "owner" })).rejects.toThrow(
    "Batch rename retry is not available: check the job",
  );
});

both("restart after the last phase-2 move, with identical size and mtime, records done without moving anything", async () => {
  const { provider, runner, newRunner, store, at } = await setup([["/a.txt", "AA", "1000"], ["/b.txt", "BB", "1000"]]);
  const plan = await renamePlan([
    { from: "/a.txt", to: "/b.txt", fingerprint: fp("2", "1000"), expect: fp("2", "1000") },
    { from: "/b.txt", to: "/a.txt", fingerprint: fp("2", "1000"), expect: fp("2", "1000") },
  ]);
  const lastTemp = tempNameFor(JOB_ID, 1);
  const lastTempName = "t" in lastTemp ? lastTemp.t : "";
  // The last move has landed (its temporary name is gone and /a.txt holds the content) but its
  // record was not written: stop at the confirmation read of /a.txt.
  let crashing: Promise<void> | null = null;
  provider.delay = async (op, path, signal) => {
    if (op !== "stat" || leaf(path) !== "a.txt" || crashing) return;
    // The stat must directly follow the move into /a.txt (the call log records this stat last).
    const previous = provider.calls.at(-2);
    if (!(previous?.op === "rename" && leaf(previous.path) === "a.txt")) return;
    crashing = runner.shutdown();
    if (!signal.aborted) {
      await new Promise((_, reject) => signal.addEventListener("abort", () => reject(new CommanderError("cancelled", "stop"))));
    }
    signal.throwIfAborted();
  };
  const { id } = await runner.submit(plan);
  await vi.waitFor(() => expect(crashing).not.toBeNull());
  await crashing;
  expect((await store.get(id))?.state).toBe("running");
  provider.delay = undefined;
  const renamesBefore = provider.calls.filter(({ op }) => op === "rename").length;
  await newRunner().recover();
  await at(id, "completed");
  expect(provider.calls.filter(({ op }) => op === "rename").length).toBe(renamesBefore);
  expect(text(provider.contents(parsePosix("/b.txt")))).toBe("AA");
  expect(text(provider.contents(parsePosix("/a.txt")))).toBe("BB");
});

test("a cancel during the second phase is refused, and the batch completes", async () => {
  const { provider, runner, store, at } = await setup([["/a.txt", "AAA", "1000"], ["/b.txt", "BB", "2000"]]);
  const plan = await renamePlan([
    { from: "/a.txt", to: "/b.txt", fingerprint: fp("3", "1000"), expect: fp("2", "2000") },
    { from: "/b.txt", to: "/a.txt", fingerprint: fp("2", "2000"), expect: fp("3", "1000") },
  ]);
  let refused: unknown = null;
  provider.delay = async (op, path) => {
    // Inside the second phase, before its first target move: the cancel is refused.
    if (op !== "rename" || isTemp(path) || leaf(path) !== "b.txt" || refused !== null) return;
    refused = await runner.cancel(JOB_ID).catch((error: unknown) => error);
  };
  await runner.submit(plan);
  const job = await at(JOB_ID, "completed");
  expect(refused).toBeInstanceOf(CommanderError);
  expect((refused as CommanderError).message).toBe("Batch rename cancel is unavailable: the second phase is running");
  expect(job.items.map(({ outcome }) => outcome)).toEqual(["done", "done"]);
  expect(text(provider.contents(parsePosix("/b.txt")))).toBe("AAA");
  expect(text(provider.contents(parsePosix("/a.txt")))).toBe("BB");
  expect((await store.get(JOB_ID))?.error).toBeNull();
});

test("a staged item that cannot go back is unknown on its own index; the other items still return", async () => {
  const { provider, runner, at } = await setup([["/a.txt", "A", "1000"], ["/c.txt", "C", "2000"], ["/e.txt", "E", "3000"]]);
  const plan = await renamePlan([
    { from: "/a.txt", to: "/x.txt", fingerprint: fp("1", "1000"), expect: "absent" },
    { from: "/c.txt", to: "/y.txt", fingerprint: fp("1", "2000"), expect: "absent" },
    { from: "/e.txt", to: "/z.txt", fingerprint: fp("1", "3000"), expect: "absent" },
  ]);
  // The first target is taken by a foreign file, so the first item fails its second phase.
  provider.delay = async (op, path) => {
    if (op !== "rename") return;
    if (!isTemp(path) && leaf(path) === "x.txt") {
      provider.put(parsePosix("/x.txt"), new TextEncoder().encode("F"), "4000");
    }
    // The second item cannot return to its source name.
    if (!isTemp(path) && leaf(path) === "c.txt") throw new CommanderError("permission_denied", "denied");
  };
  const { id } = await runner.submit(plan);
  const job = await at(id, "unknown");
  expect(job.items.map(({ outcome }) => outcome)).toEqual(["failed", "unknown", "pending"]);
  expect(text(provider.contents(parsePosix("/a.txt")))).toBe("A");
  expect(text(provider.contents(parsePosix("/e.txt")))).toBe("E");
  expect(text(provider.contents(parsePosix("/x.txt")))).toBe("F");
  expect(provider.contents(parsePosix("/c.txt"))).toBeNull();
  const kept = tempNameFor(id, 1);
  expect(provider.contents(parsePosix("/" + ("t" in kept ? kept.t : "")))).not.toBeNull();
});

test("a failed first observation ends the job failed on that item, not running", async () => {
  const { provider, runner, at } = await setup([["/a.txt", "A", "1000"], ["/c.txt", "C", "2000"]]);
  const plan = await renamePlan([
    { from: "/a.txt", to: "/x.txt", fingerprint: fp("1", "1000"), expect: "absent" },
    { from: "/c.txt", to: "/y.txt", fingerprint: fp("1", "2000"), expect: "absent" },
  ]);
  provider.failOn.push({ op: "stat", path: parsePosix("/a.txt"), times: 1, error: new CommanderError("permission_denied", "denied") });
  const { id } = await runner.submit(plan);
  // The first item cannot be read: it fails, and the item not read yet is unknown, so the job ends unknown.
  const job = await at(id, "unknown");
  expect(job.items.map(({ outcome }) => outcome)).toEqual(["failed", "unknown"]);
  expect(job.items[0].error).toBe("denied");
  expect(job.error?.code).toBe("permission_denied");
});

test("a staged file replaced with other bytes of the same size and mtime is unknown, and nothing moves", async () => {
  const { provider, runner, newRunner, store, at } = await setup([["/a.txt", "AA", "1000"], ["/b.txt", "BB", "1000"]]);
  const plan = await renamePlan([
    { from: "/a.txt", to: "/b.txt", fingerprint: fp("2", "1000"), expect: fp("2", "1000") },
    { from: "/b.txt", to: "/a.txt", fingerprint: fp("2", "1000"), expect: fp("2", "1000") },
  ]);
  // Stop before the first phase-2 move: both sources are staged.
  let crashing: Promise<void> | null = null;
  provider.delay = async (op, path, signal) => {
    if (op !== "rename" || isTemp(path) || crashing) return;
    crashing = runner.shutdown();
    if (!signal.aborted) {
      await new Promise((_, reject) => signal.addEventListener("abort", () => reject(new CommanderError("cancelled", "stop"))));
    }
    signal.throwIfAborted();
  };
  const { id } = await runner.submit(plan);
  await vi.waitFor(() => expect(crashing).not.toBeNull());
  await crashing;
  // The first staged file is replaced: same size, same mtime, other bytes.
  const firstTemp = tempNameFor(id, 0);
  provider.put(parsePosix("/" + ("t" in firstTemp ? firstTemp.t : "")), new TextEncoder().encode("XX"), "1000");
  provider.delay = undefined;
  await newRunner().recover();
  const job = await at(id, "unknown");
  expect((await store.get(id))?.items.map(({ outcome }) => outcome)).toEqual(["unknown", "pending"]);
  expect(job.items.map(({ outcome }) => outcome)).toEqual(["unknown", "pending"]);
  expect(text(provider.contents(parsePosix("/" + ("t" in firstTemp ? firstTemp.t : ""))))).toBe("XX");
  expect(text(provider.contents(parsePosix("/b.txt")))).toBe("BB");
  expect(provider.contents(parsePosix("/a.txt"))).toBeNull();
});

test("a cancel between the last move and the completed state is refused, and the batch completes", async () => {
  const { provider, runner, at } = await setup([["/a.txt", "AAA", "1000"], ["/b.txt", "BB", "2000"]]);
  const plan = await renamePlan([
    { from: "/a.txt", to: "/b.txt", fingerprint: fp("3", "1000"), expect: fp("2", "2000") },
    { from: "/b.txt", to: "/a.txt", fingerprint: fp("2", "2000"), expect: fp("3", "1000") },
  ]);
  let refused: unknown = null;
  provider.delay = async (op, path) => {
    // The confirmation read after the last move: the batch has committed, the state is not yet written.
    if (op !== "stat" || leaf(path) !== "a.txt" || refused !== null) return;
    const previous = provider.calls.at(-2);
    if (!(previous?.op === "rename" && leaf(previous.path) === "a.txt")) return;
    refused = await runner.cancel(JOB_ID).catch((error: unknown) => error);
  };
  await runner.submit(plan);
  const job = await at(JOB_ID, "completed");
  expect((refused as CommanderError).message).toBe("Batch rename cancel is unavailable: the second phase is running");
  expect(job.items.map(({ outcome }) => outcome)).toEqual(["done", "done"]);
});

test("a restart of a cancelling batch with a phase-2 intent completes it instead of rolling back", async () => {
  const { provider, runner, newRunner, store, at } = await setup([["/a.txt", "AAA", "1000"], ["/b.txt", "BB", "2000"]]);
  const plan = await renamePlan([
    { from: "/a.txt", to: "/b.txt", fingerprint: fp("3", "1000"), expect: fp("2", "2000") },
    { from: "/b.txt", to: "/a.txt", fingerprint: fp("2", "2000"), expect: fp("3", "1000") },
  ]);
  let crashing: Promise<void> | null = null;
  provider.delay = async (op, path, signal) => {
    if (op !== "rename" || isTemp(path) || crashing) return;
    crashing = runner.shutdown();
    if (!signal.aborted) {
      await new Promise((_, reject) => signal.addEventListener("abort", () => reject(new CommanderError("cancelled", "stop"))));
    }
    signal.throwIfAborted();
  };
  const { id } = await runner.submit(plan);
  await vi.waitFor(() => expect(crashing).not.toBeNull());
  await crashing;
  // The owner asked to cancel before the restart; the intent is already durable.
  await store.update(id, { error: new CommanderError("cancelled", "Job cancelled").toShape() }, "running");
  provider.delay = undefined;
  await newRunner().recover();
  await at(id, "completed");
  expect(text(provider.contents(parsePosix("/b.txt")))).toBe("AAA");
  expect(text(provider.contents(parsePosix("/a.txt")))).toBe("BB");
});

test("a normal batch on a provider without SHA-256 reads no file content; with it, one SHA-256 per file and no read", async () => {
  const plain = await setup([["/a.txt", "A", "1000"], ["/c.txt", "C", "2000"]], true, { checksum: false });
  const planPlain = await renamePlan([
    { from: "/a.txt", to: "/x.txt", fingerprint: fp("1", "1000"), expect: "absent" },
    { from: "/c.txt", to: "/y.txt", fingerprint: fp("1", "2000"), expect: "absent" },
  ]);
  await plain.runner.submit(planPlain);
  await plain.at(JOB_ID, "completed");
  expect(plain.provider.calls.filter(({ op }) => op === "read")).toHaveLength(0);
  expect(plain.provider.calls.filter(({ op }) => op === "sha256")).toHaveLength(0);

  const hashed = await setup([["/a.txt", "A", "1000"], ["/c.txt", "C", "2000"]]);
  const planHashed = await renamePlan([
    { from: "/a.txt", to: "/x.txt", fingerprint: fp("1", "1000"), expect: "absent" },
    { from: "/c.txt", to: "/y.txt", fingerprint: fp("1", "2000"), expect: "absent" },
  ]);
  await hashed.runner.submit(planHashed);
  await hashed.at(JOB_ID, "completed");
  expect(hashed.provider.calls.filter(({ op }) => op === "sha256")).toHaveLength(2);
  expect(hashed.provider.calls.filter(({ op }) => op === "read")).toHaveLength(0);
});

test("a directory item whose source holds a file with the same type-less size and mtime is unknown, and nothing moves", async () => {
  const { provider, runner, at } = await setup([["/a.txt", "A", "1000"], ["/c.txt", "C", "2000"]]);
  const plan = await renamePlan([
    { from: "/a.txt", to: "/x", fingerprint: fp("1", "1000"), expect: "absent", kind: "dir" },
    { from: "/c.txt", to: "/y.txt", fingerprint: fp("1", "2000"), expect: "absent" },
  ]);
  const { id } = await runner.submit(plan);
  const job = await at(id, "unknown");
  expect(job.items.map(({ outcome }) => outcome)).toEqual(["unknown", "pending"]);
  expect(text(provider.contents(parsePosix("/a.txt")))).toBe("A");
  expect(text(provider.contents(parsePosix("/c.txt")))).toBe("C");
});

test("an old-format record (no SHA-256) over a staged file is unknown on restart, and nothing moves", async () => {
  const { provider, runner, newRunner, store, at } = await setup([["/a.txt", "AAA", "1000"], ["/b.txt", "BB", "2000"]]);
  const plan = await renamePlan([
    { from: "/a.txt", to: "/b.txt", fingerprint: fp("3", "1000"), expect: fp("2", "2000") },
    { from: "/b.txt", to: "/a.txt", fingerprint: fp("2", "2000"), expect: fp("3", "1000") },
  ]);
  let crashing: Promise<void> | null = null;
  provider.delay = async (op, path, signal) => {
    if (op !== "rename" || isTemp(path) || crashing) return;
    crashing = runner.shutdown();
    if (!signal.aborted) {
      await new Promise((_, reject) => signal.addEventListener("abort", () => reject(new CommanderError("cancelled", "stop"))));
    }
    signal.throwIfAborted();
  };
  const { id } = await runner.submit(plan);
  await vi.waitFor(() => expect(crashing).not.toBeNull());
  await crashing;
  // The record written by the previous format: the same checkpoint fields, no verified identity.
  const first = tempNameFor(id, 0);
  await store.checkpoint({
    jobId: id, itemIndex: 0, phase: "prepared", bytesDone: "0", via: "rename",
    tempPath: parsePosix("/" + ("t" in first ? first.t : "")), targetPath: parsePosix("/b.txt"),
    expectTarget: "absent", verified: null,
  });
  provider.delay = undefined;
  const renamesBefore = provider.calls.filter(({ op }) => op === "rename").length;
  await newRunner().recover();
  const job = await at(id, "unknown");
  expect(job.items.map(({ outcome }) => outcome)).toEqual(["unknown", "pending"]);
  // The second item was found staged and proven, but the first item is unknown, so it goes back
  // to its source instead of moving on: exactly one rename, the return of the second item.
  expect(provider.calls.filter(({ op }) => op === "rename").length).toBe(renamesBefore + 1);
  expect(text(provider.contents(parsePosix("/b.txt")))).toBe("BB");
  expect(text(provider.contents(parsePosix("/" + ("t" in first ? first.t : ""))))).toBe("AAA");
});

test("a restart of a committed batch refuses a cancel that arrives during its first read", async () => {
  const { provider, runner, newRunner, at } = await setup([["/a.txt", "AAA", "1000"], ["/b.txt", "BB", "2000"]]);
  const plan = await renamePlan([
    { from: "/a.txt", to: "/b.txt", fingerprint: fp("3", "1000"), expect: fp("2", "2000") },
    { from: "/b.txt", to: "/a.txt", fingerprint: fp("2", "2000"), expect: fp("3", "1000") },
  ]);
  let crashing: Promise<void> | null = null;
  provider.delay = async (op, path, signal) => {
    if (op !== "rename" || isTemp(path) || crashing) return;
    crashing = runner.shutdown();
    if (!signal.aborted) {
      await new Promise((_, reject) => signal.addEventListener("abort", () => reject(new CommanderError("cancelled", "stop"))));
    }
    signal.throwIfAborted();
  };
  const { id } = await runner.submit(plan);
  await vi.waitFor(() => expect(crashing).not.toBeNull());
  await crashing;
  provider.delay = undefined;
  let refused: unknown = null;
  provider.delay = async (op) => {
    // The first read after the restart: the batch is committed and must not be cancelled from here on.
    if (op !== "stat" || refused !== null) return;
    refused = await runner.cancel(id).catch((error: unknown) => error);
  };
  await newRunner().recover();
  await at(id, "completed");
  expect((refused as CommanderError).message).toBe("Batch rename cancel is unavailable: the second phase is running");
});

test("a restart with own records returns the first item, and the second, whose read failed, stays unknown under its temporary name", async () => {
  const { provider, runner, newRunner, store, at } = await setup([["/a.txt", "A", "1000"], ["/c.txt", "C", "2000"]], true, { checksum: false });
  const plan = await renamePlan([
    { from: "/a.txt", to: "/x.txt", fingerprint: fp("1", "1000"), expect: "absent" },
    { from: "/c.txt", to: "/y.txt", fingerprint: fp("1", "2000"), expect: "absent" },
  ]);
  let crashing: Promise<void> | null = null;
  provider.delay = async (op, path, signal) => {
    if (op !== "rename" || isTemp(path) || crashing) return;
    crashing = runner.shutdown();
    if (!signal.aborted) {
      await new Promise((_, reject) => signal.addEventListener("abort", () => reject(new CommanderError("cancelled", "stop"))));
    }
    signal.throwIfAborted();
  };
  const { id } = await runner.submit(plan);
  await vi.waitFor(() => expect(crashing).not.toBeNull());
  await crashing;
  provider.delay = undefined;
  // The second item's source cannot be read on the restart.
  provider.failOn.push({ op: "stat", path: parsePosix("/c.txt"), times: 1, error: new CommanderError("permission_denied", "denied") });
  await newRunner().recover();
  const job = await at(id, "unknown");
  // The first item is proven by its own record and goes back; the second has its own record and
  // its read failed, so it may be mid-move: unknown, and its file stays under its temporary name.
  expect(job.items.map(({ outcome }) => outcome)).toEqual(["pending", "unknown"]);
  const second = tempNameFor(id, 1);
  expect(text(provider.contents(parsePosix("/" + ("t" in second ? second.t : ""))))).toBe("C");
  expect(text(provider.contents(parsePosix("/a.txt")))).toBe("A");
  expect((await store.get(id))?.items[1].error).toBeTruthy();
});

test("a confirmed item stays done in the journal when the next item turns out unknown", async () => {
  const { provider, runner, newRunner, store, at } = await setup([["/a.txt", "A", "1000"], ["/c.txt", "C", "2000"]]);
  const plan = await renamePlan([
    { from: "/a.txt", to: "/x.txt", fingerprint: fp("1", "1000"), expect: "absent" },
    { from: "/c.txt", to: "/y.txt", fingerprint: fp("1", "2000"), expect: "absent" },
  ]);
  // Stop before the second item's move: the first item has landed, the second is staged.
  let crashing: Promise<void> | null = null;
  provider.delay = async (op, path, signal) => {
    if (op !== "rename" || isTemp(path) || leaf(path) !== "y.txt" || crashing) return;
    crashing = runner.shutdown();
    if (!signal.aborted) {
      await new Promise((_, reject) => signal.addEventListener("abort", () => reject(new CommanderError("cancelled", "stop"))));
    }
    signal.throwIfAborted();
  };
  const { id } = await runner.submit(plan);
  await vi.waitFor(() => expect(crashing).not.toBeNull());
  await crashing;
  // The second item's staged file disappears: its next item is unknown.
  const second = tempNameFor(id, 1);
  await provider.remove(parsePosix("/" + ("t" in second ? second.t : "")), { kind: "file" }, new AbortController().signal);
  provider.delay = undefined;
  await newRunner().recover();
  const job = await at(id, "unknown");
  expect(job.items.map(({ outcome }) => outcome)).toEqual(["done", "unknown"]);
  expect((await store.get(id))?.items.map(({ outcome }) => outcome)).toEqual(["done", "unknown"]);
  expect(text(provider.contents(parsePosix("/x.txt")))).toBe("A");
});

test("a directory whose temporary name holds a foreign entry with the same size and mtime is unknown and nothing moves", async () => {
  const { provider, runner, at } = await setup([["/c.txt", "C", "2000"]]);
  // The foreign directory sits under the temporary name of item 0, with the planned size and mtime.
  const first = tempNameFor(JOB_ID, 0);
  const firstName = "t" in first ? first.t : "";
  await provider.mkdir(parsePosix("/" + firstName), new AbortController().signal);
  const foreign = await provider.stat(parsePosix("/" + firstName), new AbortController().signal);
  const plan = await renamePlan([
    { from: "/d", to: "/x", fingerprint: { size: foreign!.size, mtimeNs: foreign!.mtimeNs }, expect: "absent", kind: "dir" },
    { from: "/c.txt", to: "/y.txt", fingerprint: fp("1", "2000"), expect: "absent" },
  ]);
  const { id } = await runner.submit(plan);
  const job = await at(id, "unknown");
  expect(job.items.map(({ outcome }) => outcome)).toEqual(["unknown", "pending"]);
  expect(await provider.stat(parsePosix("/" + firstName), new AbortController().signal)).not.toBeNull();
  expect(await provider.stat(parsePosix("/x"), new AbortController().signal)).toBeNull();
  expect(text(provider.contents(parsePosix("/c.txt")))).toBe("C");
});

test("a failed read of an item with its own record is unknown, and both temporary names stay where they are", async () => {
  const { provider, runner, newRunner, at } = await setup([["/a.txt", "A", "1000"], ["/c.txt", "C", "2000"]]);
  const plan = await renamePlan([
    { from: "/a.txt", to: "/x.txt", fingerprint: fp("1", "1000"), expect: "absent" },
    { from: "/c.txt", to: "/y.txt", fingerprint: fp("1", "2000"), expect: "absent" },
  ]);
  let crashing: Promise<void> | null = null;
  provider.delay = async (op, path, signal) => {
    if (op !== "rename" || isTemp(path) || crashing) return;
    crashing = runner.shutdown();
    if (!signal.aborted) {
      await new Promise((_, reject) => signal.addEventListener("abort", () => reject(new CommanderError("cancelled", "stop"))));
    }
    signal.throwIfAborted();
  };
  const { id } = await runner.submit(plan);
  await vi.waitFor(() => expect(crashing).not.toBeNull());
  await crashing;
  provider.delay = undefined;
  // The first item cannot go back (its source name is taken), and the second cannot be read.
  provider.put(parsePosix("/a.txt"), new TextEncoder().encode("Z"), "9000");
  provider.failOn.push({ op: "stat", path: parsePosix("/c.txt"), times: 1, error: new CommanderError("permission_denied", "denied") });
  await newRunner().recover();
  const job = await at(id, "unknown");
  expect(job.items.map(({ outcome }) => outcome)).toEqual(["unknown", "unknown"]);
  const first = tempNameFor(id, 0);
  const second = tempNameFor(id, 1);
  expect(text(provider.contents(parsePosix("/" + ("t" in first ? first.t : ""))))).toBe("A");
  expect(text(provider.contents(parsePosix("/" + ("t" in second ? second.t : ""))))).toBe("C");
  expect(text(provider.contents(parsePosix("/a.txt")))).toBe("Z");
  void provider;
});

test("after a restart, recover() then cancel() on one runner is refused while the committed batch runs", async () => {
  const { provider, runner, newRunner, store, at } = await setup([["/a.txt", "AAA", "1000"], ["/b.txt", "BB", "2000"]]);
  const plan = await renamePlan([
    { from: "/a.txt", to: "/b.txt", fingerprint: fp("3", "1000"), expect: fp("2", "2000") },
    { from: "/b.txt", to: "/a.txt", fingerprint: fp("2", "2000"), expect: fp("3", "1000") },
  ]);
  let crashing: Promise<void> | null = null;
  provider.delay = async (op, path, signal) => {
    if (op !== "rename" || isTemp(path) || crashing) return;
    crashing = runner.shutdown();
    if (!signal.aborted) {
      await new Promise((_, reject) => signal.addEventListener("abort", () => reject(new CommanderError("cancelled", "stop"))));
    }
    signal.throwIfAborted();
  };
  const { id } = await runner.submit(plan);
  await vi.waitFor(() => expect(crashing).not.toBeNull());
  await crashing;
  expect((await store.get(id))?.state).toBe("running");
  // The first read after the restart waits until the cancel has been tried.
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  provider.delay = async (op, _path, signal) => {
    if (op !== "stat") return;
    await Promise.race([gate, new Promise((_, reject) => signal.addEventListener("abort", () => reject(new CommanderError("cancelled", "aborted"))))]);
  };
  const next = newRunner();
  await next.recover();
  const attempt = await next.cancel(id).then(() => null, (error: unknown) => error);
  release();
  expect(attempt).toBeInstanceOf(CommanderError);
  expect((attempt as CommanderError).message).toBe("Batch rename cancel is unavailable: the second phase is running");
  await at(id, "completed");
  expect(text(provider.contents(parsePosix("/b.txt")))).toBe("AAA");
  expect(text(provider.contents(parsePosix("/a.txt")))).toBe("BB");
});
