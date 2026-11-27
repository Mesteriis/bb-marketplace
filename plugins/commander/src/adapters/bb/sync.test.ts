import { expect, test } from "vitest";
import type { PluginKvStorage } from "@get-bb/plugin-sdk";
import { JobRunner } from "../../core/job-runner.ts";
import type { AgentJobStore } from "../../core/job-store.ts";
import { parsePosix } from "../../core/path.ts";
import { FakeProvider } from "../../core/testing/fake-provider.ts";
import { MemoryJobStore } from "../../core/testing/memory-job-store.ts";
import { createAgentGrants } from "./agent-grants.ts";
import type { Endpoints } from "./endpoints.ts";
import { createOperations } from "./rpc-handlers.ts";
import type { ScanRunner } from "../../core/scan-job.ts";

test("S13 stages deletion for an agent with read and write but no delete", async () => {
  const signal = new AbortController().signal;
  const initiator = { kind: "agent", threadId: "thread-test" } as const;
  const src = new FakeProvider("host:left");
  const dst = new FakeProvider("host:right");
  dst.put(parsePosix("/extra.txt"), Uint8Array.of(17), "1000000000");
  const provider = (id: string) => id === "host:left" ? src : dst;
  const store = new MemoryJobStore();
  const planner = {
    provider, uuid: () => crypto.randomUUID(), now: () => new Date("2026-11-27T00:00:00Z"),
    limits: { maxItems: 100, maxDepth: 5 }, protectedPathsFor: () => [],
  };
  const runner = new JobRunner({ ...planner, store, onEvent: () => {} });
  const rows = new Map<string, unknown>();
  const kv = {
    get: async (key: string) => rows.get(key),
    set: async (key: string, value: unknown) => { rows.set(key, value); },
  } as PluginKvStorage;
  const grants = createAgentGrants(kv);
  const root = parsePosix("/");
  await grants.set({ threadId: initiator.threadId, endpoint: "*", scope: root, permissions: ["read", "write"] });
  const ops = createOperations({
    endpoints: { prepare: async () => {}, provider } as unknown as Endpoints,
    runner, planner, grants, kv, publish: () => {}, ready: async () => {}, isManaged: () => true,
    store: Object.assign(store, {
      approvalQueueSize: () => ({ thread: 0, total: 0 }),
    }) as unknown as AgentJobStore,
    scans: {} as ScanRunner,
  });
  try {
    const sync = await ops.createSync({
      left: { endpoint: "host:left", path: root }, right: { endpoint: "host:right", path: root },
      direction: "left-to-right", by: "size+mtime", includeDeletes: true,
    }, initiator, signal);
    const plan = sync.deletes!;
    await expect(ops.runPlan({ planId: plan.id, digest: plan.digest }, initiator, signal))
      .resolves.toMatchObject({ awaitsOwner: true, state: "pending", plan: { kind: "delete", syncId: sync.id } });
    expect(dst.contents(parsePosix("/extra.txt"))).toEqual(Uint8Array.of(17));
  } finally { await runner.shutdown(); }
});
