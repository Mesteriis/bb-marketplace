import { describe, expect, it } from "vitest";
import { type CollectionPort, sha256Hex } from "./collection";
import { installFromCollection, removeCatalogServer, updateFromCollection, type InstallDeps } from "./install";
import {
  buildInventory,
  isNewerVersion,
  type BridgePlugin,
  type BridgePort,
  type BridgeServer,
} from "./inventory";

const NAME = "io.example/Demo";
const accepted = async () => {};
const SLUG = "io-example-demo";
const ROOT = "/data/mcp-catalog";

function plugin(extra: Partial<BridgePlugin>): BridgePlugin {
  return { id: "p1", name: "x", version: "1.0.0", sourceIntent: "git:x", status: "ready", lastError: null, ...extra };
}
function srv(extra: Partial<BridgeServer>): BridgeServer {
  return { pluginId: "p1", serverId: "s", type: "stdio", status: "ready", lastError: null, approved: 1, enabled: 0, ...extra };
}

async function collection(version = "1.0.0"): Promise<CollectionPort> {
  const serverText = JSON.stringify({
    name: NAME,
    description: "d",
    version,
    packages: [{ registryType: "npm", identifier: "demo", version, transport: { type: "stdio" } }],
  });
  const entry = {
    name: NAME,
    version,
    serverJsonSha256: await sha256Hex(serverText),
    choice: { kind: "package", index: 0 },
    acceptedAt: "2026-11-26T00:00:00Z",
  };
  const dir = `mcp-collection/${SLUG}`;
  const files: Record<string, string> = {
    [`${dir}/server.json`]: serverText,
    [`${dir}/review.md`]: "r",
    [`${dir}/entry.json`]: JSON.stringify(entry),
  };
  return {
    readIndex: async () => ({ servers: [{ name: NAME, version, path: dir }] }),
    readFile: async (path) => files[path] ?? "",
    isAccepted: async () => true,
  };
}

function fakes(existing: { plugins?: BridgePlugin[]; servers?: BridgeServer[] } = {}) {
  const calls: string[] = [];
  const bridge: BridgePort = {
    list: async () => existing.plugins ?? [],
    show: async (id) => ({ mcpServers: (existing.servers ?? []).filter((s) => s.pluginId === id) }),
    install: async (path) => {
      calls.push(`bridge.install ${path}`);
      return { id: "new" };
    },
    update: async (id) => void calls.push(`bridge.update ${id}`),
    remove: async (id) => void calls.push(`bridge.remove ${id}`),
    approve: async () => {},
    auth: async () => ({}),
    setEnabled: async () => {},
    toolCounts: async () => ({}),
  };
  const stored: Record<string, string> = {};
  const deps = async (version = "1.0.0"): Promise<InstallDeps> => ({
    bridge,
    collection: await collection(version),
    catalogRoot: ROOT,
    secrets: {
      state: async () => ({}),
      write: async (slug, values) => {
        calls.push(`secrets.write ${slug}`);
        for (const [k, v] of Object.entries(values)) if (v !== "") stored[k] = v;
      },
      clear: async () => {},
      remove: async (slug) => void calls.push(`secrets.remove ${slug}`),
      path: (slug) => `${ROOT}/env/${slug}.env`,
    },
    packages: {
      write: async (slug, files) => {
        calls.push(`packages.write ${slug} ${Object.keys(files).sort().join(",")}`);
        return `${ROOT}/packages/${slug}`;
      },
      remove: async (slug) => void calls.push(`packages.remove ${slug}`),
    },
  });
  return { calls, stored, deps };
}

describe("buildInventory", () => {
  it("marks catalog, infra and other origins and normalises flags", () => {
    const rows = buildInventory(
      [
        plugin({ id: "a", sourceIntent: `path:${ROOT}/packages/one` }),
        plugin({ id: "b", sourceIntent: "path:/repo/bb-mcp-packages/two" }),
        plugin({ id: "c", sourceIntent: "github:o/r" }),
      ],
      [srv({ pluginId: "a", approved: 1, enabled: 1 }), srv({ pluginId: "b" }), srv({ pluginId: "c" }), srv({ pluginId: "zz" })],
      ROOT,
    );
    expect(rows.map((r) => r.origin)).toEqual(["catalog", "infra", "other"]);
    expect(rows[0]).toMatchObject({ enabled: true, approved: true });
    expect(rows[1]).toMatchObject({ enabled: false });
  });

  it("reports updateAvailable for catalog rows only", () => {
    const index = { servers: [{ name: NAME, version: "2.0.0", path: "p" }] };
    const rows = buildInventory(
      [
        plugin({ id: "a", sourceIntent: `path:${ROOT}/packages/x` }),
        plugin({ id: "b", sourceIntent: "path:/r/bb-mcp-packages/x" }),
      ],
      [srv({ pluginId: "a", serverId: SLUG }), srv({ pluginId: "b", serverId: SLUG })],
      ROOT,
      index,
    );
    expect(rows.map((r) => r.updateAvailable)).toEqual(["2.0.0", null]);
    const down = buildInventory([plugin({ id: "a", sourceIntent: `path:${ROOT}/packages/x`, version: "3.0.0" })], [srv({ pluginId: "a", serverId: SLUG })], ROOT, index);
    expect(down[0]?.updateAvailable).toBeNull();
    const same = buildInventory([plugin({ id: "a", sourceIntent: `path:${ROOT}/packages/x`, version: "2.0.0" })], [srv({ pluginId: "a", serverId: SLUG })], ROOT, index);
    expect(same[0]?.updateAvailable).toBeNull();
  });
});

describe("isNewerVersion", () => {
  it("compares numerically with prerelease below release", () => {
    expect(isNewerVersion("1.10.0", "1.9.0")).toBe(true);
    expect(isNewerVersion("1.0.0", "1.0.0-rc.1")).toBe(true);
    expect(isNewerVersion("1.0.0-rc.1", "1.0.0")).toBe(false);
    expect(isNewerVersion("1.0.0-rc.2", "1.0.0-rc.10")).toBe(false);
    expect(isNewerVersion("1.0.0", "1.0.0")).toBe(false);
    expect(isNewerVersion("latest", "1.0.0")).toBe(false);
  });
});

describe("installFromCollection", () => {
  it("writes secrets, generates and writes the package, then installs, in order", async () => {
    const f = fakes();
    const result = await installFromCollection(await f.deps(), NAME, { TOKEN: "t" }, accepted);
    expect(result).toEqual({ pluginId: "new", needsApproval: true });
    expect(f.calls).toEqual([
      `secrets.write ${SLUG}`,
      `packages.write ${SLUG} bin/run.sh,bin/shim.py,mcp.json,plugin.json`,
      `bridge.install ${ROOT}/packages/${SLUG}`,
    ]);
  });

  it("keeps the previous value when a retry passes an empty string", async () => {
    const f = fakes();
    await installFromCollection(await f.deps(), NAME, { TOKEN: "t" }, accepted);
    await installFromCollection(await f.deps(), NAME, { TOKEN: "" }, accepted);
    expect(f.stored).toEqual({ TOKEN: "t" });
  });

  it("refuses a name taken by an infra package and does not install", async () => {
    const f = fakes({
      plugins: [plugin({ id: "i", name: "other", sourceIntent: "path:/r/bb-mcp-packages/x" })],
      servers: [srv({ pluginId: "i", serverId: SLUG })],
    });
    await expect(installFromCollection(await f.deps(), NAME, {}, accepted)).rejects.toThrow("сервер с таким именем уже стоит");
    expect(f.calls).toEqual([]);
  });

  it("refuses a plugin already named mcp-<slug>", async () => {
    const f = fakes({ plugins: [plugin({ name: `mcp-${SLUG}` })] });
    await expect(installFromCollection(await f.deps(), NAME, {}, accepted)).rejects.toThrow("сервер с таким именем уже стоит");
    expect(f.calls).toEqual([]);
  });

  it("keeps owner secrets and removes only the package when bridge.install fails", async () => {
    const f = fakes();
    await installFromCollection(await f.deps(), NAME, { TOKEN: "t" }, accepted);
    f.calls.length = 0;
    const deps = await f.deps();
    const realInstall = deps.bridge.install;
    deps.bridge.install = async () => {
      throw new Error("boom");
    };
    await expect(installFromCollection(deps, NAME, { TOKEN: "" }, accepted)).rejects.toThrow("boom");
    expect(f.calls).toEqual([
      `secrets.write ${SLUG}`,
      `packages.write ${SLUG} bin/run.sh,bin/shim.py,mcp.json,plugin.json`,
      `packages.remove ${SLUG}`,
    ]);
    expect(f.stored).toEqual({ TOKEN: "t" });
    deps.bridge.install = realInstall;
    await installFromCollection(await f.deps(), NAME, { TOKEN: "" }, accepted);
    expect(f.stored).toEqual({ TOKEN: "t" });
  });

  it("removes the package, not secrets, when packages.write fails", async () => {
    const f = fakes();
    const deps = await f.deps();
    deps.packages.write = async () => {
      throw new Error("disk");
    };
    await expect(installFromCollection(deps, NAME, { TOKEN: "t" }, accepted)).rejects.toThrow("disk");
    expect(f.calls).toEqual([`secrets.write ${SLUG}`, `packages.remove ${SLUG}`]);
  });

  it("writes nothing when the entry is not accepted", async () => {
    const f = fakes();
    const refuse = async () => {
      throw new Error("запись не принята в этом каталоге");
    };
    await expect(installFromCollection(await f.deps(), NAME, { TOKEN: "t" }, refuse)).rejects.toThrow("не принята");
    expect(f.calls).toEqual([]);
  });

  it("removes the package when secrets.write fails", async () => {
    const f = fakes();
    const deps = await f.deps();
    deps.secrets.write = async () => {
      throw new Error("denied");
    };
    await expect(installFromCollection(deps, NAME, {}, accepted)).rejects.toThrow("denied");
    expect(f.calls).toEqual([`packages.remove ${SLUG}`]);
  });
});

const catalogPlugin = plugin({ id: "p1", name: `mcp-${SLUG}`, sourceIntent: `path:${ROOT}/packages/${SLUG}` });

describe("removeCatalogServer", () => {
  it("removes plugin, package and secrets for a catalog plugin", async () => {
    const f = fakes({ plugins: [catalogPlugin] });
    await removeCatalogServer(await f.deps(), "p1");
    expect(f.calls).toEqual(["bridge.remove p1", `packages.remove ${SLUG}`, `secrets.remove ${SLUG}`]);
  });

  it("refuses an infra plugin", async () => {
    const f = fakes({ plugins: [plugin({ id: "p1", sourceIntent: "path:/r/bb-mcp-packages/x" })] });
    await expect(removeCatalogServer(await f.deps(), "p1")).rejects.toThrow("серверы из infra удаляются в infra");
    expect(f.calls).toEqual([]);
  });

  it("refuses a plugin whose path slug is not clean, without calling ports", async () => {
    const f = fakes({ plugins: [plugin({ id: "p1", sourceIntent: `path:${ROOT}/packages/../x` })] });
    await expect(removeCatalogServer(await f.deps(), "p1")).rejects.toThrow("недопустимое имя сервера");
    expect(f.calls).toEqual([]);
  });

  it("refuses an unknown plugin id", async () => {
    const f = fakes();
    await expect(removeCatalogServer(await f.deps(), "nope")).rejects.toThrow();
    expect(f.calls).toEqual([]);
  });
});

describe("updateFromCollection", () => {
  it("regenerates the package and updates the bridge without touching secrets", async () => {
    const f = fakes({ plugins: [catalogPlugin] });
    await updateFromCollection(await f.deps("2.0.0"), "p1", accepted);
    expect(f.calls).toEqual([
      `packages.write ${SLUG} bin/run.sh,bin/shim.py,mcp.json,plugin.json`,
      "bridge.update p1",
    ]);
  });

  it("writes nothing when the newer entry is not accepted", async () => {
    const f = fakes({ plugins: [catalogPlugin] });
    const refuse = async () => {
      throw new Error("запись не принята в этом каталоге");
    };
    await expect(updateFromCollection(await f.deps("2.0.0"), "p1", refuse)).rejects.toThrow("не принята");
    expect(f.calls).toEqual([]);
  });

  it("refuses when the collection version is not newer", async () => {
    const f = fakes({ plugins: [catalogPlugin] });
    await expect(updateFromCollection(await f.deps("1.0.0"), "p1", accepted)).rejects.toThrow("обновления нет");
    expect(f.calls).toEqual([]);
  });

  it("refuses infra and other plugins", async () => {
    const f = fakes({
      plugins: [plugin({ id: "i", sourceIntent: "path:/r/bb-mcp-packages/x" }), plugin({ id: "o" })],
    });
    await expect(updateFromCollection(await f.deps("2.0.0"), "i", accepted)).rejects.toThrow();
    await expect(updateFromCollection(await f.deps("2.0.0"), "o", accepted)).rejects.toThrow();
    expect(f.calls).toEqual([]);
  });
});
