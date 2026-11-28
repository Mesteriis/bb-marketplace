import type { BbPluginApi, PluginKvStorage } from "@get-bb/plugin-sdk";
import { expect, test, vi } from "vitest";
import { CommanderError } from "../../core/errors.ts";
import type { AgentJobStore } from "../../core/job-store.ts";
import { JobRunner } from "../../core/job-runner.ts";
import { planDigest, type OperationPlan } from "../../core/model.ts";
import { parsePosix } from "../../core/path.ts";
import { revalidate, type PlannerDeps } from "../../core/planner.ts";
import type { FileProvider } from "../../core/provider.ts";
import type { ScanRunner } from "../../core/scan-job.ts";
import { FakeProvider } from "../../core/testing/fake-provider.ts";
import { MemoryJobStore } from "../../core/testing/memory-job-store.ts";
import { createAgentGrants } from "./agent-grants.ts";
import type { Endpoints } from "./endpoints.ts";
import { registerAgentTools } from "./agent-tools.ts";
import { createOperations } from "./rpc-handlers.ts";
import { createSftpProvider } from "./sftp-provider.ts";
import { RemoteHubMock } from "./testing/remote-hub-mock.ts";

const date = "2026-11-27T00:00:00.000Z";
const signal = new AbortController().signal;
const agent = { kind: "agent", threadId: "thread-a" } as const;
const refusalText = "Commander planning failed outside the metadata grant";

async function failedAgentJob(outcome: "failed" | "unknown" | "sftp-unknown" = "failed") {
  const from = new FakeProvider("host:from");
  const profileId = "5b568675-f842-4a96-83e0-78ae53d96024";
  const targetEndpoint = "sftp:" + profileId;
  const remote = new RemoteHubMock({
    onOperation(op) {
      // The exclusive create succeeds. The first data write lands, then its reply is lost.
      if (op === "write" && remote.appliedCount("write") === 1) remote.dieNext(op);
    },
  });
  const to = outcome === "sftp-unknown"
    ? createSftpProvider({
      port: remote, profileId,
      endpoint: { id: targetEndpoint, provider: "sftp", label: "test", machine: "test", hostId: null, readOnly: false, caseSensitive: true },
    })
    : new FakeProvider("host:to");
  const provider = (id: string): FileProvider => id === "host:from" ? from : to;
  from.put(parsePosix("/a"), new Uint8Array(3).fill(42), "1");
  if (to instanceof FakeProvider) {
    const error = outcome === "failed" ? new CommanderError("permission_denied", "Denied")
      : new CommanderError("outcome_unknown", "Commit reply lost");
    to.failOn.push({ op: "commit", path: parsePosix("/b"), times: 1, error });
  }
  // The fake store only needs the job queries; the approval queries are unused by the retry path.
  const store = Object.assign(new MemoryJobStore(), {
    hasOwnerApproval: () => false,
    approvalQueueSize: () => ({ thread: 0, total: 0 }),
    listUnknownPage: async () => ({ jobs: [] }),
  }) as unknown as AgentJobStore;
  let nextId = 0;
  const planner: PlannerDeps = {
    provider,
    now: () => new Date(date),
    uuid: () => "223e4567-e89b-42d3-a456-" + String(++nextId).padStart(12, "0"),
    limits: { maxItems: 10, maxDepth: 10 },
    protectedPathsFor: () => [],
  };
  const runner = new JobRunner({
    store, provider, now: planner.now, uuid: planner.uuid,
    revalidate: (plan, signal) => revalidate(plan, planner, signal),
    onEvent: () => {},
  });
  const unsigned: Omit<OperationPlan, "digest"> = {
    id: "123e4567-e89b-42d3-a456-426614174000",
    createdAt: date,
    initiator: agent,
    kind: "copy",
    sourceEndpoint: "host:from",
    targetEndpoint: to.endpoint.id,
    targetDir: { endpoint: to.endpoint.id, path: { segments: [] } },
    items: [{
      source: { endpoint: "host:from", path: parsePosix("/a") },
      target: { endpoint: to.endpoint.id, path: parsePosix("/b") },
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
  await vi.waitFor(async () => expect((await store.get(job.id))!.state).toBe(outcome === "failed" ? "failed" : "unknown"));
  const kv = new Map<string, unknown>();
  const pluginKv = {
    get: async (key: string) => kv.get(key),
    set: async (key: string, value: unknown) => { kv.set(key, value); },
  } as unknown as PluginKvStorage;
  const ops = createOperations({
    // The fixture providers are ready before retry and plan_run.
    endpoints: { prepare: async () => {} } as unknown as Endpoints,
    runner,
    store,
    planner,
    // Retry starts no scan.
    scans: {} as ScanRunner,
    grants: createAgentGrants(pluginKv),
    kv: pluginKv,
    publish: () => {},
    ready: async () => {},
    isManaged: () => false,
  });
  return { ops, kv, job, from, to, remote, targetEndpoint };
}

test("an agent without a grant on the job's endpoints gets the planning refusal and no retry plan", async () => {
  const { ops, job } = await failedAgentJob();
  await expect(ops.retry(job.id, agent, signal)).rejects.toMatchObject({ message: refusalText });
});

test("an agent with a grant on the job's endpoints gets a retry plan owned by that agent", async () => {
  const { ops, kv, job } = await failedAgentJob();
  kv.set("agent-grants", [{ threadId: "thread-a", endpoint: "*", scope: parsePosix("/"), permissions: ["read", "write"] }]);
  const { plan } = await ops.retry(job.id, agent, signal);
  expect(plan!.initiator).toEqual({ kind: "agent", threadId: "thread-a" });
  expect(plan!.items.map(({ source }) => source?.path.segments)).toEqual([[{ t: "a" }]]);
});

test("an agent from another thread is refused by ownership before any grant is read", async () => {
  const { ops, kv, job } = await failedAgentJob();
  kv.set("agent-grants", [{ threadId: "thread-b", endpoint: "*", scope: parsePosix("/"), permissions: ["read", "write"] }]);
  await expect(ops.retry(job.id, { kind: "agent", threadId: "thread-b" }, signal))
    .rejects.toMatchObject({ message: "Job belongs to another initiator" });
});

test("the commander_retry tool gives a granted agent a plan ticket and refuses an agent without a grant", async () => {
  const { ops, kv, job } = await failedAgentJob();
  const tools = new Map<string, (input: unknown, ctx: unknown) => Promise<unknown>>();
  const agents = {
    registerTool: (tool: { name: string; execute: unknown }) => {
      tools.set(tool.name, tool.execute as (input: unknown, ctx: unknown) => Promise<unknown>);
    },
  };
  registerAgentTools(agents as unknown as BbPluginApi["agents"], ops);
  const retry = tools.get("commander_retry")!;
  const ctx = { threadId: "thread-a", projectId: "project", signal };
  const body = async () => JSON.parse(((await retry({ jobId: job.id }, ctx)) as { content: { text: string }[] }).content[0].text);

  expect(await body()).toEqual({ code: "forbidden", message: "Commander refused the request" });
  kv.set("agent-grants", [{ threadId: "thread-a", endpoint: "*", scope: parsePosix("/"), permissions: ["read", "write"] }]);
  expect(await body()).toMatchObject({ status: "planned", digest: expect.any(String) });
});

test.each(["owner", "agent"] as const)("SFTP retry removes the staged write once and copies the file as %s", async (kind) => {
  const { ops, kv, job, remote, targetEndpoint } = await failedAgentJob("sftp-unknown");
  const temp = "/.commander-223e4567-e89b-42d3-a456-000000000001-0.part";
  expect(await ops.job(job.id)).toMatchObject({ state: "unknown", error: { code: "outcome_unknown" } });
  expect(remote.bytesAt(temp)).toEqual(Uint8Array.of(42, 42, 42));
  expect(remote.exists("/b")).toBe(false);

  if (kind === "agent") {
    kv.set("agent-grants", [
      { threadId: "thread-a", endpoint: "host:from", scope: parsePosix("/a"), permissions: ["read"] },
      { threadId: "thread-a", endpoint: targetEndpoint, scope: parsePosix("/"), permissions: ["write"] },
    ]);
  }
  const initiator = kind === "agent" ? agent : { kind: "owner" } as const;
  const { plan } = await ops.retry(job.id, initiator, signal);
  expect(plan?.items).toHaveLength(1);
  expect(remote.exists(temp)).toBe(false);

  const run = await ops.runPlan({ planId: plan!.id, digest: plan!.digest }, initiator, signal);
  await vi.waitFor(async () => expect((await ops.job(run.id))?.state).toBe("completed"));
  expect(remote.opCount("op:remove")).toBe(1);
  expect(remote.bytesAt("/b")).toEqual(Uint8Array.of(42, 42, 42));
});

test("SFTP retry preserves the staged write without a directory grant", async () => {
  const { ops, kv, job, remote, targetEndpoint } = await failedAgentJob("sftp-unknown");
  kv.set("agent-grants", [
    { threadId: "thread-a", endpoint: "host:from", scope: parsePosix("/a"), permissions: ["read"] },
    { threadId: "thread-a", endpoint: targetEndpoint, scope: parsePosix("/b"), permissions: ["write"] },
  ]);
  await expect(ops.retry(job.id, agent, signal)).rejects.toMatchObject({ message: refusalText });
  expect(remote.opCount("op:remove")).toBe(0);
  expect(remote.bytesAt("/.commander-223e4567-e89b-42d3-a456-000000000001-0.part")).toEqual(Uint8Array.of(42, 42, 42));
});

test("an agent retry that would reconcile an unknown item needs write on the target directory", async () => {
  const { ops, kv, job, from, to } = await failedAgentJob("unknown");
  // Read on the source and write on the target file only: the directory beside the target is not covered.
  kv.set("agent-grants", [
    { threadId: "thread-a", endpoint: "host:from", scope: parsePosix("/a"), permissions: ["read"] },
    { threadId: "thread-a", endpoint: "host:to", scope: parsePosix("/b"), permissions: ["write"] },
  ]);
  await expect(ops.retry(job.id, agent, signal)).rejects.toMatchObject({ message: refusalText });
  expect(to).toBeInstanceOf(FakeProvider);
  expect((to as FakeProvider).calls.filter(({ op }) => op === "remove")).toHaveLength(0);
  expect(from.calls.filter(({ op }) => op === "remove")).toHaveLength(0);

  kv.set("agent-grants", [
    { threadId: "thread-a", endpoint: "host:from", scope: parsePosix("/a"), permissions: ["read"] },
    { threadId: "thread-a", endpoint: "host:to", scope: parsePosix("/"), permissions: ["write"] },
  ]);
  const { plan } = await ops.retry(job.id, agent, signal);
  expect(plan?.items).toHaveLength(1);
});
