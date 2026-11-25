import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpGateway, type McpGatewayOptions, type McpStdioCatalog, type McpStdioConfig, type McpStdioHost } from "./gateway.js";
import { AgentPluginsStore } from "./store.js";
import type { PluginRecord } from "./types.js";

const PLUGIN_ID = "idle-plugin";
const SERVER_ID = "sleepy";
const TEN_MINUTES_MS = 600_000;

const databases: Database.Database[] = [];
const gateways: McpGateway[] = [];

function openDatabase(): Database.Database {
  const database = new Database(":memory:");
  databases.push(database);
  return database;
}

function storeOn(database: Database.Database): AgentPluginsStore {
  return new AgentPluginsStore(database, (db, statements) => {
    for (const statement of statements) {
      // The BB host applies each statement once; replaying an ALTER on the
      // same database (a simulated restart) must not fail the fixture.
      try { db.exec(statement); } catch (error) {
        if (!/duplicate column name/u.test(String(error))) throw error;
      }
    }
  });
}

function addServer(store: AgentPluginsStore, config: Record<string, unknown> = { type: "stdio", command: "node" }): void {
  const plugin: PluginRecord = {
    id: PLUGIN_ID,
    name: "Idle Plugin",
    version: "1.0.0",
    description: null,
    specVersion: "1.0.0",
    sourceType: "path",
    sourceIntent: "path:/tmp/idle-plugin",
    sourceResolved: null,
    sourceRef: null,
    tagPrefix: null,
    pluginRoot: "/tmp/idle-plugin-root",
    pluginData: "/tmp/idle-plugin-data",
    activeGen: 1,
    status: "active",
    approval: "approved",
    lastError: null,
    contentHash: null,
    installedAt: 1,
    updatedAt: 1,
  };
  store.upsertPlugin(plugin);
  store.upsertMcpServer({
    pluginId: PLUGIN_ID,
    serverId: SERVER_ID,
    type: "stdio",
    configJson: JSON.stringify(config),
    status: "idle",
    lastError: null,
    approved: 1,
    enabled: 1,
  });
}

function catalogWith(toolName: string): McpStdioCatalog {
  return {
    tools: [{ name: toolName, description: "Echo", inputSchema: { type: "object" } }],
    prompts: [{ name: "greeting" }],
    resources: [{ uri: "fixture://readme", name: "readme" }],
    resourceTemplates: [],
  } as unknown as McpStdioCatalog;
}

interface FakeHost extends McpStdioHost {
  start: ReturnType<typeof vi.fn<McpStdioHost["start"]>>;
  refresh: ReturnType<typeof vi.fn<McpStdioHost["refresh"]>>;
  close: ReturnType<typeof vi.fn<McpStdioHost["close"]>>;
  callTool: ReturnType<typeof vi.fn<McpStdioHost["callTool"]>>;
}

function fakeHost(toolName = "echo"): FakeHost {
  return {
    start: vi.fn<McpStdioHost["start"]>(async () => catalogWith(toolName)),
    refresh: vi.fn<McpStdioHost["refresh"]>(async () => catalogWith(toolName)),
    close: vi.fn<McpStdioHost["close"]>(async () => undefined),
    callTool: vi.fn<McpStdioHost["callTool"]>(async () => ({ content: [{ type: "text", text: "isolated" }] })),
    getPrompt: async () => ({ messages: [] }),
    readResource: async () => ({ contents: [] }),
    complete: async () => ({ completion: { values: [] } }),
    subscribeResource: async () => undefined,
    unsubscribeResource: async () => undefined,
    setLoggingLevel: async () => undefined,
  };
}

function createGateway(store: AgentPluginsStore, host: McpStdioHost, options: McpGatewayOptions = {}): McpGateway {
  const gateway = new McpGateway(store, { info() {}, warn() {}, error() {} }, { stdioHost: host, ...options });
  gateways.push(gateway);
  return gateway;
}

function serverRecord(store: AgentPluginsStore) {
  return store.listMcpServers(PLUGIN_ID)[0]!;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-25T10:00:00Z"));
});

afterEach(async () => {
  for (const gateway of gateways.splice(0)) await gateway.close();
  vi.useRealTimers();
  for (const database of databases.splice(0)) database.close();
});

describe("McpGateway idle stop", () => {
  it("stops a stdio server after the idle time and keeps it approved and enabled", async () => {
    const store = storeOn(openDatabase());
    addServer(store);
    const host = fakeHost();
    const gateway = createGateway(store, host, { idleStopMs: TEN_MINUTES_MS });

    const tools = await gateway.listTools();
    await gateway.call(tools[0]!.opaqueId, {});
    expect(serverRecord(store).status).toBe("ready");

    await vi.advanceTimersByTimeAsync(599_999);
    expect(host.close).toHaveBeenCalledTimes(0);
    expect(serverRecord(store).status).toBe("ready");

    await vi.advanceTimersByTimeAsync(1);
    expect(host.close).toHaveBeenCalledTimes(1);
    expect(host.close.mock.calls[0]![0]).toBe("idle-plugin:sleepy");
    expect(serverRecord(store)).toMatchObject({ status: "idle", lastError: null, approved: 1, enabled: 1 });
    expect(await gateway.status()).toEqual({});
  });

  it("counts the idle time from the last prompt, resource and completion request", async () => {
    const store = storeOn(openDatabase());
    addServer(store);
    const host = fakeHost();
    const gateway = createGateway(store, host, { idleStopMs: TEN_MINUTES_MS });

    const prompts = await gateway.listPrompts();
    await vi.advanceTimersByTimeAsync(300_000);
    await gateway.getPrompt(prompts[0]!.opaqueId, {});
    await vi.advanceTimersByTimeAsync(300_000);
    const resources = await gateway.listResources();
    await gateway.readResource(resources[0]!.opaqueId);
    await vi.advanceTimersByTimeAsync(300_000);
    await gateway.complete({ pluginId: PLUGIN_ID, serverId: SERVER_ID, type: "ref/prompt", name: "greeting" }, { name: "name", value: "B" });
    await vi.advanceTimersByTimeAsync(599_999);
    expect(host.close).toHaveBeenCalledTimes(0);

    await vi.advanceTimersByTimeAsync(1);
    expect(host.close).toHaveBeenCalledTimes(1);
  });

  it("never stops a server when the idle time is 0", async () => {
    const store = storeOn(openDatabase());
    addServer(store);
    const host = fakeHost();
    const gateway = createGateway(store, host, { idleStopMs: 0 });

    const tools = await gateway.listTools();
    await gateway.call(tools[0]!.opaqueId, {});
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);

    expect(host.close).toHaveBeenCalledTimes(0);
    expect(serverRecord(store).status).toBe("ready");
    // With stopping off the catalog still follows its five-minute TTL.
    await gateway.listTools();
    expect(host.refresh).toHaveBeenCalledTimes(1);
  });

  it("applies a changed idle time to servers that are already running", async () => {
    const store = storeOn(openDatabase());
    addServer(store);
    const host = fakeHost();
    const gateway = createGateway(store, host, { idleStopMs: 0 });

    await gateway.listTools();
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(host.close).toHaveBeenCalledTimes(0);

    gateway.setIdleStopMs(60_000);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(host.close).toHaveBeenCalledTimes(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(host.close).toHaveBeenCalledTimes(1);
  });

  it("starts a stopped server again on the next call and returns the normal result", async () => {
    const store = storeOn(openDatabase());
    addServer(store);
    const host = fakeHost();
    const gateway = createGateway(store, host, { idleStopMs: TEN_MINUTES_MS });

    const tools = await gateway.listTools();
    await vi.advanceTimersByTimeAsync(TEN_MINUTES_MS);
    expect(host.close).toHaveBeenCalledTimes(1);
    expect(host.start).toHaveBeenCalledTimes(1);

    const result = await gateway.call(tools[0]!.opaqueId, { value: "hello" });

    expect(result).toEqual({ content: [{ type: "text", text: "isolated" }] });
    expect(host.start).toHaveBeenCalledTimes(2);
    expect(host.callTool).toHaveBeenCalledTimes(1);
    expect(host.callTool.mock.calls[0]!.slice(0, 3)).toEqual(["idle-plugin:sleepy", "echo", { value: "hello" }]);
    expect(serverRecord(store).status).toBe("ready");
  });

  it("serves the catalog of a stopped server without starting it, also past the catalog TTL", async () => {
    const store = storeOn(openDatabase());
    addServer(store);
    const host = fakeHost();
    const gateway = createGateway(store, host, { idleStopMs: TEN_MINUTES_MS });

    const first = await gateway.listTools();
    await vi.advanceTimersByTimeAsync(TEN_MINUTES_MS);
    expect(host.close).toHaveBeenCalledTimes(1);

    // 30 more minutes: six catalog TTLs have passed since the last refresh.
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    const tools = await gateway.listTools();
    const prompts = await gateway.listPrompts();
    const resources = await gateway.listResources();

    expect(tools.map((tool) => tool.name)).toEqual(["echo"]);
    expect(tools[0]!.opaqueId).toBe(first[0]!.opaqueId);
    expect(tools[0]!.status).toBe("ready");
    expect(prompts.map((prompt) => prompt.name)).toEqual(["greeting"]);
    expect(resources.map((resource) => resource.uri)).toEqual(["fixture://readme"]);
    expect(host.start).toHaveBeenCalledTimes(1);
    expect(host.refresh).toHaveBeenCalledTimes(0);
    expect(serverRecord(store).status).toBe("idle");
  });

  it("refreshes the catalog by TTL only while the server is running", async () => {
    const store = storeOn(openDatabase());
    addServer(store);
    const host = fakeHost();
    const gateway = createGateway(store, host, { idleStopMs: TEN_MINUTES_MS });

    await gateway.listTools();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await gateway.listTools();

    expect(host.refresh).toHaveBeenCalledTimes(1);
    expect(host.start).toHaveBeenCalledTimes(1);
    expect(host.close).toHaveBeenCalledTimes(0);
  });

  it("starts a stopped server to rebuild the catalog when its configuration changed", async () => {
    const store = storeOn(openDatabase());
    addServer(store);
    const host = fakeHost();
    const gateway = createGateway(store, host, { idleStopMs: TEN_MINUTES_MS });

    await gateway.listTools();
    await vi.advanceTimersByTimeAsync(TEN_MINUTES_MS);
    expect(host.start).toHaveBeenCalledTimes(1);

    // The reconfigured server reports another tool, on start and on refresh alike.
    host.start.mockImplementation(async () => catalogWith("shout"));
    host.refresh.mockImplementation(async () => catalogWith("shout"));
    store.upsertMcpServer({ ...serverRecord(store), configJson: JSON.stringify({ type: "stdio", command: "node", args: ["--v2"] }) });
    const tools = await gateway.listTools();

    expect(tools.map((tool) => tool.name)).toEqual(["shout"]);
    expect(host.start).toHaveBeenCalledTimes(2);
    expect((host.start.mock.calls[1]![0] as McpStdioConfig).args).toEqual(["--v2"]);
  });

  it("does not start a server with a saved catalog after a restart until it is used", async () => {
    const database = openDatabase();
    const store = storeOn(database);
    addServer(store);
    const firstHost = fakeHost();
    const firstGateway = createGateway(store, firstHost, { idleStopMs: TEN_MINUTES_MS });
    const before = await firstGateway.listTools();
    expect(serverRecord(store).status).toBe("ready");
    await firstGateway.close();

    // A new BB process: new store object and gateway over the same data.db.
    const restartedStore = storeOn(database);
    const secondHost = fakeHost();
    const secondGateway = createGateway(restartedStore, secondHost, { idleStopMs: TEN_MINUTES_MS });

    expect(serverRecord(restartedStore).status).toBe("idle");
    const tools = await secondGateway.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(["echo"]);
    expect(tools[0]!.opaqueId).toBe(before[0]!.opaqueId);
    expect(tools[0]!.inputSchema).toEqual({ type: "object" });
    expect(secondHost.start).toHaveBeenCalledTimes(0);

    const result = await secondGateway.call(tools[0]!.opaqueId, {});
    expect(result).toEqual({ content: [{ type: "text", text: "isolated" }] });
    expect(secondHost.start).toHaveBeenCalledTimes(1);
    expect(serverRecord(restartedStore).status).toBe("ready");
  });

  it("starts a server after a restart when no catalog was saved for it", async () => {
    const store = storeOn(openDatabase());
    addServer(store);
    const host = fakeHost();
    const gateway = createGateway(store, host, { idleStopMs: TEN_MINUTES_MS });

    const tools = await gateway.listTools();

    expect(tools.map((tool) => tool.name)).toEqual(["echo"]);
    expect(host.start).toHaveBeenCalledTimes(1);
  });

  it("keeps a server running while a call is in flight and counts idle time from its end", async () => {
    const store = storeOn(openDatabase());
    addServer(store);
    const host = fakeHost();
    const gateway = createGateway(store, host, { idleStopMs: TEN_MINUTES_MS });
    let finishCall!: (value: unknown) => void;
    host.callTool.mockImplementation(() => new Promise((resolve) => { finishCall = resolve; }));

    const tools = await gateway.listTools();
    const call = gateway.call(tools[0]!.opaqueId, {});
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(host.callTool).toHaveBeenCalledTimes(1);
    expect(host.close).toHaveBeenCalledTimes(0);
    expect(serverRecord(store).status).toBe("ready");

    finishCall({ content: [{ type: "text", text: "slow" }] });
    expect(await call).toEqual({ content: [{ type: "text", text: "slow" }] });

    await vi.advanceTimersByTimeAsync(599_999);
    expect(host.close).toHaveBeenCalledTimes(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(host.close).toHaveBeenCalledTimes(1);
  });

  it("keeps a server with a resource subscription running until it is unsubscribed", async () => {
    const store = storeOn(openDatabase());
    addServer(store);
    const host = fakeHost();
    const gateway = createGateway(store, host, { idleStopMs: TEN_MINUTES_MS });

    const resources = await gateway.listResources();
    await gateway.subscribeResource(resources[0]!.opaqueId);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(host.close).toHaveBeenCalledTimes(0);

    await gateway.unsubscribeResource(resources[0]!.opaqueId);
    await vi.advanceTimersByTimeAsync(TEN_MINUTES_MS);
    expect(host.close).toHaveBeenCalledTimes(1);
  });

  it("forgets the saved catalog when the server is closed explicitly", async () => {
    const store = storeOn(openDatabase());
    addServer(store);
    const host = fakeHost();
    const gateway = createGateway(store, host, { idleStopMs: TEN_MINUTES_MS });

    await gateway.listTools();
    await gateway.closeServer(PLUGIN_ID, SERVER_ID);
    expect(store.getMcpCatalog(PLUGIN_ID, SERVER_ID)).toBeUndefined();

    await gateway.listTools();
    expect(host.start).toHaveBeenCalledTimes(2);
  });
});

describe("McpGateway connect timeout", () => {
  it("waits for a server that needs 20 seconds to start", async () => {
    const store = storeOn(openDatabase());
    addServer(store);
    const host = fakeHost();
    host.start.mockImplementation(() => new Promise((resolve) => { setTimeout(() => resolve(catalogWith("convert")), 20_000); }));
    const gateway = createGateway(store, host, { connectTimeoutMs: 60_000 });

    const listing = gateway.listTools();
    await vi.advanceTimersByTimeAsync(20_000);

    expect((await listing).map((tool) => tool.name)).toEqual(["convert"]);
    expect(serverRecord(store).status).toBe("ready");
    expect((host.start.mock.calls[0]![0] as McpStdioConfig).connectTimeoutMs).toBe(60_000);
  });

  it("reports a start that exceeds the limit as a timeout, not a cancellation", async () => {
    const store = storeOn(openDatabase());
    addServer(store);
    const host = fakeHost();
    host.start.mockImplementation(() => new Promise(() => {}));
    const gateway = createGateway(store, host, { connectTimeoutMs: 60_000 });

    let failure: unknown;
    const starting = gateway.startServer(PLUGIN_ID, SERVER_ID).catch((error) => { failure = error; });
    await vi.advanceTimersByTimeAsync(59_999);
    expect(failure).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await starting;

    expect((failure as Error).message).toBe("start isolated MCP sleepy timed out after 60000ms");
    expect(serverRecord(store)).toMatchObject({ status: "error", lastError: "start isolated MCP sleepy timed out after 60000ms" });
  });

  it("allows 60 seconds by default", async () => {
    const store = storeOn(openDatabase());
    addServer(store);
    const host = fakeHost();
    host.start.mockImplementation(() => new Promise(() => {}));
    const gateway = createGateway(store, host);

    let failure: unknown;
    const starting = gateway.startServer(PLUGIN_ID, SERVER_ID).catch((error) => { failure = error; });
    await vi.advanceTimersByTimeAsync(59_999);
    expect(failure).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await starting;

    expect((failure as Error).message).toBe("start isolated MCP sleepy timed out after 60000ms");
  });
});
