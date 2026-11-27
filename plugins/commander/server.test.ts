import { expect, test, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { MIGRATIONS } from "./src/adapters/bb/migrations.ts";
import { experimental_PluginRpcCallError, type BbPluginApi, type PluginAgentToolContext, type PluginCliRegistration } from "@get-bb/plugin-sdk";
import Database from "better-sqlite3";
import { z } from "zod";
import activate from "./server.ts";
import { parsePosix, samePath } from "./src/core/path.ts";
import { FakeProvider } from "./src/core/testing/fake-provider.ts";
import * as sqliteStore from "./src/adapters/bb/job-store-sqlite.ts";
import { OperationJob, type EntryKind, type Fingerprint } from "./src/core/model.ts";
import { RemoteHubMock } from "./src/adapters/bb/testing/remote-hub-mock.ts";
import { SFTP_REFUSALS, SftpRefusal, type SftpMethodName } from "./src/core/wire/remote-hub-sftp.ts";


const client = { experimental_caller: { kind: "client" }, experimental_signal: new AbortController().signal };
const agent: PluginAgentToolContext = { threadId: "thread-a", projectId: "project", signal: new AbortController().signal };
const ref = (path: string) => ({ endpoint: "host:test", path: parsePosix(path) });
const request = {
  kind: "copy", sources: [ref("/data/a")], targetDir: ref("/out"), newName: null,
  conflictPolicy: "ask", verify: "size",
};
const ticket = z.object({ id: z.uuid(), digest: z.string() });
const submission = z.object({ jobId: z.uuid(), status: z.string() });

async function backend(
  previous?: { db: Database.Database; disk: FakeProvider; kv: Map<string, unknown> },
  callRpc: (args: { method: SftpMethodName; input: never; signal: AbortSignal }) => Promise<unknown> = async () => {
    throw new Error("unavailable");
  },
) {
  const db = previous?.db ?? new Database(":memory:");
  const disk = previous?.disk ?? new FakeProvider("host:test");
  if (!previous) {
    disk.enableCopyWithin();
    await disk.mkdir(parsePosix("/out"), agent.signal);
    await disk.mkdir(parsePosix("/data"), agent.signal);
    await disk.mkdir(parsePosix("/data/out"), agent.signal);
    disk.put(parsePosix("/data/a"), Uint8Array.of(42), "1");
    disk.put(parsePosix("/etc/secret"), Uint8Array.of(12), "1");
  }
  let handlers: Record<string, (input: unknown, ctx: unknown) => Promise<unknown>> = {};
  let registration: PluginCliRegistration | undefined;
  const tools = new Map<string, (input: unknown, ctx: PluginAgentToolContext) => Promise<{ content: { text: string }[] }>>();
  const kv = previous?.kv ?? new Map<string, unknown>();
  const shutdown: (() => Promise<void>)[] = [];
  const events = vi.fn();
  const serviceSignal = new AbortController();
  let service: Promise<void> | undefined;
  let start: ((signal: AbortSignal) => Promise<void>) | undefined;
  const logError = vi.fn();
  function startService() {
    service = start!(serviceSignal.signal);
    void service.catch(() => {});
  }
  activate({
    sdk: {
      hosts: { list: async () => [{ id: "test", name: "Test host" }] },
      plugins: { callRpc },
    },
    hosts: { experimental_client: () => ({ call: async (method: string, data: { path: ReturnType<typeof parsePosix> } & Parameters<NonNullable<FakeProvider["copyWithin"]>>[2] & { from: ReturnType<typeof parsePosix>; to: ReturnType<typeof parsePosix>; cursor: string | null; limit: number; kind: EntryKind; expect?: Fingerprint }, ctx: { signal?: AbortSignal }) => {
      if (method === "home") return { path: parsePosix("/home/test"), caseSensitive: true };
      if (method === "stat") return disk.stat(data.path, ctx.signal ?? agent.signal);
      if (method === "list") return disk.list(data.path, data, ctx.signal ?? agent.signal);
      if (method === "copyWithin") return disk.copyWithin!(data.from, data.to, data, ctx.signal ?? agent.signal);
      if (method === "sha256") return { hex: await disk.sha256!(data.path, ctx.signal ?? agent.signal) };
      if (method === "remove") {
        await disk.remove(data.path, data, ctx.signal ?? agent.signal);
        return {};
      }
      throw new Error("unexpected test method");
    } }) },
    storage: {
      database: () => db,
      migrate: (_db: Database.Database, statements: string[]) => previous ? undefined : statements.forEach((sql) => db.exec(sql)),
      kv: { get: async (key: string) => kv.get(key), set: async (key: string, value: unknown) => { kv.set(key, value); } },
    },
    rpc: { register: (_contract: unknown, methods: typeof handlers) => { handlers = methods; } },
    realtime: { publish: events },
    log: { error: logError },
    background: { service: (_name: string, task: { start(signal: AbortSignal): Promise<void> }) => { start = task.start; startService(); } },
    onDispose: (hook: () => Promise<void>) => shutdown.push(hook),
    agents: { registerTool: (tool: { name: string; execute: typeof tools extends Map<string, infer V> ? V : never }) => tools.set(tool.name, tool.execute) },
    cli: { register: (cli: PluginCliRegistration) => { registration = cli; } },
  } as unknown as BbPluginApi);
  await new Promise<void>((resolve) => setImmediate(resolve));
  return {
    db, disk, events, kv, logError, startService,
    serviceResult: () => service,
    rpc: (name: string, input: unknown, ctx: unknown = client) => handlers[name](input, ctx),
    async tool(name: string, input: unknown, ctx = agent): Promise<unknown> {
      return JSON.parse((await tools.get(name)!(input, ctx)).content[0].text);
    },
    cli: (argv: string[]) => registration!.run(argv, {} as Parameters<PluginCliRegistration["run"]>[1]),
    async dispose(close = true) {
      serviceSignal.abort();
      for (const hook of shutdown) await hook();
      await service?.catch(() => {});
      if (close) db.close();
    },
  };
}

test("registers endpoints, validates digests and refuses another plugin", async () => {
  const bb = await backend();
  try {
    await expect(bb.rpc("endpoints_list", {})).resolves.toMatchObject({
      endpoints: [{ id: "host:test", machine: "Test host", provider: "local" }],
    });
    await expect(bb.rpc("endpoints_list", {}, { ...client, experimental_caller: { kind: "plugin", pluginId: "other" } }))
      .rejects.toMatchObject({ code: "forbidden" });
    const plan = ticket.parse(await bb.rpc("plan_create", request));
    await expect(bb.rpc("plan_run", { planId: plan.id, digest: "0".repeat(64) })).rejects.toMatchObject({ code: "conflict" });
  } finally { await bb.dispose(); }
});

test("stages an agent plan without grants, prevents cross-thread cancel and rejects without writes", async () => {
  const bb = await backend();
  try {
    const plan = ticket.parse(await bb.tool("commander_plan", request));
    const run = submission.parse(await bb.tool("commander_run", { planId: plan.id, digest: plan.digest }));
    expect(run.status).toBe("awaiting_owner");
    await expect(bb.rpc("job_list", {})).resolves.toMatchObject({ jobs: [{ state: "pending", awaitsOwner: true }] });
    expect(bb.disk.contents(parsePosix("/out/a"))).toBeNull();
    await expect(bb.tool("commander_cancel", { jobId: run.jobId }, { ...agent, threadId: "thread-b" }))
      .resolves.toMatchObject({ code: "forbidden" });
    await expect(bb.rpc("plan_reject", { jobId: run.jobId, digest: plan.digest }))
      .resolves.toMatchObject({ state: "cancelled", error: { message: "rejected_by_owner" } });
    expect(bb.disk.contents(parsePosix("/out/a"))).toBeNull();
  } finally { await bb.dispose(); }
});

test("job_get returns an existing job only to an owner client and null for a missing job", async () => {
  const bb = await backend();
  try {
    const { id, digest } = ticket.parse(await bb.tool("commander_plan", request));
    const { jobId } = submission.parse(await bb.tool("commander_run", { planId: id, digest }));
    const job = OperationJob.parse(await bb.rpc("job_get", { jobId }));
    expect(job).toMatchObject({
      id: jobId, state: "pending", awaitsOwner: true,
      plan: { kind: "copy", initiator: { kind: "agent", threadId: "thread-a" } },
    });
    await expect(bb.rpc("job_get", { jobId }, { ...client, experimental_caller: { kind: "plugin", pluginId: "other" } }))
      .rejects.toMatchObject({ code: "forbidden" });
    await expect(bb.rpc("job_get", { jobId: "not-a-uuid" })).rejects.toMatchObject({ code: "invalid" });
    await expect(bb.rpc("job_get", { jobId: "ab2e770c-44da-47b2-a117-7a41a17057cd" })).resolves.toBeNull();
  } finally { await bb.dispose(); }
});

test("hides damaged plans in RPC, agent tools and CLI and refuses mutation", async () => {
  const bb = await backend();
  try {
    const { id, digest } = ticket.parse(await bb.tool("commander_plan", request));
    const { jobId } = submission.parse(await bb.tool("commander_run", { planId: id, digest }));
    bb.db.prepare("UPDATE jobs SET plan_json = ?, created_at = ? WHERE id = ?").run("{", "2026-11-27T10:00:00.000Z", jobId);
    const expected = { jobs: [{ id: jobId, state: "unknown", damaged: true, message: "Stored job is damaged", createdAt: "2026-11-27T10:00:00.000Z" }] };
    expect(await bb.rpc("job_list", {})).toEqual(expected);
    expect(await bb.rpc("job_get", { jobId })).toEqual({
      id: jobId, state: "unknown", damaged: true, message: "Stored job is damaged", createdAt: "2026-11-27T10:00:00.000Z",
    });
    expect(await bb.tool("commander_jobs", {})).toEqual(expected);
    const cli = await bb.cli(["jobs"]);
    expect(cli.exitCode).toBe(0);
    expect(JSON.parse(cli.stdout!)).toEqual(expected);
    await expect(bb.rpc("job_cancel", { jobId })).rejects.toMatchObject({ code: "invalid" });
    await expect(bb.rpc("job_decide", { jobId, conflictId: jobId, action: "skip", applyTo: "this" }))
      .rejects.toMatchObject({ code: "invalid" });
    await expect(bb.rpc("plan_approve", { jobId, digest })).rejects.toMatchObject({ code: "invalid" });
    await expect(bb.rpc("plan_reject", { jobId, digest })).rejects.toMatchObject({ code: "invalid" });
  } finally { await bb.dispose(); }
});

test("limits agent metadata to grants and runs an authorized immutable plan", async () => {
  const bb = await backend();
  try {
    await bb.rpc("agent_grants_set", { grant: {
      threadId: "thread-a", endpoint: "host:test", scope: parsePosix("/data"), permissions: ["read", "write"],
    } });
    await expect(bb.tool("commander_stat", { ref: ref("/etc/secret") })).resolves.toMatchObject({ code: "forbidden" });
    const input = { ...request, sources: [ref("/data/a")], targetDir: ref("/data/out") };
    const { id, digest } = ticket.parse(await bb.tool("commander_plan", input));
    input.sources[0] = ref("/etc/secret");
    const run = submission.parse(await bb.tool("commander_run", { planId: id, digest }));
    expect(run.status).toBe("submitted");
    await vi.waitFor(() => expect(bb.disk.contents(parsePosix("/data/out/a"))).toEqual(Uint8Array.of(42)));
    expect(bb.disk.contents(parsePosix("/data/out/secret"))).toBeNull();
  } finally { await bb.dispose(); }
});

test("checks a pending plan without starting it and reports changed fingerprints", async () => {
  const bb = await backend();
  try {
    const { id, digest } = ticket.parse(await bb.tool("commander_plan", request));
    const { jobId } = submission.parse(await bb.tool("commander_run", { planId: id, digest }));
    const checkedAt = expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    await expect(Promise.resolve().then(() => bb.rpc("plan_check", { jobId, digest })))
      .resolves.toEqual({ ok: true, checkedAt });
    bb.disk.put(parsePosix("/data/a"), Uint8Array.of(4, 5), "2");
    await expect(bb.rpc("plan_check", { jobId, digest }))
      .resolves.toEqual({ ok: false, changed: [{ index: 0, reason: "source_changed" }], checkedAt });
    await expect(bb.rpc("job_list", {})).resolves.toMatchObject({ jobs: [{ id: jobId, state: "pending", awaitsOwner: true }] });
    expect(bb.disk.contents(parsePosix("/out/a"))).toBeNull();
  } finally { await bb.dispose(); }
});

test("refuses a plan check with the wrong digest, a plugin caller or a settled job", async () => {
  const bb = await backend();
  try {
    const { id, digest } = ticket.parse(await bb.tool("commander_plan", request));
    const { jobId } = submission.parse(await bb.tool("commander_run", { planId: id, digest }));
    await expect(Promise.resolve().then(() => bb.rpc("plan_check", { jobId, digest: "0".repeat(64) })))
      .rejects.toMatchObject({ code: "conflict" });
    await expect(bb.rpc("plan_check", { jobId, digest }, { ...client, experimental_caller: { kind: "plugin", pluginId: "other" } }))
      .rejects.toMatchObject({ code: "forbidden" });
    await bb.rpc("plan_reject", { jobId, digest });
    await expect(bb.rpc("plan_check", { jobId, digest })).rejects.toMatchObject({ code: "conflict" });
  } finally { await bb.dispose(); }
});

test("runs a staged job after owner approval and rejects changed snapshots", async () => {
  const bb = await backend();
  try {
    const { id, digest } = ticket.parse(await bb.tool("commander_plan", request));
    const { jobId } = submission.parse(await bb.tool("commander_run", { planId: id, digest }));
    await expect(bb.rpc("plan_approve", { jobId, digest: "0".repeat(64) })).rejects.toMatchObject({ code: "conflict" });
    await bb.rpc("plan_approve", { jobId, digest });
    await vi.waitFor(() => expect(bb.disk.contents(parsePosix("/out/a"))).toEqual(Uint8Array.of(42)));
    const second = ticket.parse(await bb.tool("commander_plan", request));
    const staged = submission.parse(await bb.tool("commander_run", { planId: second.id, digest: second.digest }));
    bb.disk.put(parsePosix("/data/a"), Uint8Array.of(4, 5), "2");
    await expect(bb.rpc("plan_approve", { jobId: staged.jobId, digest: second.digest })).rejects.toMatchObject({ code: "conflict" });
  } finally { await bb.dispose(); }
});

test("recovers a running job on activation with the same database", async () => {
  const bb = await backend();
  let restarted: typeof bb | undefined;
  let firstDisposed = false;
  try {
    const { promise, resolve } = Promise.withResolvers<void>();
    bb.disk.delay = async (op, _path, signal) => {
      if (op !== "copyWithin") return;
      const halted = new Promise<void>((done) => signal.addEventListener("abort", () => done(), { once: true }));
      resolve();
      await halted;
      signal.throwIfAborted();
    };
    const plan = ticket.parse(await bb.rpc("plan_create", request));
    await bb.rpc("plan_run", { planId: plan.id, digest: plan.digest });
    await promise;
    await bb.dispose(false);
    firstDisposed = true;
    await expect(bb.rpc("job_list", {})).resolves.toMatchObject({ jobs: [{ state: "running" }] });
    bb.disk.delay = undefined;
    const states: string[] = [];
    const observe = bb.db.function("test_record_state", (state: string) => { states.push(state); return null; });
    observe.exec("CREATE TRIGGER test_job_state AFTER UPDATE ON jobs BEGIN SELECT test_record_state(new.state); END");
    restarted = await backend(bb);
    await vi.waitFor(async () => expect(await restarted!.rpc("job_list", {}))
      .toMatchObject({ jobs: [{ state: "completed" }] }));
    expect(states).toContain("interrupted");
    expect(bb.disk.contents(parsePosix("/out/a"))).toEqual(Uint8Array.of(42));
    await vi.waitFor(() => expect(restarted!.events).toHaveBeenCalledWith("commander", { kind: "dir", id: "host:test" }));
    expect(restarted.events.mock.calls.every(([channel, payload]) =>
      channel === "commander" && Object.keys(payload).sort().join(",") === "id,kind")).toBe(true);
  } finally {
    if (restarted) await restarted.dispose();
    else if (firstDisposed) bb.db.close();
    else await bb.dispose();
  }
});

const dataGrant = { threadId: "thread-a", endpoint: "host:test", scope: parsePosix("/data") };
const dataCopy = { ...request, targetDir: ref("/data/out") };

async function submitAgent(bb: Awaited<ReturnType<typeof backend>>, input: unknown) {
  const { id, digest } = ticket.parse(await bb.tool("commander_plan", input));
  return submission.parse(await bb.tool("commander_run", { planId: id, digest }));
}

test.each(["overwrite", "overwriteIfNewer"])("stages %s without delete rights on the destination", async (conflictPolicy) => {
  const bb = await backend();
  try {
    bb.disk.put(parsePosix("/data/out/a"), Uint8Array.of(99), "0");
    await bb.rpc("agent_grants_set", { grant: { ...dataGrant, permissions: ["read", "write"] } });
    const result = await submitAgent(bb, { ...dataCopy, conflictPolicy });
    expect(result.status).toBe("awaiting_owner");
    await expect(bb.rpc("job_list", {})).resolves.toMatchObject({ jobs: [{ state: "pending", awaitsOwner: true }] });
    expect(bb.disk.contents(parsePosix("/data/out/a"))).toEqual(Uint8Array.of(99));
  } finally { await bb.dispose(); }
});

test.each(["revoke", "set"] as const)("%s cancels an active automatic copy, preserves the completed item and hides progress", async (operation) => {
  const bb = await backend();
  try {
    const wildcard = { ...dataGrant, threadId: "*" };
    await bb.rpc("agent_grants_set", { grant: { ...wildcard, permissions: ["read", "write"] } });
    bb.disk.put(parsePosix("/data/b"), Uint8Array.of(1, 2, 3), "1");
    const staged = await submitAgent(bb, { ...request, sources: [ref("/etc/secret")] });
    expect(staged.status).toBe("awaiting_owner");

    const plan = ticket.parse(await bb.tool("commander_plan", { ...dataCopy, sources: [ref("/data/a"), ref("/data/b")] }));
    const writing = Promise.withResolvers<void>();
    bb.disk.delay = async (op, path, signal) => {
      if (op !== "stat" || !samePath(path, parsePosix("/data/out/b"), true)) return;
      const aborted = new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      writing.resolve();
      await aborted;
      signal.throwIfAborted();
    };
    const live = submission.parse(await bb.tool("commander_run", { planId: plan.id, digest: plan.digest }));
    expect(live.status).toBe("submitted");
    await writing.promise;
    expect(await bb.tool("commander_jobs", {})).toMatchObject({
      jobs: expect.arrayContaining([{ id: live.jobId, state: "running", awaitsOwner: false,
        initiator: { kind: "agent", threadId: "thread-a" },
        progress: { itemsDone: 1, itemsTotal: 2, bytesDone: "1", bytesTotal: "4" } }]),
    });
    const states: string[] = [];
    bb.db.function("capture_grant_state", (value: string) => { states.push(value); return null; });
    bb.db.exec("CREATE TRIGGER observe_grant_state AFTER UPDATE OF state ON jobs BEGIN SELECT capture_grant_state(new.state); END");
    const args = operation === "revoke" ? wildcard : { grant: { ...wildcard, permissions: ["write"] } };
    await bb.rpc("agent_grants_" + operation, args);
    expect(states).toContain("cancel_requested");
    expect(await bb.tool("commander_jobs", {})).toEqual({ jobs: expect.arrayContaining([
      { id: live.jobId, state: "cancelled", awaitsOwner: false },
      { id: staged.jobId, state: "pending", awaitsOwner: true },
    ]) });
    expect(bb.disk.contents(parsePosix("/data/out/a"))).toEqual(Uint8Array.of(42));
    expect(bb.disk.contents(parsePosix("/data/out/b"))).toBeNull();
  } finally { await bb.dispose(); }
});

test("hides counts without a grant from plan, run and job outputs", async () => {
  const bb = await backend();
  try {
    bb.disk.put(parsePosix("/data/a"), new Uint8Array(16381), "1");
    const plan = ticket.parse(await bb.tool("commander_plan", request));
    expect(await bb.tool("commander_plan", request)).toEqual({
      id: expect.any(String), digest: expect.any(String), status: "planned",
    });
    const run = await bb.tool("commander_run", { planId: plan.id, digest: plan.digest });
    const { jobId } = submission.parse(run);
    expect(run).toEqual({ jobId, status: "awaiting_owner" });
    expect(await bb.tool("commander_jobs", {})).toEqual({ jobs: [{ id: jobId, state: "pending", awaitsOwner: true }] });
  } finally { await bb.dispose(); }
});

test("a limited agent page decodes only matching jobs up to the limit, including damaged rows", async () => {
  const bb = await backend();
  try {
    const owned = await submitAgent(bb, request);
    for (let i = 0; i < 5; i++) {
      const thread = { ...agent, threadId: i === 0 ? "thread-a" : "thread-b" };
      const { id, digest } = ticket.parse(await bb.tool("commander_plan", request, thread));
      await bb.tool("commander_run", { planId: id, digest }, thread);
    }
    bb.db.prepare("UPDATE jobs SET plan_json = ?, created_at = ?, updated_at = ? WHERE id = ?")
      .run("{", "2026-11-27T10:00:00.000Z", "2099-01-01T00:00:00.000Z", owned.jobId);
    const parseJob = vi.spyOn(OperationJob, "parse");
    try {
      expect(await bb.tool("commander_jobs", { limit: 1 })).toEqual({ jobs: [{
        id: owned.jobId, state: "unknown", damaged: true, message: "Stored job is damaged", createdAt: "2026-11-27T10:00:00.000Z",
      }] });
      expect(parseJob).toHaveBeenCalledTimes(1);
    } finally { parseJob.mockRestore(); }
  } finally { await bb.dispose(); }
});

test("stages a source outside /data and a delete even with delete rights", async () => {
  const bb = await backend();
  try {
    await bb.rpc("agent_grants_set", { grant: { ...dataGrant, permissions: ["read", "write", "delete"] } });
    expect((await submitAgent(bb, { ...dataCopy, sources: [ref("/etc/secret")] })).status).toBe("awaiting_owner");
    expect((await submitAgent(bb, { ...dataCopy, kind: "delete", targetDir: null })).status).toBe("awaiting_owner");
    expect(bb.disk.contents(parsePosix("/data/a"))).toEqual(Uint8Array.of(42));
  } finally { await bb.dispose(); }
});

/**
 * BB 0.50.1 delivers a refusal of another plugin's RPC through `bb.sdk.plugins.callRpc` as the SDK client's
 * BbHttpError ("HTTP <status>: <message>", code = the refusal class), not as experimental_PluginRpcCallError.
 */
class BbHttpErrorLike extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(`HTTP ${status}: ${message}`);
    this.name = "BbHttpError";
  }
}
const REFUSAL_STATUS = { forbidden: 403, not_found: 404, conflict: 409, invalid: 400 } as const;

function remoteFixture(options: { hostKey?: "trusted" | "unknown" | "changed"; refusalAs?: "sdk" | "http" } = {}) {
  const profileId = "5b568675-f842-4a96-83e0-78ae53d96024";
  const endpoint = "sftp:" + profileId;
  const remote = new RemoteHubMock({ hostKey: options.hostKey ?? "trusted" });
  remote.seedDir("/data");
  remote.seedDir("/data/out");
  remote.seedFile("/data/a", "fixture");
  return {
    endpoint, remote,
    async callRpc({ method, input, signal }: { method: SftpMethodName; input: never; signal: AbortSignal }) {
      if (method === "hub_sftp_profiles") return { profiles: [{
        id: profileId, name: "Fixture", group: null, host: "fixture.invalid", port: 22, user: null, authType: "agent",
        consent: "granted", level: "write", hostKey: "trusted", needsConfig: false,
      }] };
      try {
        const output = await remote.call(method, input, signal);
        return "op" in output && output.op === "realpath" ? { op: "realpath", path: { text: "/home/test" } } : output;
      } catch (error) {
        if (error instanceof SftpRefusal) {
          const code = SFTP_REFUSALS[error.code];
          if (options.refusalAs === "http") throw new BbHttpErrorLike(REFUSAL_STATUS[code], code, error.message);
          throw new experimental_PluginRpcCallError({ code, message: error.message });
        }
        throw error;
      }
    },
  };
}

for (const refusalAs of ["sdk", "http"] as const) {
  for (const hostKey of ["unknown", "changed"] as const) {
    test(`reports a ${hostKey} SFTP host key as host_key_rejected (refusal as ${refusalAs})`, async () => {
      const fixture = remoteFixture({ hostKey, refusalAs });
      const bb = await backend(undefined, fixture.callRpc);
      try {
        await expect(bb.rpc("endpoint_home", { endpoint: fixture.endpoint }))
          .rejects.toMatchObject({
            code: "forbidden",
            message: '{"code":"host_key_rejected","message":"Remote Hub did not trust the host key","retryable":false}',
          });
      } finally { await bb.dispose(); }
    });
  }
}

test("keeps a missing consent apart from a transport failure when BB reports refusals over HTTP", async () => {
  const fixture = remoteFixture({ refusalAs: "http" });
  const bb = await backend(undefined, async (args) => {
    if (args.method === "hub_sftp_open") throw new BbHttpErrorLike(403, "forbidden", "consent_revoked: grant revoked");
    return fixture.callRpc(args);
  });
  try {
    await expect(bb.rpc("endpoint_home", { endpoint: fixture.endpoint }))
      .rejects.toMatchObject({
        code: "forbidden",
        message: '{"code":"consent_required","message":"Remote Hub did not grant access","retryable":false}',
      });
  } finally { await bb.dispose(); }
});

for (const [label, message] of [
  ["a known code without the \": \" separator", "host_key_unknown"],
  ["a known code inside diagnostic text", "ssh said host_key_unknown: while probing"],
] as const) {
  test(`treats ${label} with a matching class as a transport failure`, async () => {
    const fixture = remoteFixture({ refusalAs: "http" });
    const bb = await backend(undefined, async (args) => {
      if (args.method === "hub_sftp_open") throw new BbHttpErrorLike(403, "forbidden", message);
      return fixture.callRpc(args);
    });
    try {
      await expect(bb.rpc("endpoint_home", { endpoint: fixture.endpoint })).rejects.toMatchObject({
        code: "invalid",
        message: '{"code":"connection_failed","message":"SFTP home directory is unavailable","retryable":true}',
      });
    } finally { await bb.dispose(); }
  });
}

test("treats an HTTP failure whose class does not match the refusal as a transport failure", async () => {
  const fixture = remoteFixture({ refusalAs: "http" });
  const bb = await backend(undefined, async (args) => {
    if (args.method === "hub_sftp_open") throw new BbHttpErrorLike(400, "invalid", "host_key_unknown: wrong class");
    return fixture.callRpc(args);
  });
  try {
    await expect(bb.rpc("endpoint_home", { endpoint: fixture.endpoint })).rejects.toMatchObject({
      code: "invalid",
      message: '{"code":"connection_failed","message":"SFTP home directory is unavailable","retryable":true}',
    });
  } finally { await bb.dispose(); }
});

test("reports a host key that changes after the home loaded as host_key_rejected on a listing", async () => {
  const fixture = remoteFixture({ refusalAs: "http" });
  let changed = false;
  const bb = await backend(undefined, async (args) => {
    if (changed && args.method === "hub_sftp_op") throw new BbHttpErrorLike(404, "not_found", "channel_closed: generation changed");
    if (changed && args.method === "hub_sftp_open") throw new BbHttpErrorLike(403, "forbidden", "host_key_changed: key differs");
    return fixture.callRpc(args);
  });
  try {
    await bb.rpc("endpoint_home", { endpoint: fixture.endpoint });
    changed = true;
    await expect(bb.rpc("dir_list", { ref: { endpoint: fixture.endpoint, path: parsePosix("/data") }, cursor: null, limit: 10 }))
      .rejects.toMatchObject({
        code: "forbidden",
        message: '{"code":"host_key_rejected","message":"The server\'s host key is not trusted; decide it on the Remote Hub page","retryable":false}',
      });
  } finally { await bb.dispose(); }
});

test("coalesces the first concurrent SFTP home loads", async () => {
  const fixture = remoteFixture();
  const bb = await backend(undefined, fixture.callRpc);
  try {
    await expect(Promise.all([
      bb.rpc("endpoint_home", { endpoint: fixture.endpoint }), bb.rpc("endpoint_home", { endpoint: fixture.endpoint }),
    ])).resolves.toEqual([{ path: parsePosix("/home/test") }, { path: parsePosix("/home/test") }]);
    expect(fixture.remote.calls.filter(({ method }) => method === "hub_sftp_open")).toHaveLength(1);
  } finally { await bb.dispose(); }
});

test("stages narrow SFTP grants and deletes, and starts a copy with a root grant", async () => {
  const fixture = remoteFixture();
  const bb = await backend(undefined, fixture.callRpc);
  try {
    const grant = { ...dataGrant, endpoint: fixture.endpoint, permissions: ["read", "write", "delete"] };
    const copy = { ...request,
      sources: [{ ...ref("/data/a"), endpoint: fixture.endpoint }],
      targetDir: { ...ref("/data/out"), endpoint: fixture.endpoint },
    };
    await bb.rpc("agent_grants_set", { grant });
    expect((await submitAgent(bb, copy)).status).toBe("awaiting_owner");
    expect(fixture.remote.bytesAt("/data/out/a")).toBeUndefined();
    await bb.rpc("agent_grants_set", { grant: { ...grant, scope: parsePosix("/") } });
    expect((await submitAgent(bb, copy)).status).toBe("submitted");
    await vi.waitFor(() => expect(fixture.remote.bytesAt("/data/out/a")).toEqual(new TextEncoder().encode("fixture")));
    expect((await submitAgent(bb, { ...copy, kind: "delete", targetDir: null })).status).toBe("awaiting_owner");
    expect(fixture.remote.bytesAt("/data/a")).toEqual(new TextEncoder().encode("fixture"));
  } finally { await bb.dispose(); }
});

test("caps the plan pool per thread while keeping an owner plan", async () => {
  const bb = await backend();
  try {
    const own = ticket.parse(await bb.rpc("plan_create", request));
    const oldest = ticket.parse(await bb.tool("commander_plan", request));
    for (let i = 0; i < 32; i++) {
      ticket.parse(await bb.tool("commander_plan", request));
    }
    expect(await bb.tool("commander_run", { planId: oldest.id, digest: oldest.digest })).toMatchObject({ code: "not_found" });
    await expect(bb.rpc("plan_run", { planId: own.id, digest: own.digest })).resolves.toMatchObject({ awaitsOwner: false });
  } finally { await bb.dispose(); }
});

test("publishes a fixed recovery failure and retries on the next service start", async () => {
  const actual = sqliteStore.createSqliteJobStore;
  const create = vi.spyOn(sqliteStore, "createSqliteJobStore").mockImplementation((db) => {
    const store = actual(db);
    const list = store.list.bind(store);
    store.list = vi.fn(list).mockImplementationOnce(async () => { throw new Error("private diagnostic"); });
    return store;
  });
  const bb = await backend();
  try {
    await expect(bb.serviceResult()).rejects.toThrow("Commander recovery failed");
    expect(bb.logError).toHaveBeenCalledWith("Commander recovery failed");
    const plan = ticket.parse(await bb.rpc("plan_create", request));
    await expect(bb.rpc("plan_run", { planId: plan.id, digest: plan.digest }))
      .rejects.toMatchObject({ message: "Commander recovery failed" });
    bb.startService();
    await vi.waitFor(async () => {
      await expect(bb.rpc("plan_run", { planId: plan.id, digest: plan.digest })).resolves.toMatchObject({ awaitsOwner: false });
    });
  } finally { await bb.dispose(); create.mockRestore(); }
});

test("revoking a grant leaves an explicitly approved job running", async () => {
  const bb = await backend();
  const finish = Promise.withResolvers<void>();
  try {
    await bb.rpc("agent_grants_set", { grant: { ...dataGrant, permissions: ["read"] } });
    const plan = ticket.parse(await bb.tool("commander_plan", dataCopy));
    const live = submission.parse(await bb.tool("commander_run", { planId: plan.id, digest: plan.digest }));
    expect(live.status).toBe("awaiting_owner");
    const writing = Promise.withResolvers<void>();
    bb.disk.delay = async (op, _path, signal) => {
      if (op !== "copyWithin") return;
      const abort = () => finish.resolve();
      signal.addEventListener("abort", abort, { once: true });
      writing.resolve();
      await finish.promise;
      signal.removeEventListener("abort", abort);
      signal.throwIfAborted();
    };
    await bb.rpc("plan_approve", { jobId: live.jobId, digest: plan.digest });
    await writing.promise;
    await bb.rpc("agent_grants_revoke", dataGrant);
    expect(await bb.tool("commander_jobs", {})).toEqual({ jobs: [
      { id: live.jobId, state: "running", awaitsOwner: false },
    ] });
    finish.resolve();
    await vi.waitFor(async () => expect(await bb.tool("commander_jobs", {})).toEqual({ jobs: [
      { id: live.jobId, state: "completed", awaitsOwner: false },
    ] }));
    expect(bb.disk.contents(parsePosix("/data/out/a"))).toEqual(Uint8Array.of(42));
  } finally { finish.resolve(); await bb.dispose(); }
});

test("limits the number of expanded agent plan items for one directory", async () => {
  const bb = await backend();
  try {
    await bb.rpc("agent_grants_set", { grant: { ...dataGrant, permissions: ["observe"] } });
    const dir = parsePosix("/data");
    const entry = (number: number) => ({
      name: { t: "entry-" + number }, kind: "file" as const, size: "1", mtimeNs: "1",
      mtimePrecision: "ns" as const, mode: null, linkTarget: null, hidden: false,
    });
    const stat = bb.disk.stat.bind(bb.disk);
    vi.spyOn(bb.disk, "stat").mockImplementation((path, signal) => {
      const leaf = path.segments.at(-1);
      return leaf && "t" in leaf && leaf.t.startsWith("entry-")
        ? Promise.resolve(entry(Number(leaf.t.slice(6))))
        : stat(path, signal);
    });
    vi.spyOn(bb.disk, "list").mockImplementation(async (_path, { cursor, limit }) => {
      const start = Number(cursor ?? 0);
      const end = Math.min(start + limit, 10_000);
      return { entries: Array.from({ length: end - start }, (_, i) => entry(start + i)),
        cursor: end < 10_000 ? String(end) : null };
    });
    const remove = { ...request, kind: "delete", sources: [{ endpoint: "host:test", path: dir }], targetDir: null };
    expect(await bb.tool("commander_plan", remove)).toEqual({ code: "invalid", message: "Commander refused the request" });
    expect(await bb.rpc("plan_create", remove)).toMatchObject({ items: { length: 10_001 } });
  } finally { await bb.dispose(); }
});

test("reconciles a copy under cancellation when its grant was lost before reload", async () => {
  const bb = await backend();
  let restarted: typeof bb | undefined;
  let firstDisposed = false;
  try {
    await bb.rpc("agent_grants_set", { grant: { ...dataGrant, permissions: ["read", "write"] } });
    const plan = ticket.parse(await bb.tool("commander_plan", dataCopy));
    const observing = Promise.withResolvers<void>();
    bb.disk.delay = async (op, path, signal) => {
      if (op !== "stat" || !samePath(path, parsePosix("/data/out/a"), true)) return;
      const abort = new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      observing.resolve();
      await abort;
      signal.throwIfAborted();
    };
    const { jobId } = submission.parse(await bb.tool("commander_run", { planId: plan.id, digest: plan.digest }));
    await observing.promise;
    await bb.dispose(false);
    firstDisposed = true;
    await expect(bb.rpc("job_list", {})).resolves.toMatchObject({ jobs: [{ id: jobId, state: "running" }] });
    bb.disk.delay = undefined;
    // Simulate loss of the server after the grant write and before requesting cancellation.
    bb.kv.set("agent-grants", []);
    restarted = await backend(bb);
    await vi.waitFor(async () => expect(await restarted!.rpc("job_list", {})).toMatchObject({
      jobs: [{ id: jobId, state: "cancelled" }],
    }), { timeout: 400 });
    expect(bb.disk.contents(parsePosix("/data/out/a"))).toBeNull();
  } finally {
    if (restarted) await restarted.dispose();
    else if (firstDisposed) bb.db.close();
    else await bb.dispose();
  }
});

test("returns one fixed planning refusal for missing and non-directory destinations outside the grant", async () => {
  const bb = await backend();
  try {
    await bb.rpc("agent_grants_set", { grant: { ...dataGrant, permissions: ["read", "write"] } });
    bb.disk.put(parsePosix("/out/file"), Uint8Array.of(9), "1");
    const denied = { code: "forbidden", message: "Commander refused the request" };
    expect(await bb.tool("commander_plan", { ...request, targetDir: ref("/out/missing") })).toEqual(denied);
    expect(await bb.tool("commander_plan", { ...request, targetDir: ref("/out/file") })).toEqual(denied);
  } finally { await bb.dispose(); }
});

test.each(["job_cancel", "agent_grants_revoke"] as const)("%s manages an active job after recovery of a later job fails", async (method) => {
  const bb = await backend();
  let restarted: typeof bb | undefined;
  let firstDisposed = false;
  const actual = sqliteStore.createSqliteJobStore;
  let spy: ReturnType<typeof vi.spyOn> | undefined;
  try {
    const first = await submitAgent(bb, dataCopy);
    const second = await submitAgent(bb, { ...dataCopy, targetDir: ref("/out") });
    await bb.rpc("agent_grants_set", { grant: { ...dataGrant, scope: parsePosix("/"), permissions: ["read", "write"] } });
    // Seed interrupted automatic jobs, without performing an owner approval transition.
    bb.db.prepare("UPDATE jobs SET awaits_owner = 0 WHERE id IN (?, ?)").run(first.jobId, second.jobId);
    const update = bb.db.prepare("UPDATE jobs SET state = 'running', updated_at = ? WHERE id = ?");
    update.run("2026-11-27T02:00:00.000Z", first.jobId);
    update.run("2026-11-27T01:00:00.000Z", second.jobId);
    await bb.dispose(false);
    firstDisposed = true;
    const firstRunning = Promise.withResolvers<void>();
    bb.disk.delay = async (op, path, signal) => {
      if (op !== "stat" || !samePath(path, parsePosix("/data/out/a"), true)) return;
      const aborted = new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      firstRunning.resolve();
      await aborted;
      signal.throwIfAborted();
    };
    spy = vi.spyOn(sqliteStore, "createSqliteJobStore").mockImplementation((db) => {
      const store = actual(db);
      const original = store.update.bind(store);
      store.update = async (id, patch, state) => {
        if (id === second.jobId && patch.state === "interrupted") {
          await firstRunning.promise;
          throw new Error("private failure in second job");
        }
        return original(id, patch, state);
      };
      return store;
    });
    restarted = await backend(bb);
    await expect(restarted.serviceResult()).rejects.toThrow("Commander recovery failed");
    const args = method === "job_cancel" ? { jobId: first.jobId } : { ...dataGrant, scope: parsePosix("/") };
    await expect(restarted.rpc(method, args)).resolves.toEqual({});
    const jobs = z.object({ jobs: z.array(z.object({ id: z.string(), state: z.string() })) })
      .parse(await restarted.rpc("job_list", {})).jobs;
    expect(jobs.find(({ id }) => id === first.jobId)?.state).toBe("cancelled");
    expect(jobs.find(({ id }) => id === second.jobId)?.state).toBe(method === "job_cancel" ? "running" : "cancel_requested");
    expect(restarted.kv.get("agent-grants")).toHaveLength(method === "job_cancel" ? 1 : 0);
    expect(restarted.disk.contents(parsePosix("/data/out/a"))).toBeNull();
  } finally {
    if (restarted) await restarted.dispose();
    else if (firstDisposed) bb.db.close();
    else await bb.dispose();
    spy?.mockRestore();
  }
});

function seedApprovalRows(db: Database.Database, jobId: string, threadId: string, count: number, state = "pending") {
  const insert = db.prepare(`INSERT INTO jobs (id, plan_json, state, progress_json, current_item, pending_conflict_json,
    items_json, error_json, created_at, updated_at, initiator_kind, thread_id, awaits_owner)
    SELECT ?, json_set(plan_json, '$.initiator.threadId', ?), ?, progress_json,
      NULL, NULL, items_json, NULL, created_at, updated_at, 'agent', ?, ?
    FROM jobs WHERE id = ?`);
  for (let i = 0; i < count; i++) insert.run(randomUUID(), threadId, state, threadId, state === "pending" ? 1 : 0, jobId);
}

test("caps approval queues at sixteen per thread and 256 total before creating a job", async () => {
  const bb = await backend();
  try {
    const first = await submitAgent(bb, request);
    seedApprovalRows(bb.db, first.jobId, agent.threadId, 14);
    expect((await submitAgent(bb, request)).status).toBe("awaiting_owner");
    const denied = { code: "limit_exceeded", message: "Commander approval queue is full" };
    const run = async (context: PluginAgentToolContext) => {
      const { id, digest } = ticket.parse(await bb.tool("commander_plan", request, context));
      return bb.tool("commander_run", { planId: id, digest }, context);
    };
    expect(await run(agent)).toEqual(denied);
    for (let i = 0; i < 15; i++) seedApprovalRows(bb.db, first.jobId, "fixture-" + i, i === 0 ? 15 : 16);
    expect(await run({ ...agent, threadId: "last-slot" })).toMatchObject({ status: "awaiting_owner" });
    expect(await run({ ...agent, threadId: "over-limit" })).toEqual(denied);
    expect(bb.db.prepare("SELECT count(*) FROM jobs WHERE awaits_owner = 1").pluck().get()).toBe(256);
  } finally { await bb.dispose(); }
});

test("an unknown page with no matches decodes at most 200 rows and resumes at its cursor", async () => {
  const bb = await backend();
  try {
    const first = await submitAgent(bb, request);
    bb.db.prepare("UPDATE jobs SET plan_json = '{', created_at = ? WHERE id = ?").run("2026-11-27T10:00:00.000Z", first.jobId);
    const seed = await submitAgent(bb, request);
    seedApprovalRows(bb.db, seed.jobId, agent.threadId, 205, "completed");
    const decode = vi.spyOn(OperationJob, "parse");
    try {
      const page = z.object({ jobs: z.array(z.unknown()), nextCursor: z.string() })
        .parse(await bb.tool("commander_jobs", { limit: 1, states: ["unknown"] }));
      expect(page.jobs).toEqual([]);
      expect(decode).toHaveBeenCalledTimes(200);
      decode.mockClear();
      expect(await bb.tool("commander_jobs", { limit: 1, states: ["unknown"], cursor: page.nextCursor })).toEqual({
        jobs: [{ id: first.jobId, state: "unknown", damaged: true, message: "Stored job is damaged", createdAt: "2026-11-27T10:00:00.000Z" }],
      });
      expect(decode).toHaveBeenCalledTimes(7);
    } finally { decode.mockRestore(); }
  } finally { await bb.dispose(); }
});

test("append-only migrations persist explicit approval in the job store across reopening", async () => {
  const bb = await backend();
  try {
    const plan = ticket.parse(await bb.tool("commander_plan", request));
    const first = submission.parse(await bb.tool("commander_run", { planId: plan.id, digest: plan.digest }));
    const second = await submitAgent(bb, request);
    await bb.rpc("plan_approve", { jobId: first.jobId, digest: plan.digest });
    const reopened = sqliteStore.createSqliteJobStore(bb.db);
    expect(MIGRATIONS).toHaveLength(7);
    expect(reopened.hasOwnerApproval(first.jobId)).toBe(true);
    expect(reopened.hasOwnerApproval(second.jobId)).toBe(false);
  } finally { await bb.dispose(); }
});

test("saves grants and queues cancellation before the recovery service is ready", async () => {
  const bb = await backend();
  let restarted: typeof bb | undefined;
  let firstDisposed = false;
  const ready = Promise.withResolvers<void>();
  const actual = sqliteStore.createSqliteJobStore;
  let spy: ReturnType<typeof vi.spyOn> | undefined;
  try {
    const { jobId } = await submitAgent(bb, dataCopy);
    bb.db.prepare("UPDATE jobs SET awaits_owner = 0 WHERE id = ?").run(jobId);
    bb.db.prepare("UPDATE jobs SET state = 'running' WHERE id = ?").run(jobId);
    await bb.dispose(false);
    firstDisposed = true;
    spy = vi.spyOn(sqliteStore, "createSqliteJobStore").mockImplementation((db) => {
      const store = actual(db);
      const list = store.list.bind(store);
      store.list = vi.fn(list).mockImplementationOnce(async (filter) => {
        await ready.promise;
        return list(filter);
      });
      return store;
    });
    restarted = await backend(bb);
    const grant = { ...dataGrant, permissions: ["read", "write"] };
    await expect(restarted.rpc("agent_grants_set", { grant })).resolves.toEqual({});
    await expect(restarted.rpc("agent_grants_list", {})).resolves.toEqual({ grants: [grant] });
    await expect(restarted.rpc("job_cancel", { jobId })).resolves.toEqual({});
    await expect(restarted.rpc("job_list", {})).resolves.toMatchObject({ jobs: [{ id: jobId, state: "cancel_requested" }] });
    ready.resolve();
    await vi.waitFor(async () => expect(await restarted!.rpc("job_list", {}))
      .toMatchObject({ jobs: [{ id: jobId, state: "cancelled" }] }));
    expect(restarted.disk.contents(parsePosix("/data/out/a"))).toBeNull();
  } finally {
    ready.resolve();
    if (restarted) await restarted.dispose();
    else if (firstDisposed) bb.db.close();
    else await bb.dispose();
    spy?.mockRestore();
  }
});

test.each(["during reconciliation", "during CAS"])("recovers a second job cancelled %s in the same pass", async (when) => {
  const bb = await backend();
  let restarted: typeof bb | undefined;
  let firstDisposed = false;
  let spy: ReturnType<typeof vi.spyOn> | undefined;
  const reconciling = Promise.withResolvers<void>();
  const continueRecovery = Promise.withResolvers<void>();
  const actual = sqliteStore.createSqliteJobStore;
  try {
    const store = actual(bb.db);
    const firstId = "113e4567-e89b-42d3-a456-426614174000";
    const secondId = "223e4567-e89b-42d3-a456-426614174000";
    for (const [id, input, date] of [
      [firstId, dataCopy, "2026-11-27T02:00:00.000Z"],
      [secondId, request, "2026-11-27T01:00:00.000Z"],
    ] as const) {
      const plan = await bb.rpc("plan_create", input);
      await store.create(OperationJob.parse({
        id, plan, state: "running", currentItem: null, pendingConflict: null, awaitsOwner: false,
        progress: { itemsDone: 0, itemsTotal: 1, bytesDone: "0", bytesTotal: "1" },
        items: [{ outcome: "pending", error: null }], error: null, createdAt: date, updatedAt: date,
      }));
    }
    await bb.dispose(false);
    firstDisposed = true;
    spy = vi.spyOn(sqliteStore, "createSqliteJobStore").mockImplementation((db) => {
      const store = actual(db);
      const update = store.update.bind(store);
      store.update = async (id, patch, expected) => {
        const pauseFirst = when === "during reconciliation" && id === firstId && expected === "interrupted" && patch.progress;
        const pauseSecond = when === "during CAS" && id === secondId && expected === "running" && patch.state === "interrupted";
        if (pauseFirst || pauseSecond) {
          reconciling.resolve();
          await continueRecovery.promise;
        }
        return update(id, patch, expected);
      };
      return store;
    });
    restarted = await backend(bb);
    await reconciling.promise;
    await expect(restarted.rpc("job_cancel", { jobId: secondId })).resolves.toEqual({});
    expect((await store.get(secondId))?.state).toBe("cancel_requested");
    continueRecovery.resolve();
    await vi.waitFor(async () => {
      expect((await store.get(firstId))?.state).toBe("completed");
      expect((await store.get(secondId))?.state).toBe("cancelled");
    }, { timeout: 400 });
    expect(restarted.disk.contents(parsePosix("/out/a"))).toBeNull();
  } finally {
    continueRecovery.resolve();
    if (restarted) await restarted.dispose();
    else if (firstDisposed) bb.db.close();
    else await bb.dispose();
    spy?.mockRestore();
  }
});

test("masks both missing paths and a full plan quota outside the grant", async () => {
  const bb = await backend();
  try {
    await bb.rpc("agent_grants_set", { grant: { ...dataGrant, permissions: ["observe"] } });
    const stem = "long-name-" + "x".repeat(956) + "-";
    const entry = (name: string) => ({
      name: { t: name }, kind: "file" as const, size: "1", mtimeNs: "1",
      mtimePrecision: "ns" as const, mode: null, linkTarget: null, hidden: false,
    });
    const stat = bb.disk.stat.bind(bb.disk);
    vi.spyOn(bb.disk, "stat").mockImplementation((path, signal) => {
      const leaf = path.segments.at(-1);
      return leaf && "t" in leaf && leaf.t.startsWith(stem)
        ? Promise.resolve(entry(leaf.t))
        : stat(path, signal);
    });
    vi.spyOn(bb.disk, "list").mockImplementation(async (_path, { cursor, limit }) => {
      const start = Number(cursor ?? 0);
      const end = Math.min(start + limit, 5_000);
      return { entries: Array.from({ length: end - start }, (_, i) => entry(stem + String(start + i))),
        cursor: end < 5_000 ? String(end) : null };
    });
    const remove = { ...request, kind: "delete", sources: [ref("/out")], targetDir: null };
    const ownerPlan = OperationJob.shape.plan.parse(await bb.rpc("plan_create", remove));
    expect(ownerPlan.items).toHaveLength(5_001);
    expect(Buffer.byteLength(JSON.stringify(ownerPlan))).toBeGreaterThan(4_194_304);
    const missing = await bb.tool("commander_plan", { ...remove, sources: [ref("/missing")] });
    expect(missing).toEqual({ code: "forbidden", message: "Commander refused the request" });
    expect(await bb.tool("commander_plan", remove)).toEqual(missing);
  } finally { await bb.dispose(); }
});

test("cancels a recovering move before source removal and records the verified copy", async () => {
  const bb = await backend();
  let restarted: typeof bb | undefined;
  let firstDisposed = false;
  const verifying = Promise.withResolvers<AbortSignal>();
  const finishVerify = Promise.withResolvers<void>();
  try {
    const store = sqliteStore.createSqliteJobStore(bb.db);
    const id = "523e4567-e89b-42d3-a456-426614174000";
    const plan = await bb.rpc("plan_create", { ...request, kind: "move" });
    const date = "2026-11-27T01:00:00.000Z";
    await store.create(OperationJob.parse({
      id, plan, state: "running", currentItem: 0, pendingConflict: null, awaitsOwner: false,
      progress: { itemsDone: 0, itemsTotal: 1, bytesDone: "1", bytesTotal: "1" },
      items: [{ outcome: "pending", error: null }], error: null, createdAt: date, updatedAt: date,
    }));
    const source = parsePosix("/data/a");
    const target = parsePosix("/out/a");
    const digest = "684888c0ebb17f374298b65ee2807526c066094c701bcc7ebbe1c1095f494fc1";
    bb.disk.put(target, Uint8Array.of(42), "2");
    bb.disk.enableChecksum();
    await store.checkpoint({
      jobId: id, itemIndex: 0, phase: "committed", bytesDone: "1", tempPath: null, targetPath: target,
      expectTarget: "absent", via: "copy", committed: { size: "1", mtimeNs: "2" },
      verified: null, sourceHash: digest,
    });
    await bb.dispose(false);
    firstDisposed = true;
    let checks = 0;
    bb.disk.delay = async (op, path, signal) => {
      if (op !== "sha256" || !samePath(path, target, true) || ++checks !== 2) return;
      verifying.resolve(signal);
      await finishVerify.promise;
    };
    restarted = await backend(bb);
    const operationSignal = await verifying.promise;
    await expect(restarted.rpc("job_cancel", { jobId: id })).resolves.toEqual({});
    finishVerify.resolve();
    await vi.waitFor(async () => expect(await store.get(id)).toMatchObject({
      state: "cancelled", items: [{ outcome: "done", error: "Move cancelled; source retained" }],
    }), { timeout: 500 });
    expect(operationSignal.aborted).toBe(true);
    expect(bb.disk.calls.filter(({ op }) => op === "remove")).toEqual([]);
    expect(bb.disk.contents(source)).toEqual(Uint8Array.of(42));
    expect(bb.disk.contents(target)).toEqual(Uint8Array.of(42));
  } finally {
    finishVerify.resolve();
    if (restarted) await restarted.dispose();
    else if (firstDisposed) bb.db.close();
    else await bb.dispose();
  }
});

test("keeps the Commander page and two thread layouts separate and reads the old page state", async () => {
  const bb = await backend();
  try {
    const emptyPane = { tabs: [], activeTab: null };
    const page = { left: emptyPane, right: emptyPane, activePane: "left", layout: "horizontal", split: 0.5 };
    bb.kv.set("ui-state", page);
    const first = { ...page, activePane: "right", inspectorCollapsed: true };
    const second = { ...page, split: 0.7, inspectorCollapsed: false };
    await expect(bb.rpc("ui_state_set", { threadId: "thread-a", state: first })).resolves.toEqual({});
    await expect(bb.rpc("ui_state_set", { threadId: "thread-b", state: second })).resolves.toEqual({});
    await expect(bb.rpc("ui_state_get", {})).resolves.toEqual({ state: {
      left: { tabs: [], activeTab: null }, right: { tabs: [], activeTab: null },
      activePane: "left", layout: "horizontal", split: 0.5,
    } });
    await expect(bb.rpc("ui_state_get", { threadId: "thread-a" })).resolves.toEqual({ state: {
      left: { tabs: [], activeTab: null }, right: { tabs: [], activeTab: null },
      activePane: "right", layout: "horizontal", split: 0.5, inspectorCollapsed: true,
    } });
    await expect(bb.rpc("ui_state_get", { threadId: "thread-b" })).resolves.toEqual({ state: {
      left: { tabs: [], activeTab: null }, right: { tabs: [], activeTab: null },
      activePane: "left", layout: "horizontal", split: 0.7, inspectorCollapsed: false,
    } });
    await expect(bb.rpc("ui_state_get", { threadId: "thread-c" })).resolves.toEqual({ state: null });
  } finally { await bb.dispose(); }
});

const checksumRequest = { kind: "checksum", ref: ref("/data/a") };
const scanTicket = z.object({ id: z.uuid() });
const scanEstimate = z.object({ estimateId: z.uuid(), bytesPlanned: z.string() });

test.each(["done", "running"] as const)("scan %s reports the correct state after plugin restart", async (state) => {
  const bb = await backend();
  let restarted: Awaited<ReturnType<typeof backend>> | undefined;
  try {
    bb.disk.enableChecksum();
    if (state === "running") {
      bb.disk.delay = async (op, _path, signal) => {
        if (op !== "sha256") return;
        if (!signal.aborted) await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      };
    }
    const { id: scanId } = scanTicket.parse(await bb.rpc("scan_start", checksumRequest));
    await vi.waitFor(async () => expect(await bb.rpc("scan_get", { scanId })).toMatchObject({ job: { state } }));
    await bb.dispose(false);
    restarted = await backend(bb);
    if (state === "done") {
      await expect(restarted.rpc("scan_get", { scanId })).resolves.toMatchObject({
        job: { state: "done", partial: false }, result: null, reason: "result_expired",
      });
    } else {
      await expect(restarted.rpc("scan_get", { scanId })).resolves.toMatchObject({
        job: { state: "interrupted", partial: true }, result: null,
      });
    }
  } finally { await (restarted ?? bb).dispose(); }
});

test("scan_cancel marks a running scan cancelled and scan_get refuses a plugin caller", async () => {
  const bb = await backend();
  try {
    bb.disk.enableChecksum();
    bb.disk.delay = async (op, _path, signal) => {
      if (op === "sha256" && !signal.aborted) {
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      }
    };
    const { id: scanId } = scanTicket.parse(await bb.rpc("scan_start", checksumRequest));
    await expect(bb.rpc("scan_get", { scanId }, { ...client, experimental_caller: { kind: "plugin", pluginId: "other" } }))
      .rejects.toMatchObject({ code: "forbidden", message: "Commander RPC requires an owner client" });
    await expect(bb.rpc("scan_cancel", { scanId })).resolves.toEqual({});
    await vi.waitFor(async () => expect(await bb.rpc("scan_get", { scanId }))
      .toMatchObject({ job: { state: "cancelled", partial: true }, result: null }));
  } finally { await bb.dispose(); }
});

test("SFTP estimate binds actor, request and metadata and can only start one scan", async () => {
  const fixture = remoteFixture({});
  const bb = await backend(undefined, fixture.callRpc);
  const input = { kind: "checksum", ref: { endpoint: fixture.endpoint, path: parsePosix("/data/a") } };
  const clock = vi.spyOn(Date, "now");
  try {
    const now = Date.now();
    clock.mockReturnValue(now);
    await expect(bb.rpc("scan_start", input))
      .rejects.toMatchObject({ code: "forbidden", message: "A remote scan requires a confirmed estimate" });
    await expect(bb.rpc("scan_start", { ...input, approvedBytes: "7" }))
      .rejects.toMatchObject({ code: "invalid", message: "Invalid Commander request" });
    const estimate = scanEstimate.parse(await bb.rpc("scan_start", { ...input, estimateOnly: true }));
    expect(estimate.bytesPlanned).toBe("7");
    expect(fixture.remote.opCount("op:read")).toBe(0);
    await bb.rpc("agent_grants_set", { grant: {
      threadId: "thread-a", endpoint: fixture.endpoint, scope: parsePosix("/"), permissions: ["read"],
    } });
    await expect(bb.tool("commander_checksum", { ref: input.ref, estimateId: estimate.estimateId }))
      .resolves.toEqual({ code: "forbidden", message: "Commander refused the request" });
    clock.mockReturnValue(now + 600_000);
    await expect(bb.rpc("scan_start", { ...input, estimateId: estimate.estimateId }))
      .rejects.toMatchObject({ code: "forbidden", message: "Scan estimate is missing or expired" });

    const stale = scanEstimate.parse(await bb.rpc("scan_start", { ...input, estimateOnly: true }));
    fixture.remote.seedFile("/data/a", "changed snapshot");
    await expect(bb.rpc("scan_start", { ...input, estimateId: stale.estimateId }))
      .rejects.toMatchObject({ code: "conflict", message: "Scan metadata changed; estimate again" });
    expect(fixture.remote.opCount("op:read")).toBe(0);

    const fresh = scanEstimate.parse(await bb.rpc("scan_start", { ...input, estimateOnly: true }));
    expect(fresh.bytesPlanned).toBe("16");
    const { id: scanId } = scanTicket.parse(await bb.rpc("scan_start", { ...input, estimateId: fresh.estimateId }));
    await vi.waitFor(async () => expect(await bb.rpc("scan_get", { scanId }))
      .toMatchObject({ job: { state: "done", progress: { items: 1, bytes: "16", bytesPlanned: "16" } } }));
    await expect(bb.rpc("scan_start", { ...input, estimateId: fresh.estimateId }))
      .rejects.toMatchObject({ code: "forbidden", message: "Scan estimate is missing or expired" });
  } finally {
    clock.mockRestore();
    await bb.dispose();
  }
});

test("scan estimate returns planned bytes per endpoint and a total", async () => {
  const fixture = remoteFixture({});
  const bb = await backend(undefined, fixture.callRpc);
  try {
    await expect(bb.rpc("scan_start", {
      kind: "dirs", by: "sha256", estimateOnly: true, left: ref("/data"),
      right: { endpoint: fixture.endpoint, path: parsePosix("/data") },
    })).resolves.toMatchObject({
      bytesPlanned: "8",
      bytesByEndpoint: [{ endpoint: "host:test", bytesPlanned: "1" }, { endpoint: fixture.endpoint, bytesPlanned: "7" }],
    });
    expect(fixture.remote.opCount("op:read")).toBe(0);
  } finally { await bb.dispose(); }
});

test("a seventeenth estimate on one agent thread is refused while another thread can estimate", async () => {
  const bb = await backend();
  try {
    await bb.rpc("agent_grants_set", { grant: {
      threadId: "*", endpoint: "host:test", scope: parsePosix("/"), permissions: ["read"],
    } });
    const input = { ref: ref("/data/a"), estimateOnly: true };
    for (let i = 0; i < 16; i++) await expect(bb.tool("commander_checksum", input))
      .resolves.toMatchObject({ bytesPlanned: "1", estimateId: expect.any(String) });
    await expect(bb.tool("commander_checksum", input))
      .resolves.toEqual({ code: "conflict", message: "Commander refused the request" });
    await expect(bb.tool("commander_checksum", input, { ...agent, threadId: "thread-b" }))
      .resolves.toMatchObject({ bytesPlanned: "1", estimateId: expect.any(String) });
  } finally { await bb.dispose(); }
});

test("S11 RPC bounds SFTP content, binds the estimate, and restricts agent output", async () => {
  const fixture = remoteFixture();
  fixture.remote.seedFile("/data/a", "header\nneedle" + "z".repeat(250));
  fixture.remote.seedFile("/data/b", "needle" + "x".repeat(450));
  const bb = await backend(undefined, fixture.callRpc);
  const root = { endpoint: fixture.endpoint, path: parsePosix("/data") };
  const request = { kind: "search", root, content: { text: "needle", caseSensitive: true }, limits: { maxBytesRead: "300" } };
  try {
    await expect(bb.rpc("scan_start", request)).rejects.toMatchObject({
      code: "forbidden", message: expect.stringContaining("content_search_needs_consent"),
    });
    await expect(bb.tool("commander_search", { root })).resolves.toMatchObject({ code: "forbidden" });
    await bb.rpc("agent_grants_set", { grant: { threadId: "thread-a", endpoint: fixture.endpoint,
      scope: parsePosix("/"), permissions: ["read"] } });
    await expect(bb.tool("commander_search", { root, content: request.content, limits: request.limits }))
      .resolves.toMatchObject({ code: "content_search_needs_consent" });
    const estimate = z.object({ estimateId: z.uuid(), bytesPlanned: z.string() })
      .parse(await bb.rpc("scan_start", { ...request, estimateOnly: true }));
    expect(estimate.bytesPlanned).toBe("263");
    expect(fixture.remote.opCount("op:read")).toBe(0);
    await expect(bb.tool("commander_search", { root, content: request.content, limits: request.limits, estimateId: estimate.estimateId }))
      .resolves.toMatchObject({ code: "forbidden" });
    const { id } = z.object({ id: z.uuid() }).parse(await bb.rpc("scan_start", { ...request, estimateId: estimate.estimateId }));
    await vi.waitFor(async () => expect(await bb.rpc("scan_get", { scanId: id })).toMatchObject({
      job: { kind: "search", partial: true, state: "done", progress: { bytes: "263", bytesPlanned: "263" } },
      result: { partial: true, hits: [{ ref: { endpoint: fixture.endpoint, path: parsePosix("/data/a") },
        line: { number: 2, text: "needle" + "z".repeat(194) } }] },
    }));
    expect(fixture.remote.opCount("op:read")).toBe(1);
    await expect(bb.rpc("scan_start", { ...request, estimateId: estimate.estimateId }))
      .rejects.toMatchObject({ code: "forbidden" });
    const agentInput = { root, content: request.content, limits: request.limits };
    const ticket = z.object({ estimateId: z.uuid(), bytesPlanned: z.literal("263") })
      .parse(await bb.tool("commander_search", { ...agentInput, estimateOnly: true }));
    await expect(bb.tool("commander_search", { ...agentInput, estimateId: ticket.estimateId })).resolves.toMatchObject({
      partial: true, hits: [{ line: { number: 2, text: "needle" + "z".repeat(194) } }],
    });
  } finally { await bb.dispose(); }
});

test("S11 RPC cancels remote read before another request", async () => {
  const fixture = remoteFixture();
  fixture.remote.seedFile("/data/a", "x".repeat(131_073));
  let reads = 0;
  let finish!: () => void;
  const waiting = new Promise<void>((resolve) => { finish = resolve; });
  const bb = await backend(undefined, async (args) => {
    if (args.method === "hub_sftp_op" && (args.input as { op: string }).op === "read") {
      reads++;
      await waiting;
    }
    return fixture.callRpc(args);
  });
  const input = { kind: "search", root: { endpoint: fixture.endpoint, path: parsePosix("/data") },
    content: { text: "needle", caseSensitive: true }, limits: { maxBytesRead: "131073" } };
  try {
    const { estimateId } = z.object({ estimateId: z.uuid(), bytesPlanned: z.literal("131073") })
      .parse(await bb.rpc("scan_start", { ...input, estimateOnly: true }));
    const { id: scanId } = z.object({ id: z.uuid() })
      .parse(await bb.rpc("scan_start", { ...input, estimateId }));
    await vi.waitFor(() => expect(reads).toBe(1));
    await bb.rpc("scan_cancel", { scanId });
    finish();
    await vi.waitFor(async () => expect(await bb.rpc("scan_get", { scanId }))
      .toMatchObject({ job: { state: "cancelled", partial: true }, result: null }));
    expect(reads).toBe(1);
  } finally { finish(); await bb.dispose(); }
});

test("S11 RPC caps the full serialized agent tool result at 1 MiB", async () => {
  const bb = await backend();
  try {
    const root = { endpoint: "host:test", path: parsePosix("/data") };
    for (let index = 0; index < 1150; index++) {
      bb.disk.put(parsePosix("/data/" + String(index) + '"'.repeat(180)), new Uint8Array());
    }
    await bb.rpc("agent_grants_set", { grant: { threadId: "thread-a", endpoint: root.endpoint,
      scope: root.path, permissions: ["read"] } });
    const result = await bb.tool("commander_search", { root });
    expect(result).toMatchObject({ partial: true, hits: expect.any(Array) });
    expect((result as { hits: unknown[] }).hits.length).toBeGreaterThan(0);
    const envelope = { content: [{ type: "text", text: JSON.stringify(result) }] };
    expect(Buffer.byteLength(JSON.stringify(envelope))).toBeLessThanOrEqual(1048576);
  } finally { await bb.dispose(); }
});

test.each(["estimate", "confirmed start"] as const)("S11 aborts %s after the first SFTP list request", async (phase) => {
  const fixture = remoteFixture();
  for (const name of ["a", "b"]) fixture.remote.seedFile("/data/out/" + name, "needle");
  const controller = new AbortController();
  let lists = 0;
  let armed = false;
  const bb = await backend(undefined, async (args) => {
    if (armed && args.method === "hub_sftp_op" && (args.input as { op: string }).op === "list") {
      lists++;
      expect(args.signal.aborted).toBe(false);
      const page = await fixture.callRpc(args);
      controller.abort();
      return page;
    }
    return fixture.callRpc(args);
  });
  const request = { kind: "search", root: { endpoint: fixture.endpoint, path: parsePosix("/data") },
    content: { text: "needle", caseSensitive: true }, limits: { maxBytesRead: "1024" } };
  try {
    const input = phase === "estimate" ? { ...request, estimateOnly: true } : {
      ...request, ...z.object({ estimateId: z.uuid() }).parse(await bb.rpc("scan_start", { ...request, estimateOnly: true })),
    };
    armed = true;
    await expect(bb.rpc("scan_start", input, { ...client, experimental_signal: controller.signal })).rejects.toBeDefined();
    expect(lists).toBe(1);
    expect(fixture.remote.opCount("op:read")).toBe(0);
  } finally { await bb.dispose(); }
});

// The second fixture adds one visible character beyond the response limit.
const line200 = "0123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789"
  + "abcdefghijabcdefghijabcdefghijabcdefghijabcdefghijabcdefghijabcdefghijabcdefghijabcdefghijabcdefghij";
test.each([
  { length: 200, line: line200 },
  { length: 201, line: line200 + "!" },
])("S11 agent returns exactly 200 characters for a $length-character match", async ({ length, line }) => {
  const fixture = remoteFixture();
  expect(line).toHaveLength(length);
  fixture.remote.seedFile("/data/a", line + "\n");
  const root = { endpoint: fixture.endpoint, path: parsePosix("/data") };
  const bb = await backend(undefined, fixture.callRpc);
  try {
    await bb.rpc("agent_grants_set", { grant: { threadId: "thread-a", endpoint: root.endpoint,
      scope: parsePosix("/"), permissions: ["read"] } });
    const input = { root, content: { text: "0123", caseSensitive: true }, limits: { maxBytesRead: "202" } };
    const { estimateId } = z.object({ estimateId: z.uuid() })
      .parse(await bb.tool("commander_search", { ...input, estimateOnly: true }));
    await expect(bb.tool("commander_search", { ...input, estimateId }))
      .resolves.toMatchObject({ partial: false, hits: [{ line: { number: 1, text: line200 } }] });
  } finally { await bb.dispose(); }
});
