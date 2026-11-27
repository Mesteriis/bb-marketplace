import { expect, test, vi } from "vitest";
import type { BbPluginApi, PluginAgentToolContext, PluginCliRegistration } from "@get-bb/plugin-sdk";
import Database from "better-sqlite3";
import { z } from "zod";
import activate from "./server.ts";
import { parsePosix } from "./src/core/path.ts";
import { FakeProvider } from "./src/core/testing/fake-provider.ts";

const client = { experimental_caller: { kind: "client" }, experimental_signal: new AbortController().signal };
const agent: PluginAgentToolContext = { threadId: "thread-a", projectId: "project", signal: new AbortController().signal };
const ref = (path: string) => ({ endpoint: "host:test", path: parsePosix(path) });
const request = {
  kind: "copy", sources: [ref("/data/a")], targetDir: ref("/out"), newName: null,
  conflictPolicy: "ask", verify: "size",
};
const ticket = z.object({ id: z.uuid(), digest: z.string() });
const submission = z.object({ jobId: z.uuid(), status: z.string() });

async function backend(previous?: { db: Database.Database; disk: FakeProvider }) {
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
  const kv = new Map();
  const shutdown: (() => Promise<void>)[] = [];
  const events = vi.fn();
  const serviceSignal = new AbortController();
  let service: Promise<void> | undefined;
  activate({
    sdk: {
      hosts: { list: async () => [{ id: "test", name: "Test host" }] },
      plugins: { callRpc: async () => { throw new Error("unavailable"); } },
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
    background: { service: (_name: string, task: { start(signal: AbortSignal): Promise<void> }) => { service = task.start(serviceSignal.signal); } },
    onDispose: (hook: () => Promise<void>) => shutdown.push(hook),
    agents: { registerTool: (tool: { name: string; execute: typeof tools extends Map<string, infer V> ? V : never }) => tools.set(tool.name, tool.execute) },
    cli: { register: (cli: PluginCliRegistration) => { registration = cli; } },
  } as unknown as BbPluginApi);
  await new Promise<void>((resolve) => setImmediate(resolve));
  return {
    db, disk, events,
    rpc: (name: string, input: unknown, ctx: unknown = client) => handlers[name](input, ctx),
    async tool(name: string, input: unknown, ctx = agent): Promise<unknown> {
      return JSON.parse((await tools.get(name)!(input, ctx)).content[0].text);
    },
    cli: (argv: string[]) => registration!.run(argv, {} as Parameters<PluginCliRegistration["run"]>[1]),
    async dispose(close = true) {
      serviceSignal.abort();
      for (const hook of shutdown) await hook();
      await service;
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
