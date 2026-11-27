// Read window through the owner RPC and the agent tool. The fake host serves stat and read
// for host:test; grants are set through the same RPC the owner UI uses.
import { expect, test, vi } from "vitest";
import type { BbPluginApi, PluginAgentToolContext } from "@get-bb/plugin-sdk";
import Database from "better-sqlite3";
import activate from "../server.ts";
import { parsePosix } from "../src/core/path.ts";
import { FakeProvider } from "../src/core/testing/fake-provider.ts";

const client = { experimental_caller: { kind: "client" }, experimental_signal: new AbortController().signal };
const agent: PluginAgentToolContext = { threadId: "thread-a", projectId: "project", signal: new AbortController().signal };
const ref = (path: string) => ({ endpoint: "host:test", path: parsePosix(path) });
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]);

async function backend() {
  const db = new Database(":memory:");
  const disk = new FakeProvider("host:test");
  disk.put(parsePosix("/data/big.txt"), new Uint8Array(2 * 1024 * 1024).fill(0x41), "1");
  disk.put(parsePosix("/data/data.bin"), Uint8Array.from([0x00, 0x01, 0x02]), "1");
  disk.put(parsePosix("/data/picture.png"), PNG, "1");
  disk.put(parsePosix("/data/controls.dat"), new Uint8Array(600 * 1024).fill(0x01), "1");
  disk.put(parsePosix("/etc/secret"), Uint8Array.of(12), "1");
  let handlers: Record<string, (input: unknown, ctx: unknown) => Promise<unknown>> = {};
  const tools = new Map<string, (input: unknown, ctx: PluginAgentToolContext) => Promise<{ content: { text: string }[] }>>();
  const kv = new Map<string, unknown>();
  const serviceSignal = new AbortController();
  let service: Promise<void> | undefined;
  activate({
    sdk: { hosts: { list: async () => [{ id: "test", name: "Test host" }] }, plugins: { callRpc: async () => { throw new Error("unavailable"); } } },
    hosts: { experimental_client: () => ({ call: async (method: string, data: Record<string, unknown>, ctx: { signal?: AbortSignal }) => {
      const signal = ctx.signal ?? agent.signal;
      if (method === "home") return { path: parsePosix("/home/test"), caseSensitive: true };
      if (method === "stat") return disk.stat(data.path as ReturnType<typeof parsePosix>, signal);
      if (method === "read") {
        const bytes = await disk.read(data.path as ReturnType<typeof parsePosix>, BigInt(data.offset as string),
          data.length as number, (data.expect ?? null) as never, signal);
        return { b64: Buffer.from(bytes).toString("base64") };
      }
      throw new Error("unexpected test method " + method);
    } }) },
    storage: {
      database: () => db,
      migrate: (_db: Database.Database, statements: string[]) => statements.forEach((sql) => db.exec(sql)),
      kv: { get: async (key: string) => kv.get(key), set: async (key: string, value: unknown) => { kv.set(key, value); } },
    },
    rpc: { register: (_contract: unknown, methods: typeof handlers) => { handlers = methods; } },
    realtime: { publish: vi.fn() },
    log: { error: vi.fn() },
    background: { service: (_name: string, task: { start(signal: AbortSignal): Promise<void> }) => { service = task.start(serviceSignal.signal); void service.catch(() => {}); } },
    onDispose: () => undefined,
    agents: { registerTool: (tool: { name: string; execute: (input: unknown, ctx: PluginAgentToolContext) => Promise<{ content: { text: string }[] }> }) => tools.set(tool.name, tool.execute) },
    cli: { register: () => undefined },
  } as unknown as BbPluginApi);
  await new Promise<void>((resolve) => setImmediate(resolve));
  return {
    rpc: (name: string, input: unknown) => handlers[name](input, client),
    async tool(name: string, input: unknown, ctx = agent): Promise<unknown> {
      return JSON.parse((await tools.get(name)!(input, ctx)).content[0].text);
    },
    async dispose() { serviceSignal.abort(); await service?.catch(() => {}); db.close(); },
  };
}

const RESPONSE_MAX = 1048576;
const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const shared = { threadId: "thread-a", endpoint: "host:test", scope: parsePosix("/data"), permissions: ["read"] };

test("owner RPC returns a 2 MiB text file as one window whose JSON is at most 1 MiB, marked truncated", async () => {
  const bb = await backend();
  try {
    const result = await bb.rpc("file_read", { ref: ref("/data/big.txt") }) as { modes: string[]; view: { kind: string; text: string; truncated: boolean } };
    expect(result.modes).toEqual(["text", "binary"]);
    expect(result.view.kind).toBe("text");
    expect(result.view.truncated).toBe(true);
    expect(jsonBytes(result)).toBeLessThanOrEqual(RESPONSE_MAX);
  } finally { await bb.dispose(); }
});

test("owner RPC switches a text file to hex with mode binary", async () => {
  const bb = await backend();
  try {
    const result = await bb.rpc("file_read", { ref: ref("/data/big.txt"), mode: "binary" }) as { modes: string[]; view: { kind: string; lines: string[]; truncated: boolean } };
    expect(result.modes).toEqual(["text", "binary"]);
    expect(result.view.kind).toBe("binary");
    expect(result.view.lines[0]).toBe("00000000  41 41 41 41 41 41 41 41 41 41 41 41 41 41 41 41");
    expect(jsonBytes(result)).toBeLessThanOrEqual(RESPONSE_MAX);
  } finally { await bb.dispose(); }
});

test("owner RPC honours offset on a binary file", async () => {
  const bb = await backend();
  try {
    await expect(bb.rpc("file_read", { ref: ref("/data/data.bin"), offset: "1" })).resolves.toEqual({
      modes: ["binary"], view: { kind: "binary", lines: ["00000001  01 02"], truncated: false },
    });
  } finally { await bb.dispose(); }
});

test("agent commander_read with a read grant gets a window whose JSON is at most 1 MiB", async () => {
  const bb = await backend();
  try {
    await bb.rpc("agent_grants_set", { grant: shared });
    const result = await bb.tool("commander_read", { ref: ref("/data/big.txt") }) as { view: { kind: string; truncated: boolean } };
    expect(result.view).toMatchObject({ kind: "text", truncated: true });
    expect(jsonBytes(result)).toBeLessThanOrEqual(RESPONSE_MAX);
  } finally { await bb.dispose(); }
});

test("agent commander_read of 600 KiB of 0x01 bytes is binary and within 1 MiB", async () => {
  const bb = await backend();
  try {
    await bb.rpc("agent_grants_set", { grant: shared });
    const result = await bb.tool("commander_read", { ref: ref("/data/controls.dat") }) as { modes: string[]; view: { kind: string; truncated: boolean } };
    expect(result.modes).toEqual(["binary"]);
    expect(result.view).toMatchObject({ kind: "binary", truncated: true });
    expect(jsonBytes(result)).toBeLessThanOrEqual(RESPONSE_MAX);
  } finally { await bb.dispose(); }
});

test("agent commander_read outside its grant is refused and reads nothing", async () => {
  const bb = await backend();
  try {
    await bb.rpc("agent_grants_set", { grant: shared });
    await expect(bb.tool("commander_read", { ref: ref("/etc/secret") })).resolves.toMatchObject({ code: "forbidden" });
  } finally { await bb.dispose(); }
});

test("agent commander_read of a small binary file returns hex lines", async () => {
  const bb = await backend();
  try {
    await bb.rpc("agent_grants_set", { grant: shared });
    await expect(bb.tool("commander_read", { ref: ref("/data/data.bin") })).resolves.toEqual({
      modes: ["binary"], view: { kind: "binary", lines: ["00000000  00 01 02"], truncated: false },
    });
  } finally { await bb.dispose(); }
});

test("owner RPC returns a PNG as base64 under image/png, offering hex too", async () => {
  const bb = await backend();
  try {
    await expect(bb.rpc("file_read", { ref: ref("/data/picture.png") })).resolves.toEqual({
      modes: ["image", "binary"],
      view: { kind: "image", mime: "image/png", base64: "iVBORw0KGgoAAAANSUhEUg==", truncated: false },
    });
  } finally { await bb.dispose(); }
});
