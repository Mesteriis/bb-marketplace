import { expect, test, vi } from "vitest";
import type { PluginKvStorage } from "@get-bb/plugin-sdk";
import { JobRunner } from "../../core/job-runner.ts";
import Database from "better-sqlite3";
import { parsePosix } from "../../core/path.ts";
import { FakeProvider } from "../../core/testing/fake-provider.ts";
import { createSqliteJobStore } from "./job-store-sqlite.ts";
import { MIGRATIONS } from "./migrations.ts";
import { createAgentGrants } from "./agent-grants.ts";
import type { Endpoints } from "./endpoints.ts";
import { createOperations, createRpcHandlers } from "./rpc-handlers.ts";
import type { ScanRunner } from "../../core/scan-job.ts";
import { revalidate } from "../../core/planner.ts";

async function fixture() {
  const signal = new AbortController().signal;
  const src = new FakeProvider("host:left");
  const dst = new FakeProvider("host:right");
  const provider = (id: string) => id === "host:left" ? src : dst;
  const db = new Database(":memory:");
  for (const migration of MIGRATIONS) db.exec(migration);
  const store = createSqliteJobStore(db);
  const planner = {
    provider, uuid: () => crypto.randomUUID(), now: () => new Date("2026-11-27T00:00:00Z"),
    limits: { maxItems: 100, maxDepth: 5 }, protectedPathsFor: () => [],
  };
  const newRunner = () => new JobRunner({
    ...planner, store, onEvent: () => {}, revalidate: (plan, signal) => revalidate(plan, planner, signal),
  });
  const runner = newRunner();
  const rows = new Map<string, unknown>();
  const kv = {
    get: async (key: string) => rows.get(key),
    set: async (key: string, value: unknown) => { rows.set(key, value); },
  } as PluginKvStorage;
  const grants = createAgentGrants(kv);
  const root = parsePosix("/");
  const ops = createOperations({
    endpoints: { prepare: async () => {}, provider } as unknown as Endpoints,
    runner, planner, grants, kv, publish: () => {}, ready: async () => {}, isManaged: () => false,
    store, scans: { cancelAgent: () => {} } as unknown as ScanRunner,
  });
  const request = {
    left: { endpoint: "host:left", path: root }, right: { endpoint: "host:right", path: root },
    direction: "left-to-right", by: "size+mtime", includeDeletes: true,
  } as const;
  const dispose = async () => { await runner.shutdown(); db.close(); };
  return { src, dst, ops, store, runner, newRunner, request, grants, root, signal, dispose };
}

test("S13 stages deletion for an agent with read and write but no delete", async () => {
  const { ops, request, grants, root, signal, dst, dispose } = await fixture();
  const initiator = { kind: "agent", threadId: "thread-test" } as const;
  try {
    dst.put(parsePosix("/extra.txt"), Uint8Array.of(17), "1000000000");
    await grants.set({ threadId: initiator.threadId, endpoint: "*", scope: root, permissions: ["read", "write"] });
    const sync = await ops.createSync(request, initiator, signal);
    const plan = sync.deletes!;
    await expect(ops.runPlan({ planId: plan.id, digest: plan.digest }, initiator, signal))
      .resolves.toMatchObject({ awaitsOwner: true, state: "pending", plan: { kind: "delete", syncId: sync.id } });
    expect(dst.contents(parsePosix("/extra.txt"))).toEqual(Uint8Array.of(17));
  } finally { await dispose(); }
});

test("owner plan_run persists a later subtree conflict before the first remove", async () => {
  const { src, dst, ops, store, request, signal, dispose } = await fixture();
  const handlers = createRpcHandlers(ops);
  const ctx = {
    experimental_caller: { kind: "client" }, experimental_signal: signal,
  } as Parameters<typeof handlers.plan_run>[1];
  const ahead = parsePosix("/ahead.txt");
  const old = parsePosix("/old");
  const nested = parsePosix("/old/b.txt");
  try {
    dst.put(ahead, Uint8Array.of(19));
    await dst.mkdir(old, signal);
    dst.put(nested, Uint8Array.of(17));
    const { deletes } = await handlers.sync_create(request, ctx);
    await src.mkdir(old, signal);
    const job = await handlers.plan_run({ planId: deletes!.id, digest: deletes!.digest }, ctx);
    await vi.waitFor(async () => expect((await store.get(job.id))?.pendingConflict).toMatchObject({
      reason: "target_changed", allowedResolutions: ["skip", "cancel"],
    }));
    expect(dst.calls.filter(({ op }) => op === "remove")).toHaveLength(0);
    expect(dst.contents(ahead)).toEqual(Uint8Array.of(19));
    expect(dst.contents(nested)).toEqual(Uint8Array.of(17));
    await handlers.job_cancel({ jobId: job.id }, ctx);
    expect((await store.get(job.id))?.state).toBe("cancelled");
  } finally { await dispose(); }
});

test("restart after the first write restores the preflight conflict without removing anything", async () => {
  const { src, dst, ops, store, runner, newRunner, request, signal, dispose } = await fixture();
  const afterRestart = newRunner();
  const owner = { kind: "owner" } as const;
  const ahead = parsePosix("/ahead.txt");
  const old = parsePosix("/old");
  const nested = parsePosix("/old/b.txt");
  try {
    dst.put(ahead, Uint8Array.of(19));
    await dst.mkdir(old, signal);
    dst.put(nested, Uint8Array.of(17));
    const { deletes } = await ops.createSync(request, owner, signal);
    await src.mkdir(old, signal);

    const create = store.create.bind(store);
    let id = "";
    const stopAfterWrite = vi.spyOn(store, "create").mockImplementationOnce(async (job) => {
      await create(job);
      id = job.id;
      throw new Error("Stopped immediately after persisting the job");
    });
    await expect(ops.runPlan({ planId: deletes!.id, digest: deletes!.digest }, owner, signal))
      .rejects.toThrow("Stopped immediately after persisting the job");
    await runner.shutdown();

    await afterRestart.recover();
    await vi.waitFor(async () => expect((await store.get(id))?.pendingConflict).toMatchObject({
      itemIndex: 1, reason: "target_changed", allowedResolutions: ["skip", "cancel"],
    }));
    expect(dst.calls.filter(({ op }) => op === "remove")).toHaveLength(0);
    expect(dst.contents(ahead)).toEqual(Uint8Array.of(19));
    expect(dst.contents(nested)).toEqual(Uint8Array.of(17));
    expect(stopAfterWrite).toHaveBeenCalledTimes(1);
    expect(stopAfterWrite.mock.calls[0][0]).toMatchObject({
      state: "awaiting_decision", awaitsOwner: false, pendingConflict: { itemIndex: 1, reason: "target_changed" },
    });
  } finally {
    await afterRestart.shutdown();
    await dispose();
  }
});

test("plan_approve persists approval and conflict together, surviving an immediate restart and grant revocation", async () => {
  const { src, dst, ops, store, runner, newRunner, grants, root, request, signal, dispose } = await fixture();
  const afterRestart = newRunner();
  const handlers = createRpcHandlers(ops);
  const ctx = {
    experimental_caller: { kind: "client" }, experimental_signal: signal,
  } as Parameters<typeof handlers.plan_approve>[1];
  const agent = { kind: "agent", threadId: "thread-test" } as const;
  const grant = { threadId: agent.threadId, endpoint: "*", scope: root } as const;
  const ahead = parsePosix("/ahead.txt");
  const old = parsePosix("/old");
  const nested = parsePosix("/old/b.txt");
  try {
    await grants.set({ ...grant, permissions: ["read", "write"] });
    dst.put(ahead, Uint8Array.of(19));
    await dst.mkdir(old, signal);
    dst.put(nested, Uint8Array.of(17));
    const { deletes } = await ops.createSync(request, agent, signal);
    const plan = deletes!;
    const { id } = await ops.runPlan({ planId: plan.id, digest: plan.digest }, agent, signal);
    await src.mkdir(old, signal);

    const update = store.update.bind(store);
    const stopAfterWrite = vi.spyOn(store, "update").mockImplementationOnce(async (...args) => {
      await update(...args);
      throw new Error("Stopped after the first approval write");
    });
    await expect(handlers.plan_approve({ jobId: id, digest: plan.digest }, ctx)).rejects.toMatchObject({ code: "invalid" });
    await runner.shutdown();

    await afterRestart.recover();
    await vi.waitFor(async () => expect(await store.get(id)).toMatchObject({
      state: "awaiting_decision", awaitsOwner: false,
      pendingConflict: { itemIndex: 1, reason: "target_changed", allowedResolutions: ["skip", "cancel"] },
    }));
    expect(dst.calls.filter(({ op }) => op === "remove")).toHaveLength(0);
    expect(dst.contents(ahead)).toEqual(Uint8Array.of(19));
    expect(dst.contents(nested)).toEqual(Uint8Array.of(17));
    expect(stopAfterWrite.mock.calls[0][1]).toMatchObject({
      state: "awaiting_decision", awaitsOwner: false, pendingConflict: { itemIndex: 1, reason: "target_changed" },
    });
    expect(store.hasOwnerApproval(id)).toBe(true);

    await handlers.agent_grants_revoke(grant, ctx);
    expect(await grants.forThread(agent.threadId)).toEqual([]);
    expect(await store.get(id)).toMatchObject({ state: "awaiting_decision", pendingConflict: { itemIndex: 1 } });
  } finally {
    await afterRestart.shutdown();
    await dispose();
  }
});
