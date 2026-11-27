// Read window through the owner RPC and the agent tool. The fake host serves stat and read
// for host:test; grants are set through the same RPC the owner UI uses.
import { expect, test, vi } from "vitest";
import type { BbPluginApi, PluginAgentToolContext } from "@get-bb/plugin-sdk";
import Database from "better-sqlite3";
import activate from "../server.ts";
import { assembleImage, MAX_VIEW_BYTES, type WireView } from "../src/core/preview.ts";
import { parsePosix } from "../src/core/path.ts";
import { FakeProvider } from "../src/core/testing/fake-provider.ts";

const client = { experimental_caller: { kind: "client" }, experimental_signal: new AbortController().signal };
const agent: PluginAgentToolContext = { threadId: "thread-a", projectId: "project", signal: new AbortController().signal };
const ref = (path: string) => ({ endpoint: "host:test", path: parsePosix(path) });
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]);
const RESPONSE_MAX = 1048576;
const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const shared = { threadId: "thread-a", endpoint: "host:test", scope: parsePosix("/data"), permissions: ["read"] };
const PNG_3MIB = (() => {
  const bytes = new Uint8Array(3 * 1024 * 1024);
  bytes.set(PNG, 0);
  for (let index = PNG.length; index < bytes.length; index++) bytes[index] = index % 251;
  return bytes;
})();

async function backend() {
  const db = new Database(":memory:");
  const disk = new FakeProvider("host:test");
  disk.put(parsePosix("/data/big.txt"), new Uint8Array(2 * 1024 * 1024).fill(0x41), "1");
  disk.put(parsePosix("/data/data.bin"), Uint8Array.from([0x00, 0x01, 0x02]), "1");
  disk.put(parsePosix("/data/picture.png"), PNG, "1");
  disk.put(parsePosix("/data/controls.dat"), new Uint8Array(600 * 1024).fill(0x01), "1");
  disk.put(parsePosix("/data/big.png"), PNG_3MIB, "1");
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
    disk,
    rpc: (name: string, input: unknown) => handlers[name](input, client),
    /** The tool result exactly as the host receives it, before any JSON.parse. */
    async toolRaw(name: string, input: unknown, ctx = agent): Promise<{ content: { text: string }[] }> {
      return tools.get(name)!(input, ctx);
    },
    async tool(name: string, input: unknown, ctx = agent): Promise<unknown> {
      return JSON.parse((await tools.get(name)!(input, ctx)).content[0].text);
    },
    async dispose() { serviceSignal.abort(); await service?.catch(() => {}); db.close(); },
  };
}

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

test("owner RPC switches a text file to hex with mode binary, with the ASCII column", async () => {
  const bb = await backend();
  try {
    const result = await bb.rpc("file_read", { ref: ref("/data/big.txt"), mode: "binary" }) as { modes: string[]; view: { kind: string; lines: string[]; truncated: boolean } };
    expect(result.modes).toEqual(["text", "binary"]);
    expect(result.view.kind).toBe("binary");
    expect(result.view.lines[0]).toBe("00000000  41 41 41 41 41 41 41 41  41 41 41 41 41 41 41 41  |AAAAAAAAAAAAAAAA|");
    expect(jsonBytes(result)).toBeLessThanOrEqual(RESPONSE_MAX);
  } finally { await bb.dispose(); }
});

test("owner RPC honours offset on a binary file and reports the shown and total counts", async () => {
  const bb = await backend();
  try {
    await expect(bb.rpc("file_read", { ref: ref("/data/data.bin"), offset: "1" })).resolves.toEqual({
      version: { size: "3", mtimeNs: "1" },
      modes: ["binary"],
      view: { kind: "binary", lines: ["00000001  01 02" + " ".repeat(45) + "|..|"], truncated: false, shown: 2, total: "3" },
    });
  } finally { await bb.dispose(); }
});

test("agent commander_read: the whole tool result is at most 1 MiB, measured before JSON.parse", async () => {
  const bb = await backend();
  try {
    await bb.rpc("agent_grants_set", { grant: shared });
    const raw = await bb.toolRaw("commander_read", { ref: ref("/data/big.txt") });
    expect(jsonBytes(raw)).toBeLessThanOrEqual(RESPONSE_MAX);
    const result = JSON.parse(raw.content[0]!.text) as { modes: string[]; view: { kind: string; truncated: boolean } };
    expect(result.modes).toEqual(["text", "binary"]);
    expect(result.view).toMatchObject({ kind: "text", truncated: true });
  } finally { await bb.dispose(); }
});

test("agent commander_read of 600 KiB of 0x01 bytes is binary, cut, and within 1 MiB as a tool result", async () => {
  const bb = await backend();
  try {
    await bb.rpc("agent_grants_set", { grant: shared });
    const raw = await bb.toolRaw("commander_read", { ref: ref("/data/controls.dat") });
    expect(jsonBytes(raw)).toBeLessThanOrEqual(RESPONSE_MAX);
    const result = JSON.parse(raw.content[0]!.text) as { modes: string[]; view: { kind: string; truncated: boolean; total: string } };
    expect(result.modes).toEqual(["binary"]);
    expect(result.view).toMatchObject({ kind: "binary", truncated: true, total: "614400" });
  } finally { await bb.dispose(); }
});

test("agent commander_read asks for an image and gets hex, never image bytes", async () => {
  const bb = await backend();
  try {
    await bb.rpc("agent_grants_set", { grant: shared });
    await expect(bb.tool("commander_read", { ref: ref("/data/picture.png"), mode: "image" })).resolves.toEqual({
      version: { size: "16", mtimeNs: "1" },
      modes: ["binary"],
      view: {
        kind: "binary",
        lines: ["00000000  89 50 4e 47 0d 0a 1a 0a  00 00 00 0d 49 48 44 52  |.PNG........IHDR|"],
        truncated: false, shown: 16, total: "16",
      },
    });
  } finally { await bb.dispose(); }
});

test("agent commander_read outside its grant is refused and reads nothing", async () => {
  const bb = await backend();
  try {
    await bb.rpc("agent_grants_set", { grant: shared });
    await expect(bb.tool("commander_read", { ref: ref("/etc/secret") })).resolves.toMatchObject({ code: "forbidden" });
  } finally { await bb.dispose(); }
});

test("owner RPC returns a PNG as base64 under image/png, offering hex too", async () => {
  const bb = await backend();
  try {
    await expect(bb.rpc("file_read", { ref: ref("/data/picture.png") })).resolves.toEqual({
      version: { size: "16", mtimeNs: "1" },
      modes: ["image", "binary"],
      view: { kind: "image", mime: "image/png", base64: "iVBORw0KGgoAAAANSUhEUg==", truncated: false },
    });
  } finally { await bb.dispose(); }
});

test("owner joins a 3 MiB PNG from chunks and gets the same bytes back", async () => {
  const bb = await backend();
  try {
    const first = await bb.rpc("file_read", { ref: ref("/data/big.png") }) as WireView;
    expect(first.view.kind).toBe("chunk");

    const result = await assembleImage("big.png", first, (offset, expect) =>
      bb.rpc("file_read", { ref: ref("/data/big.png"), mode: "image", offset: offset.toString(), expect }) as Promise<WireView>);

    expect(result.model.kind === "image" && result.model.mime).toBe("image/png");
    expect(result.model.kind === "image" && result.model.bytes.byteLength).toBe(3145728);
    expect(result.model.kind === "image" && Buffer.from(result.model.bytes).equals(Buffer.from(PNG_3MIB))).toBe(true);
  } finally { await bb.dispose(); }
});

test("a chunk after the file changed fails with the conflict whose message carries changed_since_plan", async () => {
  const bb = await backend();
  try {
    const first = await bb.rpc("file_read", { ref: ref("/data/big.png") }) as WireView;
    bb.disk.put(parsePosix("/data/big.png"), PNG_3MIB.subarray(0, 2 * 1024 * 1024), "2");

    await expect(assembleImage("big.png", first, (offset, expect) =>
      bb.rpc("file_read", { ref: ref("/data/big.png"), mode: "image", offset: offset.toString(), expect }) as Promise<WireView>))
      .rejects.toMatchObject({
        code: "conflict",
        message: expect.stringContaining('"code":"changed_since_plan"'),
      });
  } finally { await bb.dispose(); }
});

test("a window request with a stale expect version fails before reading", async () => {
  const bb = await backend();
  try {
    await expect(bb.rpc("file_read", { ref: ref("/data/big.txt"), offset: "1024", expect: { size: "1", mtimeNs: "1" } }))
      .rejects.toMatchObject({ code: "conflict", message: expect.stringContaining('"code":"changed_since_plan"') });
    expect(MAX_VIEW_BYTES).toBe(1048576);
  } finally { await bb.dispose(); }
});
