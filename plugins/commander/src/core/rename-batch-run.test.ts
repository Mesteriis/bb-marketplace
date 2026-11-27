import { expect, test, vi } from "vitest";
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
async function renamePlan(items: Array<{ from: string; to: string; fingerprint: Fingerprint; expect: Fingerprint | "absent" }>) {
  const plan: PlanItem[] = items.map((item) => ({
    source: { endpoint: "host:x", path: parsePosix(item.from) },
    target: { endpoint: "host:x", path: parsePosix(item.to) },
    kind: "file",
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

async function setup(files: Array<[string, string, string]>, caseSensitive = true) {
  const provider = new FakeProvider("host:x", caseSensitive);
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
});

test("a crash between the phases resumes on restart and finishes the swap without losing a file", async () => {
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

test("a target taken after staging fails the item, and the staged files return to their names", async () => {
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

test("a cancel during the first phase returns every staged file to its name", async () => {
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
