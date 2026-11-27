import { expect, test, vi } from "vitest";
import { experimental_PluginRpcCallError, type BbPluginApi, type PluginAgentToolContext, type PluginCliRegistration } from "@get-bb/plugin-sdk";
import Database from "better-sqlite3";
import { z } from "zod";
import activate from "./server.ts";
import { parsePosix, samePath } from "./src/core/path.ts";
import { FakeProvider } from "./src/core/testing/fake-provider.ts";
import * as sqliteStore from "./src/adapters/bb/job-store-sqlite.ts";
import { OperationJob } from "./src/core/model.ts";
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
    hosts: { experimental_client: () => ({ call: async (method: string, data: { path: ReturnType<typeof parsePosix> } & Parameters<NonNullable<FakeProvider["copyWithin"]>>[2] & { from: ReturnType<typeof parsePosix>; to: ReturnType<typeof parsePosix>; cursor: string | null; limit: number }, ctx: { signal?: AbortSignal }) => {
      if (method === "home") return { path: parsePosix("/home/test"), caseSensitive: true };
      if (method === "stat") return disk.stat(data.path, ctx.signal ?? agent.signal);
      if (method === "list") return disk.list(data.path, data, ctx.signal ?? agent.signal);
      if (method === "copyWithin") return disk.copyWithin!(data.from, data.to, data, ctx.signal ?? agent.signal);
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

test("hides damaged plans in RPC, agent tools and CLI and refuses mutation", async () => {
  const bb = await backend();
  try {
    const { id, digest } = ticket.parse(await bb.tool("commander_plan", request));
    const { jobId } = submission.parse(await bb.tool("commander_run", { planId: id, digest }));
    bb.db.prepare("UPDATE jobs SET plan_json = ? WHERE id = ?").run("{", jobId);
    const expected = { jobs: [{ id: jobId, state: "unknown", damaged: true, message: "Stored job is damaged" }] };
    expect(await bb.rpc("job_list", {})).toEqual(expected);
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
    bb.db.prepare("UPDATE jobs SET plan_json = ?, updated_at = ? WHERE id = ?")
      .run("{", "2099-01-01T00:00:00.000Z", owned.jobId);
    const parseJob = vi.spyOn(OperationJob, "parse");
    try {
      expect(await bb.tool("commander_jobs", { limit: 1 })).toEqual({ jobs: [{
        id: owned.jobId, state: "unknown", damaged: true, message: "Stored job is damaged",
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

function remoteFixture() {
  const profileId = "5b568675-f842-4a96-83e0-78ae53d96024";
  const endpoint = "sftp:" + profileId;
  const remote = new RemoteHubMock();
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
          throw new experimental_PluginRpcCallError({ code: SFTP_REFUSALS[error.code], message: error.message });
        }
        throw error;
      }
    },
  };
}

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
