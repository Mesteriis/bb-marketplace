import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { AgentPluginsStore } from "./store.js";
import type { PluginRecord } from "./types.js";

const databases: Database.Database[] = [];

function createStore(): AgentPluginsStore {
  const database = new Database(":memory:");
  databases.push(database);
  return new AgentPluginsStore(database, (db, statements) => {
    for (const statement of statements) db.exec(statement);
  });
}

function addPlugin(store: AgentPluginsStore): PluginRecord {
  const plugin: PluginRecord = {
    id: "plugin-1",
    name: "Example Plugin",
    version: "1.0.0",
    description: "A test plugin.",
    specVersion: "1.0.0",
    sourceType: "path",
    sourceIntent: "path:/tmp/example-plugin",
    sourceResolved: "path:/tmp/example-plugin#hash",
    sourceRef: null,
    tagPrefix: null,
    pluginRoot: "/tmp/example-plugin-root",
    pluginData: "/tmp/example-plugin-data",
    activeGen: 1,
    status: "active",
    approval: "approved",
    lastError: null,
    contentHash: "hash",
    installedAt: 1,
    updatedAt: 1,
  };
  store.upsertPlugin(plugin);
  return plugin;
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("AgentPluginsStore resource settings", () => {
  it("defaults new skills and MCP servers to enabled and persists independent toggles", () => {
    const store = createStore();
    const plugin = addPlugin(store);

    store.upsertSkill({
      pluginId: plugin.id,
      skillName: "research",
      skillDir: "skills/research",
      frontmatterJson: "{}",
      bodyHash: "skill-hash",
      materializedPath: "/tmp/skills/research",
      status: "active",
      lastError: null,
      enabled: 1,
    });
    store.upsertMcpServer({
      pluginId: plugin.id,
      serverId: "docs",
      type: "stdio",
      configJson: JSON.stringify({ type: "stdio", command: "node" }),
      status: "idle",
      lastError: null,
      approved: 0,
      enabled: 1,
    });

    expect(store.listSkills(plugin.id)[0]?.enabled).toBe(1);
    expect(store.listMcpServers(plugin.id)[0]?.enabled).toBe(1);

    expect(store.setSkillEnabled(plugin.id, "research", false)?.enabled).toBe(0);
    expect(store.setMcpEnabled(plugin.id, "docs", false)?.enabled).toBe(0);
    expect(store.listSkills(plugin.id)[0]?.enabled).toBe(0);
    expect(store.listMcpServers(plugin.id)[0]?.enabled).toBe(0);

    expect(store.setSkillEnabled(plugin.id, "research", true)?.enabled).toBe(1);
    expect(store.setMcpEnabled(plugin.id, "docs", true)?.enabled).toBe(1);
  });

  it("keeps one saved MCP catalog per server and replaces it on save", () => {
    const store = createStore();
    const plugin = addPlugin(store);

    expect(store.getMcpCatalog(plugin.id, "docs")).toBeUndefined();
    store.saveMcpCatalog({ pluginId: plugin.id, serverId: "docs", configHash: "hash-1", catalogJson: "{\"tools\":[]}", updatedAt: 100 });
    store.saveMcpCatalog({ pluginId: plugin.id, serverId: "other", configHash: "hash-9", catalogJson: "{}", updatedAt: 5 });
    store.saveMcpCatalog({ pluginId: plugin.id, serverId: "docs", configHash: "hash-2", catalogJson: "{\"tools\":[1]}", updatedAt: 200 });

    expect(store.getMcpCatalog(plugin.id, "docs")).toEqual({
      pluginId: "plugin-1",
      serverId: "docs",
      configHash: "hash-2",
      catalogJson: "{\"tools\":[1]}",
      updatedAt: 200,
    });
    expect(store.getMcpCatalog(plugin.id, "other")?.updatedAt).toBe(5);
  });

  it("drops a saved MCP catalog with its server and with its plugin", () => {
    const store = createStore();
    const plugin = addPlugin(store);
    const server = {
      pluginId: plugin.id,
      type: "stdio" as const,
      configJson: JSON.stringify({ type: "stdio", command: "node" }),
      status: "idle" as const,
      lastError: null,
      approved: 1,
      enabled: 1,
    };
    store.upsertMcpServer({ ...server, serverId: "docs" });
    store.upsertMcpServer({ ...server, serverId: "other" });
    store.saveMcpCatalog({ pluginId: plugin.id, serverId: "docs", configHash: "a", catalogJson: "{}", updatedAt: 1 });
    store.saveMcpCatalog({ pluginId: plugin.id, serverId: "other", configHash: "b", catalogJson: "{}", updatedAt: 2 });

    expect(store.deleteMcpServer(plugin.id, "docs")).toBe(true);
    expect(store.getMcpCatalog(plugin.id, "docs")).toBeUndefined();
    expect(store.getMcpCatalog(plugin.id, "other")?.configHash).toBe("b");

    expect(store.deleteMcpCatalog(plugin.id, "other")).toBe(true);
    expect(store.deleteMcpCatalog(plugin.id, "other")).toBe(false);

    store.saveMcpCatalog({ pluginId: plugin.id, serverId: "other", configHash: "b", catalogJson: "{}", updatedAt: 2 });
    expect(store.deletePlugin(plugin.id)).toBe(true);
    expect(store.getMcpCatalog(plugin.id, "other")).toBeUndefined();
  });
});
