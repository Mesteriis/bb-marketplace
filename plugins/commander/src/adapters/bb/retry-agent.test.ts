import type { PluginKvStorage } from "@get-bb/plugin-sdk";
import { expect, test, vi } from "vitest";
import { CommanderError } from "../../core/errors.ts";
import type { AgentJobStore } from "../../core/job-store.ts";
import { JobRunner } from "../../core/job-runner.ts";
import { planDigest, type OperationPlan } from "../../core/model.ts";
import { parsePosix } from "../../core/path.ts";
import type { PlannerDeps } from "../../core/planner.ts";
import { FakeProvider } from "../../core/testing/fake-provider.ts";
import { MemoryJobStore } from "../../core/testing/memory-job-store.ts";
import { createAgentGrants } from "./agent-grants.ts";
import type { Endpoints } from "./endpoints.ts";
import { createOperations } from "./rpc-handlers.ts";

const date = "2026-11-27T00:00:00.000Z";
const signal = new AbortController().signal;
const agent = { kind: "agent", threadId: "thread-a" } as const;
const refusalText = "Commander planning failed outside the metadata grant";

async function failedAgentJob() {
  const from = new FakeProvider("host:from");
  const to = new FakeProvider("host:to");
  from.put(parsePosix("/a"), new Uint8Array(3).fill(42), "1");
  to.failOn.push({ op: "commit", path: parsePosix("/b"), times: 1, error: new CommanderError("permission_denied", "Denied") });
  // The fake store only needs the job queries; the approval queries are unused by the retry path.
  const store = Object.assign(new MemoryJobStore(), {
    hasOwnerApproval: () => false,
    approvalQueueSize: () => ({ thread: 0, total: 0 }),
    listUnknownPage: async () => ({ jobs: [] }),
  }) as unknown as AgentJobStore;
  let nextId = 0;
  const runner = new JobRunner({
    store,
    provider: (id) => id === "host:from" ? from : to,
    now: () => new Date(date),
    uuid: () => "223e4567-e89b-42d3-a456-" + String(++nextId).padStart(12, "0"),
    onEvent: () => {},
  });
  const unsigned: Omit<OperationPlan, "digest"> = {
    id: "123e4567-e89b-42d3-a456-426614174000",
    createdAt: date,
    initiator: agent,
    kind: "copy",
    sourceEndpoint: "host:from",
    targetEndpoint: "host:to",
    targetDir: { endpoint: "host:to", path: { segments: [] } },
    items: [{
      source: { endpoint: "host:from", path: parsePosix("/a") },
      target: { endpoint: "host:to", path: parsePosix("/b") },
      kind: "file",
      fingerprint: { size: "3", mtimeNs: "1" },
      expectTarget: "absent",
    }],
    route: "relay-server",
    conflictPolicy: "ask",
    verify: "size",
    totalBytes: "3",
  };
  const job = await runner.submit({ ...unsigned, digest: await planDigest(unsigned) });
  await vi.waitFor(async () => expect((await store.get(job.id))!.state).toBe("failed"));
  const kv = new Map<string, unknown>();
  const pluginKv = {
    get: async (key: string) => kv.get(key),
    set: async (key: string, value: unknown) => { kv.set(key, value); },
  } as unknown as PluginKvStorage;
  const ops = createOperations({
    // Retry reads no endpoint or planner state; the plan runs later through plan_run.
    endpoints: {} as Endpoints,
    runner,
    store,
    planner: {} as PlannerDeps,
    grants: createAgentGrants(pluginKv),
    kv: pluginKv,
    publish: () => {},
    ready: async () => {},
    isManaged: () => false,
  });
  return { ops, kv, job };
}

test("an agent without a grant on the job's endpoints gets the planning refusal and no retry plan", async () => {
  const { ops, job } = await failedAgentJob();
  await expect(ops.retry(job.id, agent, signal)).rejects.toMatchObject({ message: refusalText });
});

test("an agent with a grant on the job's endpoints gets a retry plan owned by that agent", async () => {
  const { ops, kv, job } = await failedAgentJob();
  kv.set("agent-grants", [{ threadId: "thread-a", endpoint: "*", scope: parsePosix("/"), permissions: ["read", "write"] }]);
  const { plan } = await ops.retry(job.id, agent, signal);
  expect(plan.initiator).toEqual({ kind: "agent", threadId: "thread-a" });
  expect(plan.items.map(({ source }) => source?.path.segments)).toEqual([[{ t: "a" }]]);
});

test("an agent from another thread is refused by ownership before any grant is read", async () => {
  const { ops, kv, job } = await failedAgentJob();
  kv.set("agent-grants", [{ threadId: "thread-b", endpoint: "*", scope: parsePosix("/"), permissions: ["read", "write"] }]);
  await expect(ops.retry(job.id, { kind: "agent", threadId: "thread-b" }, signal))
    .rejects.toMatchObject({ message: "Job belongs to another initiator" });
});
