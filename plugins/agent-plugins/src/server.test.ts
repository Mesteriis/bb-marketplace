import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { rimraf } from "./safe-fs.js";

const hosts: Array<ReturnType<typeof createFakePluginHost>> = [];
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.harness.lifecycle.dispose()));
  while (tempDirs.length > 0) await rimraf(tempDirs.pop()!);
});

describe("Agent Plugins update flow", () => {
  it("keeps the installed identity, data path, and disabled skill state across an update", async () => {
    const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-plugins-data-"));
    const source = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-plugins-source-"));
    tempDirs.push(dataDir, source);
    await writePlugin(source, "1.0.0", "first version");

    const host = createFakePluginHost({
      pluginId: "agent-plugins",
      sdk: { system: { config: async () => ({ dataDir }) } },
    });
    hosts.push(host);
    await plugin(host.bb);

    const installed = (await host.harness.callRpc("install", { source: `path:${source}` })) as { id: string };
    const before = (await host.harness.callRpc("snapshot", null)) as Snapshot;
    const beforePlugin = before.plugins[0]!;
    expect(beforePlugin.id).toBe(installed.id);

    await host.harness.callRpc("setSkillEnabled", {
      id: installed.id,
      skillName: "research",
      enabled: false,
    });
    await fsp.writeFile(path.join(source, "plugin.json"), JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: "example-plugin",
      version: "1.1.0",
      description: "updated",
    }));
    await fsp.writeFile(path.join(source, "skills", "research", "SKILL.md"), [
      "---",
      "name: research",
      "description: Research updated sources.",
      "---",
      "second version",
      "",
    ].join("\n"));

    const updated = (await host.harness.callRpc("update", { id: installed.id })) as { id: string; version: string | null };
    const after = (await host.harness.callRpc("snapshot", null)) as Snapshot;
    const afterPlugin = after.plugins[0]!;
    const afterSkill = after.skills.find((skill) => skill.skillName === "research")!;

    expect(updated).toMatchObject({ id: installed.id, version: "1.1.0" });
    expect(afterPlugin).toMatchObject({
      id: installed.id,
      version: "1.1.0",
      pluginData: beforePlugin.pluginData,
      installedAt: beforePlugin.installedAt,
    });
    expect(afterPlugin.pluginRoot).not.toBe(beforePlugin.pluginRoot);
    expect(afterSkill.enabled).toBe(false);
    expect(afterSkill.materializedPath).toBeNull();
  });

  it("reports a tracked local source as outdated without installing it", async () => {
    const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-plugins-data-"));
    const source = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-plugins-source-"));
    tempDirs.push(dataDir, source);
    await writePlugin(source, "1.0.0", "first version");

    const host = createFakePluginHost({
      pluginId: "agent-plugins",
      sdk: { system: { config: async () => ({ dataDir }) } },
    });
    hosts.push(host);
    await plugin(host.bb);

    const installed = (await host.harness.callRpc("install", { source: `path:${source}` })) as { id: string };
    await fsp.writeFile(path.join(source, "plugin.json"), JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: "example-plugin",
      version: "1.1.0",
    }));

    const result = (await host.harness.callRpc("checkUpdates", { id: installed.id })) as { updates: Array<{ available: boolean; latestVersion: string | null }> };
    expect(result.updates).toEqual([expect.objectContaining({ available: true, latestVersion: "1.1.0" })]);
  });

  it("queues page-wide update checks for the background worker", async () => {
    const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-plugins-data-"));
    const source = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-plugins-source-"));
    tempDirs.push(dataDir, source);
    await writePlugin(source, "1.0.0", "first version");

    const host = createFakePluginHost({
      pluginId: "agent-plugins",
      sdk: { system: { config: async () => ({ dataDir }) } },
    });
    hosts.push(host);
    await plugin(host.bb);
    const installed = (await host.harness.callRpc("install", { source: `path:${source}` })) as { id: string };
    await fsp.writeFile(path.join(source, "plugin.json"), JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: "example-plugin",
      version: "1.1.0",
    }));

    const queued = (await host.harness.callRpc("checkUpdates", {})) as { updates: unknown[] };
    expect(queued.updates).toEqual([]);
    const service = host.harness.behavior.runService("update-checker");
    const result = (await host.harness.callRpc("checkUpdates", { id: installed.id })) as { updates: Array<{ available: boolean; latestVersion: string | null }> };
    expect(result.updates).toEqual([expect.objectContaining({ available: true, latestVersion: "1.1.0" })]);
    service.controller.abort();
    await service.done;
  });
});

describe("Agent Plugins MCP runtime settings", () => {
  it("declares the idle stop and connect timeout settings with their defaults", async () => {
    const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-plugins-data-"));
    tempDirs.push(dataDir);
    const host = createFakePluginHost({ pluginId: "agent-plugins", sdk: { system: { config: async () => ({ dataDir }) } } });
    hosts.push(host);
    await plugin(host.bb);

    const descriptors = host.harness.registrations.settingsDescriptors;
    expect(descriptors.mcpIdleStopMinutes).toMatchObject({ type: "string", default: "10" });
    expect(descriptors.mcpConnectTimeoutSeconds).toMatchObject({ type: "string", default: "60" });
    expect(descriptors.oauthCredentials).toMatchObject({ type: "string", secret: true });
  });

  it("stops an idle stdio server, keeps listing its tools, and starts it again for a call", async () => {
    const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-plugins-data-"));
    const source = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-plugins-source-"));
    tempDirs.push(dataDir, source);
    await writePlugin(source, "1.0.0", "first version");
    await fsp.writeFile(path.join(source, "mcp.json"), JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
      mcpServers: { docs: { type: "stdio", command: "node" } },
    }));

    const calls: Array<{ method: string; input: unknown }> = [];
    const count = (method: string) => calls.filter((call) => call.method === method).length;
    const host = createFakePluginHost({
      pluginId: "agent-plugins",
      // 0.005 minutes = 300 ms, so the test observes a real stop without fake timers.
      settings: { mcpIdleStopMinutes: "0.005", mcpConnectTimeoutSeconds: "120" },
      sdk: { system: { config: async () => ({ dataDir, primaryHostId: "host-1" }) } },
      experimental_callHostRpc: ({ method, input }) => {
        calls.push({ method, input });
        if (method === "start" || method === "refresh") {
          return { tools: [{ name: "search", description: "Search docs", inputSchema: { type: "object" } }], prompts: [], resources: [], resourceTemplates: [] };
        }
        if (method === "close") return { closed: true };
        if (method === "callTool") return { content: [{ type: "text", text: "found" }] };
        throw new Error(`unexpected host call ${method}`);
      },
    });
    hosts.push(host);
    await plugin(host.bb);

    const installed = (await host.harness.callRpc("install", { source: `path:${source}` })) as { id: string };
    await host.harness.callRpc("approve", { id: installed.id, serverId: "docs" });
    expect(count("start")).toBe(1);
    expect((calls.find((call) => call.method === "start")!.input as { connectTimeoutMs?: number }).connectTimeoutMs).toBe(120_000);

    await waitFor(() => count("close") === 1);
    const stopped = (await host.harness.callRpc("snapshot", null)) as { mcpServers: Array<Record<string, unknown>> };
    expect(stopped.mcpServers[0]).toMatchObject({ serverId: "docs", status: "idle", approved: 1, enabled: true });

    const listed = (await host.harness.callRpc("listTools", null)) as { tools: Array<{ opaqueId: string; name: string }> };
    expect(listed.tools.map((tool) => tool.name)).toEqual(["search"]);
    expect(count("start")).toBe(1);

    const result = await host.harness.callRpc("callTool", { opaqueId: listed.tools[0]!.opaqueId, args: {} });
    expect(result).toEqual({ content: [{ type: "text", text: "found" }] });
    expect(count("start")).toBe(2);

    // Turning the setting off applies to the server that is now running.
    await host.harness.setSettings({ mcpIdleStopMinutes: "0" });
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(count("close")).toBe(1);
  }, 15_000);
});

describe("Agent Plugins CLI enable and disable", () => {
  async function setup() {
    const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-plugins-data-"));
    const source = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-plugins-source-"));
    tempDirs.push(dataDir, source);
    await writePlugin(source, "1.0.0", "first version");
    await fsp.writeFile(path.join(source, "mcp.json"), JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
      mcpServers: { docs: { type: "stdio", command: "node" } },
    }));
    const host = createFakePluginHost({
      pluginId: "agent-plugins",
      sdk: { system: { config: async () => ({ dataDir, primaryHostId: "host-1" }) } },
      experimental_callHostRpc: ({ method }) => {
        if (method === "start" || method === "refresh") {
          return { tools: [{ name: "search", description: "Search docs", inputSchema: { type: "object" } }], prompts: [], resources: [], resourceTemplates: [] };
        }
        if (method === "close") return { closed: true };
        throw new Error(`unexpected host call ${method}`);
      },
    });
    hosts.push(host);
    await plugin(host.bb);
    const installed = (await host.harness.callRpc("install", { source: `path:${source}` })) as { id: string };
    await host.harness.callRpc("approve", { id: installed.id, serverId: "docs" });
    // The registered bb.cli object is the CLI entry point; the harness has no separate runner.
    const run = (argv: string[]) => host.harness.registrations.cli!.run(argv, {} as never) as Promise<{ exitCode: number; stdout?: string; stderr?: string }>;
    return { host, id: installed.id, run };
  }

  it("disables and enables an MCP server from the CLI", async () => {
    const { host, id, run } = await setup();
    const enabledOf = async () => ((await host.harness.callRpc("snapshot", null)) as { mcpServers: Array<{ enabled: boolean }> }).mcpServers[0]!.enabled;

    const off = await run(["disable", id, "docs", "--json"]);
    expect(off.exitCode).toBe(0);
    expect(JSON.parse(off.stdout!)).toMatchObject({ enabled: false });
    expect(await enabledOf()).toBe(false);

    const on = await run(["enable", id, "docs", "--json"]);
    expect(on.exitCode).toBe(0);
    expect(JSON.parse(on.stdout!)).toMatchObject({ enabled: true });
    expect(await enabledOf()).toBe(true);
  });

  it("exits 2 with usage when the server id is missing", async () => {
    const { id, run } = await setup();
    const result = await run(["disable", id]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Usage: bb agent-plugins enable|disable <id> <serverId> [--json]");
  });

  it("exits 1 with the error text when the server does not exist", async () => {
    const { id, run } = await setup();
    const result = await run(["enable", id, "missing"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBeTruthy();
  });
});

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition was not met in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function writePlugin(source: string, version: string, body: string): Promise<void> {
  await fsp.mkdir(path.join(source, "skills", "research"), { recursive: true });
  await fsp.writeFile(path.join(source, "plugin.json"), JSON.stringify({
    $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
    name: "example-plugin",
    version,
    description: "Example plugin",
  }));
  await fsp.writeFile(path.join(source, "skills", "research", "SKILL.md"), [
    "---",
    "name: research",
    "description: Research sources.",
    "---",
    body,
    "",
  ].join("\n"));
}

type Snapshot = {
  plugins: Array<Record<string, unknown>>;
  skills: Array<Record<string, unknown>>;
};
