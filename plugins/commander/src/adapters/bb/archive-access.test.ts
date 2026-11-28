import type { PluginKvStorage } from "@get-bb/plugin-sdk";
import { expect, test, vi } from "vitest";
import type { AgentJobStore } from "../../core/job-store.ts";
import { JobRunner } from "../../core/job-runner.ts";
import type { EndpointId, ResourceRef } from "../../core/model.ts";
import { parsePosix } from "../../core/path.ts";
import type { PlannerDeps } from "../../core/planner.ts";
import type { FileProvider } from "../../core/provider.ts";
import type { ScanRunner } from "../../core/scan-job.ts";
import { FakeProvider } from "../../core/testing/fake-provider.ts";
import { MemoryJobStore } from "../../core/testing/memory-job-store.ts";
import { createAgentGrants } from "./agent-grants.ts";
import type { ArchiveRuntime } from "./archive-runtime.ts";
import type { Endpoints } from "./endpoints.ts";
import { createOperations } from "./rpc-handlers.ts";

const signal = new AbortController().signal;
const owner = { kind: "owner" } as const;
const agent = { kind: "agent", threadId: "thread-a" } as const;
const ARCHIVE = "archive:123e4567-e89b-42d3-a456-426614174000" as EndpointId;
const planningRefusal = "Commander planning failed outside the metadata grant";
const grantRefusal = "Path is outside the agent's grant";
const SFTP = "sftp:5b568675-f842-4a96-83e0-78ae53d96024" as EndpointId;
const ref = (endpoint: EndpointId, path = "/a.zip"): ResourceRef => ({ endpoint, path: parsePosix(path) });

function rig(opts: { direct?: boolean } = {}) {
  const sftp = new FakeProvider(SFTP);
  const host = new FakeProvider("host:abc");
  sftp.put(parsePosix("/a.zip"), new Uint8Array(1234), "5");
  host.put(parsePosix("/a.zip"), new Uint8Array(77), "9");
  const archiveProvider = new FakeProvider(ARCHIVE);
  archiveProvider.put(parsePosix("/f.txt"), new Uint8Array(3), "1");
  const provider = (id: string): FileProvider => id === SFTP ? sftp : id === ARCHIVE ? archiveProvider : host;
  const open = vi.fn(async () => ({ archiveId: "123e4567-e89b-42d3-a456-426614174000", endpoint: ARCHIVE, entries: 1, encrypted: false }));
  const archives = { manager: { open, close: vi.fn() }, gate: { provide: vi.fn(), cancel: vi.fn() } } as unknown as ArchiveRuntime;
  const kv = new Map<string, unknown>();
  const pluginKv = { get: async (k: string) => kv.get(k), set: async (k: string, v: unknown) => { kv.set(k, v); } } as unknown as PluginKvStorage;
  const store = Object.assign(new MemoryJobStore(), {
    hasOwnerApproval: () => false, approvalQueueSize: () => ({ thread: 0, total: 0 }), listUnknownPage: async () => ({ jobs: [] }),
  }) as unknown as AgentJobStore;
  let n = 0;
  const planner: PlannerDeps = {
    provider, now: () => new Date("2026-11-27T00:00:00.000Z"), uuid: () => "223e4567-e89b-42d3-a456-" + String(++n).padStart(12, "0"),
    limits: { maxItems: 1000, maxDepth: 16 }, protectedPathsFor: () => [],
  };
  const runner = new JobRunner({ store, provider, now: planner.now, uuid: planner.uuid, onEvent: () => {} });
  const ops = createOperations({
    endpoints: { prepare: async () => {}, provider } as unknown as Endpoints,
    runner, store, planner, scans: {} as ScanRunner, grants: createAgentGrants(pluginKv), kv: pluginKv,
    publish: () => {}, ready: async () => {}, isManaged: () => false, archives,
    isDirectEndpoint: async (id: string) => opts.direct === true && id === "host:abc",
  });
  return { ops, open, sftp, host, kv, archives };
}

// --- the agent never reaches an archive in this stage ---

test("an agent, even with a grant on every endpoint, is refused on archive: with the usual refusal text", async () => {
  const { ops, kv } = rig();
  kv.set("agent-grants", [{ threadId: "thread-a", endpoint: "*", scope: parsePosix("/"), permissions: ["observe", "read", "write", "delete"] }]);
  const at = ref(ARCHIVE, "/f.txt");
  await expect(ops.list({ ref: ref(ARCHIVE, "/"), cursor: null, limit: 10 }, agent, signal)).rejects.toMatchObject({ message: grantRefusal });
  await expect(ops.stat(at, agent, signal)).rejects.toMatchObject({ message: grantRefusal });
  await expect(ops.read({ ref: at, offset: "0", length: 10, mode: "auto" } as never, agent, signal)).rejects.toMatchObject({ message: grantRefusal });
  await expect(ops.createPlan({
    kind: "copy", sources: [at], targetDir: ref("host:abc" as EndpointId, "/"), newName: null, conflictPolicy: "ask", verify: "size",
  } as never, agent, signal)).rejects.toMatchObject({ message: planningRefusal });
});

test("the owner is not restricted and an agent still reaches ordinary endpoints with the same grant", async () => {
  const { ops, kv } = rig();
  kv.set("agent-grants", [{ threadId: "thread-a", endpoint: "*", scope: parsePosix("/"), permissions: ["observe", "read"] }]);
  await expect(ops.stat(ref(ARCHIVE, "/f.txt"), owner, signal)).resolves.toBeTruthy();
  await expect(ops.stat(ref("host:abc" as EndpointId, "/a.zip"), agent, signal)).resolves.toBeTruthy();
});

// --- the private copy of a remote archive needs a confirmed, one-time estimate ---

test("a remote archive is refused without a confirmed estimate and nothing is read", async () => {
  const { ops, open, sftp } = rig();
  await expect(ops.archiveOpen({ source: ref(SFTP) }, owner, signal)).rejects.toMatchObject({ message: "A remote archive requires a confirmed estimate" });
  expect(open).not.toHaveBeenCalled();
  expect(sftp.calls.filter((c) => c.op === "read")).toHaveLength(0);
});

test("the estimate reports the bytes the copy will read and reads nothing itself", async () => {
  const { ops, open, sftp } = rig();
  const estimate = await ops.archiveOpen({ source: ref(SFTP), estimateOnly: true }, owner, signal);
  expect(estimate).toEqual({ estimateId: expect.stringMatching(/^[0-9a-f-]{36}$/), bytesPlanned: "1234" });
  expect(open).not.toHaveBeenCalled();
  expect(sftp.calls.filter((c) => c.op === "read")).toHaveLength(0);
});

test("a confirmed estimate opens the archive once; the same id cannot be used again", async () => {
  const { ops, open } = rig();
  const { estimateId } = await ops.archiveOpen({ source: ref(SFTP), estimateOnly: true }, owner, signal) as { estimateId: string };
  await expect(ops.archiveOpen({ source: ref(SFTP), estimateId }, owner, signal)).resolves.toMatchObject({ endpoint: ARCHIVE });
  expect(open).toHaveBeenCalledTimes(1);
  await expect(ops.archiveOpen({ source: ref(SFTP), estimateId }, owner, signal)).rejects.toMatchObject({ message: "Archive estimate is missing or expired" });
  expect(open).toHaveBeenCalledTimes(1);
});

test("an estimate is bound to the owner, the ref and the version of the file", async () => {
  const { ops, open, sftp } = rig();
  const { estimateId } = await ops.archiveOpen({ source: ref(SFTP), estimateOnly: true }, owner, signal) as { estimateId: string };
  await expect(ops.archiveOpen({ source: ref(SFTP, "/other.zip"), estimateId }, owner, signal)).rejects.toBeDefined();
  await expect(ops.archiveOpen({ source: ref(SFTP), estimateId }, agent, signal)).rejects.toBeDefined();
  expect(open).not.toHaveBeenCalled();
  const again = await ops.archiveOpen({ source: ref(SFTP), estimateOnly: true }, owner, signal) as { estimateId: string };
  sftp.put(parsePosix("/a.zip"), new Uint8Array(1235), "6");
  await expect(ops.archiveOpen({ source: ref(SFTP), estimateId: again.estimateId }, owner, signal))
    .rejects.toMatchObject({ message: "Archive changed; estimate again" });
  expect(open).not.toHaveBeenCalled();
  expect(sftp.calls.filter((c) => c.op === "read")).toHaveLength(0);
});

test("an expired estimate is refused", async () => {
  vi.useFakeTimers();
  try {
    const { ops, open } = rig();
    const { estimateId } = await ops.archiveOpen({ source: ref(SFTP), estimateOnly: true }, owner, signal) as { estimateId: string };
    vi.advanceTimersByTime(600_001);
    await expect(ops.archiveOpen({ source: ref(SFTP), estimateId }, owner, signal)).rejects.toMatchObject({ message: "Archive estimate is missing or expired" });
    expect(open).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

test("a host of another machine needs the estimate; the server's own host does not", async () => {
  const other = rig();
  await expect(other.ops.archiveOpen({ source: ref("host:abc" as EndpointId) }, owner, signal))
    .rejects.toMatchObject({ message: "A remote archive requires a confirmed estimate" });
  const own = rig({ direct: true });
  await expect(own.ops.archiveOpen({ source: ref("host:abc" as EndpointId) }, owner, signal)).resolves.toMatchObject({ endpoint: ARCHIVE });
  expect(own.open).toHaveBeenCalledTimes(1);
});

test("the estimate pool is bounded", async () => {
  const { ops } = rig();
  for (let i = 0; i < 32; i++) await ops.archiveOpen({ source: ref(SFTP), estimateOnly: true }, owner, signal);
  await expect(ops.archiveOpen({ source: ref(SFTP), estimateOnly: true }, owner, signal)).rejects.toMatchObject({ message: "Archive estimate pool is full" });
});

test("a missing archive file or a directory is refused before any estimate", async () => {
  const { ops } = rig();
  await expect(ops.archiveOpen({ source: ref(SFTP, "/missing.zip"), estimateOnly: true }, owner, signal)).rejects.toMatchObject({ code: "not_found" });
});
