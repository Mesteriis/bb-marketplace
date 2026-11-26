import { describe, expect, it } from "vitest";
import { type CollectionPort, serverSlug, sha256Hex } from "./collection";
import type { BridgePlugin, BridgePort, BridgeServer } from "./inventory";
import type { RegistryMeta, RegistryServer } from "./registry";
import type { CollectionWritePort, ReviewRecord, ThreadInfo, ThreadsPort } from "./review";
import { createService, type ReviewStore } from "./service";

const NAME = "io.example/Demo";
const SLUG = "io-example-demo";
const ROOT = "/data/mcp-catalog";
const SECRET = "tok-super-secret-value";

const REGISTRY_SERVER: RegistryServer = {
  name: NAME,
  description: "d",
  version: "1.0.0",
  packages: [
    {
      registryType: "npm",
      identifier: "demo",
      version: "1.0.0",
      transport: { type: "stdio" },
      environmentVariables: [
        { name: "API_KEY", description: "key", isRequired: true, isSecret: true },
        { name: "REGION", isSecret: false },
      ],
    },
  ],
};

async function collectionPort(version = "1.0.0", server: RegistryServer = REGISTRY_SERVER): Promise<CollectionPort> {
  const serverText = JSON.stringify(
    version === server.version ? server : { ...server, version, packages: server.packages?.map((pkg) => ({ ...pkg, version })) },
  );
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
    [`${dir}/review.md`]: "# Отчёт\n\nЛицензия MIT, сетевых адресов нет.\n\nВердикт: можно.",
    [`${dir}/entry.json`]: JSON.stringify(entry),
  };
  return {
    readIndex: async () => ({ servers: [{ name: NAME, version, path: dir }] }),
    readFile: async (path) => files[path] ?? "",
    isAccepted: async () => true,
  };
}

function memoryStore(initial: ReviewRecord[] = []): ReviewStore & { records: Map<string, ReviewRecord> } {
  const records = new Map(initial.map((rec) => [rec.name, rec]));
  return {
    records,
    list: async () => [...records.values()],
    put: async (rec) => void records.set(rec.name, rec),
  };
}

async function build(opts: {
  plugins?: BridgePlugin[];
  servers?: BridgeServer[];
  records?: ReviewRecord[];
  info?: ThreadInfo;
  launcher?: { ok: true } | { ok: false; message: string };
  accept?: CollectionWritePort["accept"];
  registry?: RegistryServer[];
  secretState?: Record<string, "set" | "missing">;
  toolCounts?: Record<string, number>;
  toolCountsFail?: boolean;
  collection?: CollectionPort;
  meta?: RegistryMeta[];
  /** Overrides the collection's answer to "is this accept commit on origin/main". */
  isAccepted?: (commit: string) => Promise<boolean>;
} = {}) {
  const calls: string[] = [];
  const bridge: BridgePort = {
    list: async () => opts.plugins ?? [],
    show: async (id) => ({ mcpServers: (opts.servers ?? []).filter((s) => s.pluginId === id) }),
    install: async (path) => {
      calls.push(`bridge.install ${path}`);
      return { id: "new" };
    },
    update: async () => {},
    remove: async () => {},
    approve: async () => {},
    auth: async () => ({ url: "https://auth.example/x" }),
    setEnabled: async () => {},
    toolCounts: async (known) => {
      calls.push(`toolCounts ${JSON.stringify(known)}`);
      if (opts.toolCountsFail) throw new Error("tools недоступны");
      return opts.toolCounts ?? {};
    },
  };
  const written: Record<string, string>[] = [];
  const cleared: string[][] = [];
  const store = memoryStore(opts.records);
  const threads: ThreadsPort = {
    spawnReview: async (prompt, title) => {
      calls.push(`spawn ${title}`);
      return { threadId: "thr_1" };
    },
    info: async () => opts.info ?? { status: "running" },
  };
  const write: CollectionWritePort = {
    branchHasEntry: async () => true,
    accept: opts.accept ?? (async () => ({ commit: "abc" })),
    reject: async (worktree) => void calls.push(`reject ${worktree}`),
  };
  const baseCollection = opts.collection ?? (await collectionPort());
  const collection: CollectionPort = {
    readIndex: () => baseCollection.readIndex(),
    readFile: (path) => baseCollection.readFile(path),
    isAccepted: opts.isAccepted ?? ((commit) => baseCollection.isAccepted(commit)),
  };
  const service = createService({
    bridge,
    collection,
    catalogRoot: ROOT,
    secrets: {
      state: async () => opts.secretState ?? {},
      write: async (_slug, values) => void written.push(values),
      clear: async (_slug, keys) => void cleared.push(keys),
      remove: async () => {},
      path: (slug) => `${ROOT}/env/${slug}.env`,
    },
    packages: { write: async (slug) => `${ROOT}/packages/${slug}`, remove: async () => {} },
    registry: { search: async () => ({ servers: opts.registry ?? [REGISTRY_SERVER], ...(opts.meta ? { meta: opts.meta } : {}) }) },
    threads,
    write,
    reviews: store,
    launcher: async () => opts.launcher ?? { ok: true },
    now: () => 1_000,
  });
  return { service, calls, written, cleared, store };
}

const record = (extra: Partial<ReviewRecord> = {}): ReviewRecord => ({
  name: NAME,
  version: "1.0.0",
  threadId: "thr_1",
  state: "ready",
  worktree: "/wt",
  ...extra,
});

const ACCEPT_SHA = "a".repeat(40);
/** The local record an owner's accept leaves behind: installs require it. */
const ACCEPTED = record({ state: "accepted", acceptCommit: ACCEPT_SHA });

describe("service.install", () => {
  it("returns the launcher message and writes nothing when the launcher is missing", async () => {
    const { service, written, calls } = await build({ records: [ACCEPTED], launcher: { ok: false, message: "не найден npx: поставьте Node.js" } });
    const result = await service.install({ name: NAME, values: { API_KEY: SECRET } });
    expect(result).toEqual({ ok: false, message: "не найден npx: поставьте Node.js" });
    expect(written).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("installs with declared variables", async () => {
    const { service, written } = await build({ records: [ACCEPTED] });
    const result = await service.install({ name: NAME, values: { API_KEY: SECRET } });
    expect(result).toEqual({ ok: true, pluginId: "new", needsApproval: true });
    expect(written).toEqual([{ API_KEY: SECRET }]);
  });

  it("refuses a variable the server did not declare (the env file is sourced by the launcher)", async () => {
    const { service, written } = await build({ records: [ACCEPTED] });
    await expect(service.install({ name: NAME, values: { PATH: "/evil" } })).rejects.toThrow("не объявлена");
    expect(written).toEqual([]);
  });
});

describe("service trust chain: install and update need this catalog's accept on origin/main", () => {
  const REFUSED = "запись не принята в этом каталоге";
  const installs = (b: Awaited<ReturnType<typeof build>>) => b.service.install({ name: NAME, values: { API_KEY: SECRET } });

  it("refuses an install without a local review record and writes nothing", async () => {
    const b = await build();
    await expect(installs(b)).rejects.toThrow(REFUSED);
    expect(b.written).toEqual([]);
    expect(b.calls).toEqual([]);
  });

  it("refuses a record in another state or without an accept commit", async () => {
    for (const rec of [record({ state: "ready", acceptCommit: ACCEPT_SHA }), record({ state: "accepted" })]) {
      const b = await build({ records: [rec] });
      await expect(installs(b)).rejects.toThrow(REFUSED);
      expect(b.written).toEqual([]);
    }
  });

  it("refuses a record accepted for another version", async () => {
    const b = await build({ records: [record({ state: "accepted", acceptCommit: ACCEPT_SHA, version: "0.9.0" })] });
    await expect(installs(b)).rejects.toThrow(REFUSED);
    expect(b.written).toEqual([]);
  });

  it("refuses when the accept commit is not on origin/main", async () => {
    const seen: string[] = [];
    const b = await build({ records: [ACCEPTED], isAccepted: async (commit) => (seen.push(commit), false) });
    await expect(installs(b)).rejects.toThrow(REFUSED);
    expect(seen).toContain(ACCEPT_SHA);
    expect(b.written).toEqual([]);
    expect(b.calls).toEqual([]);
  });

  it("installs a genuinely accepted entry", async () => {
    const b = await build({ records: [ACCEPTED] });
    expect(await installs(b)).toEqual({ ok: true, pluginId: "new", needsApproval: true });
  });

  it("update proceeds only for an accepted newer version", async () => {
    const v2 = await collectionPort("2.0.0");
    const refused = await build({ plugins: [CATALOG_PLUGIN], collection: v2, records: [ACCEPTED] });
    await expect(refused.service.update({ pluginId: "pc" })).rejects.toThrow(REFUSED);
    const offMain = await build({
      plugins: [CATALOG_PLUGIN],
      collection: v2,
      records: [record({ state: "accepted", version: "2.0.0", acceptCommit: ACCEPT_SHA })],
      isAccepted: async () => false,
    });
    await expect(offMain.service.update({ pluginId: "pc" })).rejects.toThrow(REFUSED);
    const genuine = await build({
      plugins: [CATALOG_PLUGIN],
      collection: v2,
      records: [record({ state: "accepted", version: "2.0.0", acceptCommit: ACCEPT_SHA })],
    });
    await expect(genuine.service.update({ pluginId: "pc" })).resolves.toBeUndefined();
  });
});

describe("service.install variables", () => {
  const withDefaults: RegistryServer = {
    ...REGISTRY_SERVER,
    packages: REGISTRY_SERVER.packages?.map((pkg) => ({
      ...pkg,
      environmentVariables: [
        { name: "API_KEY", description: "key", isRequired: true, isSecret: true },
        { name: "REGION", isSecret: false, default: "eu-1" },
        { name: "TOKEN", isSecret: true, default: "not-for-secrets" },
      ],
    })),
  };

  it("writes the default of a non-secret variable left empty, never the default of a secret", async () => {
    const { service, written } = await build({ records: [ACCEPTED], collection: await collectionPort("1.0.0", withDefaults) });
    await service.install({ name: NAME, values: { API_KEY: SECRET, REGION: "" } });
    expect(written).toEqual([{ API_KEY: SECRET, REGION: "eu-1" }]);
  });

  it("keeps a value already set instead of the default", async () => {
    const { service, written } = await build({
      records: [ACCEPTED],
      collection: await collectionPort("1.0.0", withDefaults),
      secretState: { REGION: "set" },
    });
    await service.install({ name: NAME, values: { API_KEY: SECRET } });
    expect(written).toEqual([{ API_KEY: SECRET }]);
  });

  it("refuses a missing required variable and writes nothing", async () => {
    const { service, written, calls } = await build({ records: [ACCEPTED] });
    await expect(service.install({ name: NAME, values: { API_KEY: "" } })).rejects.toThrow("не задана обязательная переменная API_KEY");
    await expect(service.install({ name: NAME, values: {} })).rejects.toThrow("не задана обязательная переменная API_KEY");
    expect(written).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("accepts a required variable that is already set", async () => {
    const { service } = await build({ records: [ACCEPTED], secretState: { API_KEY: "set" } });
    expect(await service.install({ name: NAME, values: {} })).toMatchObject({ ok: true });
  });
});

describe("service.secretsState", () => {
  it("reports only set or missing per declared variable, absent as missing", async () => {
    const { service } = await build({ secretState: { API_KEY: "set" } });
    const result = await service.secretsState({ name: NAME });
    expect(result.variables.map((v) => [v.name, v.state])).toEqual([
      ["API_KEY", "set"],
      ["REGION", "missing"],
    ]);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });
});

describe("service reviews", () => {
  it("records a failed review with the message when the prompt cannot be built", async () => {
    const bad: RegistryServer = { ...REGISTRY_SERVER, version: "1.0.0 rm -rf" };
    const { service, store, calls } = await build({ registry: [bad] });
    const item = await service.startReview({ name: NAME, version: "1.0.0 rm -rf" });
    expect(item.state).toBe("failed");
    expect(item.error).toContain("недопустимая версия");
    expect(store.records.get(NAME)?.state).toBe("failed");
    expect(calls).toEqual([]);
  });

  it("spawns a review and stamps startedAt", async () => {
    const { service, store } = await build();
    const item = await service.startReview({ name: NAME, version: "1.0.0" });
    expect(item).toMatchObject({ state: "reviewing", threadId: "thr_1" });
    expect(store.records.get(NAME)?.startedAt).toBe(1_000);
  });

  it("refuses a second review while one is open", async () => {
    const { service } = await build({ records: [record({ state: "reviewing" })] });
    await expect(service.startReview({ name: NAME, version: "1.0.0" })).rejects.toThrow("уже идёт");
  });

  it("advances a reviewing record to ready on request and persists it", async () => {
    const { service, store } = await build({
      records: [record({ state: "reviewing", worktree: undefined })],
      info: { status: "done", worktree: "/wt", branch: "b" },
    });
    const { items } = await service.reviews();
    expect(items[0]?.state).toBe("ready");
    expect(store.records.get(NAME)).toMatchObject({ state: "ready", worktree: "/wt", branch: "b" });
  });

  it("accept pushes and marks accepted", async () => {
    let seen: unknown;
    const { service, store } = await build({
      records: [record()],
      accept: async (worktree, slug, opts) => {
        seen = [worktree, slug, opts];
        return { commit: "c1" };
      },
    });
    await service.accept({ name: NAME });
    expect(seen).toEqual(["/wt", SLUG, { push: true, acceptedCommit: undefined, expected: REGISTRY_SERVER }]);
    expect(store.records.get(NAME)).toMatchObject({ state: "accepted", acceptCommit: "c1" });
  });

  it("accept refetches the reviewed version from the registry and refuses when it is gone", async () => {
    let called = false;
    const { service, store } = await build({
      records: [record()],
      registry: [{ ...REGISTRY_SERVER, version: "2.0.0" }],
      accept: async () => {
        called = true;
        return { commit: "c1" };
      },
    });
    await expect(service.accept({ name: NAME })).rejects.toThrow("такой версии сервера нет в реестре");
    expect(called).toBe(false);
    expect(store.records.get(NAME)?.state).toBe("ready");
  });

  it("re-accepting a newer version moves the record to it, and the update then goes through", async () => {
    const v2: RegistryServer = { ...REGISTRY_SERVER, version: "2.0.0", packages: REGISTRY_SERVER.packages?.map((pkg) => ({ ...pkg, version: "2.0.0" })) };
    let expected: unknown;
    const b = await build({
      plugins: [CATALOG_PLUGIN],
      records: [ACCEPTED],
      registry: [REGISTRY_SERVER, v2],
      info: { status: "done", worktree: "/wt2", branch: "b2" },
      collection: await collectionPort("2.0.0", REGISTRY_SERVER),
      accept: async (_w, _s, opts) => {
        expected = opts.expected;
        return { commit: "b".repeat(40) };
      },
    });
    await expect(b.service.update({ pluginId: "pc" })).rejects.toThrow("запись не принята в этом каталоге");
    expect((await b.service.startReview({ name: NAME, version: "2.0.0" })).state).toBe("reviewing");
    expect((await b.service.reviews()).items[0]?.state).toBe("ready");
    await b.service.accept({ name: NAME });
    expect(expected).toEqual(v2);
    expect(b.store.records.get(NAME)).toMatchObject({ state: "accepted", version: "2.0.0", acceptCommit: "b".repeat(40) });
    await expect(b.service.update({ pluginId: "pc" })).resolves.toBeUndefined();
  });

  it("keeps the accept commit from a failed accept so that a retry reuses it", async () => {
    let attempt = 0;
    const seen: unknown[] = [];
    const { service, store } = await build({
      records: [record()],
      accept: async (_w, _s, opts) => {
        seen.push(opts.acceptedCommit);
        if (attempt++ === 0) throw Object.assign(new Error("push failed"), { acceptCommit: "c9" });
        return { commit: "c9" };
      },
    });
    await expect(service.accept({ name: NAME })).rejects.toThrow("push failed");
    expect(store.records.get(NAME)).toMatchObject({ state: "ready", acceptCommit: "c9" });
    await service.accept({ name: NAME });
    expect(seen).toEqual([undefined, "c9"]);
    expect(store.records.get(NAME)?.state).toBe("accepted");
  });

  it("refuses to accept a review that is not ready", async () => {
    const { service } = await build({ records: [record({ state: "reviewing" })] });
    await expect(service.accept({ name: NAME })).rejects.toThrow("закончена");
  });

  it("reject records the rejection", async () => {
    const { service, store, calls } = await build({ records: [record()] });
    await service.reject({ name: NAME });
    expect(calls).toEqual(["reject /wt"]);
    expect(store.records.get(NAME)?.state).toBe("rejected");
  });
});

describe("service.collection and search", () => {
  it("lists entries with a review extract and installed flag", async () => {
    const { service } = await build({ plugins: [{ id: "p", name: "mcp-io-example-demo", version: "1.0.0", sourceIntent: "x", status: "ready", lastError: null }] });
    const { items } = await service.collection();
    expect(items).toEqual([
      { name: NAME, version: "1.0.0", summary: "Лицензия MIT, сетевых адресов нет.", error: null, installed: true },
    ]);
  });

  it("marks search results installed and in the collection", async () => {
    const { service } = await build({ plugins: [{ id: "p", name: "mcp-io-example-demo", version: "1.0.0", sourceIntent: "x", status: "ready", lastError: null }] });
    const result = await service.search({ query: "demo" });
    expect(result.items[0]).toMatchObject({ name: NAME, installed: true, inCollection: true, latestVersion: "1.0.0" });
    expect(result.items[0]?.versions[0]?.sources).toEqual(["npm"]);
  });
});

const CATALOG_PLUGIN: BridgePlugin = {
  id: "pc",
  name: "mcp-io-example-demo",
  version: "1.0.0",
  sourceIntent: `path:${ROOT}/packages/${SLUG}`,
  status: "active",
  lastError: null,
};

describe("one fetch per request", () => {
  async function countingCollection(names: string[]) {
    const files: Record<string, string> = {};
    const servers: { name: string; version: string; path: string }[] = [];
    for (const name of names) {
      const slug = serverSlug(name);
      const dir = `mcp-collection/${slug}`;
      const text = JSON.stringify({ ...REGISTRY_SERVER, name });
      files[`${dir}/server.json`] = text;
      files[`${dir}/review.md`] = "Отчёт";
      files[`${dir}/entry.json`] = JSON.stringify({
        name,
        version: "1.0.0",
        serverJsonSha256: await sha256Hex(text),
        choice: { kind: "package", index: 0 },
        acceptedAt: "2026-11-26T00:00:00Z",
      });
      servers.push({ name, version: "1.0.0", path: dir });
    }
    let reads = 0;
    const port: CollectionPort = {
      readIndex: async () => {
        reads++;
        return { servers };
      },
      readFile: async (path) => files[path] ?? "",
      isAccepted: async () => true,
    };
    return { port, reads: () => reads };
  }

  it("collection() with three entries reads the index once", async () => {
    const counting = await countingCollection(["a/one", "a/two", "a/three"]);
    const { service } = await build({ collection: counting.port });
    const { items } = await service.collection();
    expect(items).toHaveLength(3);
    expect(items.every((item) => item.error === null)).toBe(true);
    expect(counting.reads()).toBe(1);
  });
});

describe("service.setSecrets", () => {
  it("writes typed values, clears the listed keys and returns nothing", async () => {
    const { service, written, cleared } = await build({ plugins: [CATALOG_PLUGIN] });
    const result = await service.setSecrets({ pluginId: "pc", values: { API_KEY: SECRET }, clear: ["REGION"] });
    expect(result).toBeUndefined();
    expect(written).toEqual([{ API_KEY: SECRET }]);
    expect(cleared).toEqual([["REGION"]]);
  });

  it("refuses an infra plugin and writes nothing", async () => {
    const infra: BridgePlugin = { ...CATALOG_PLUGIN, id: "pi", sourceIntent: "path:/x/bb-mcp-packages/demo" };
    const { service, written, cleared } = await build({ plugins: [infra] });
    await expect(service.setSecrets({ pluginId: "pi", values: { API_KEY: "x" }, clear: [] })).rejects.toThrow("infra");
    expect(written).toEqual([]);
    expect(cleared).toEqual([]);
  });

  it("refuses an undeclared key, in values or in clear", async () => {
    const { service, written, cleared } = await build({ plugins: [CATALOG_PLUGIN] });
    await expect(service.setSecrets({ pluginId: "pc", values: { PATH: "/evil" }, clear: [] })).rejects.toThrow("не объявлена");
    await expect(service.setSecrets({ pluginId: "pc", values: {}, clear: ["PATH"] })).rejects.toThrow("не объявлена");
    expect(written).toEqual([]);
    expect(cleared).toEqual([]);
  });

  it("refuses a key that is both typed and cleared", async () => {
    const { service } = await build({ plugins: [CATALOG_PLUGIN] });
    await expect(service.setSecrets({ pluginId: "pc", values: { API_KEY: "x" }, clear: ["API_KEY"] })).rejects.toThrow("одновременно");
  });

  it("secretsState by plugin id reports only set or missing", async () => {
    const { service } = await build({ plugins: [CATALOG_PLUGIN], secretState: { API_KEY: "set" } });
    const result = await service.secretsState({ pluginId: "pc" });
    expect(result.variables.map((v) => [v.name, v.state])).toEqual([
      ["API_KEY", "set"],
      ["REGION", "missing"],
    ]);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });
});

describe("service.inventory tool counts", () => {
  const server: BridgeServer = { pluginId: "pc", serverId: SLUG, type: "stdio", status: "running", lastError: null, approved: 1, enabled: 1 };

  it("puts the per-server tool count on each row from one listing", async () => {
    const { service, calls } = await build({ plugins: [CATALOG_PLUGIN], servers: [server], toolCounts: { [`pc/${SLUG}`]: 7 } });
    expect((await service.inventory()).rows[0]?.toolCount).toBe(7);
    expect(calls).toContain(`toolCounts ${JSON.stringify([{ pluginId: "pc", serverId: SLUG }])}`);
  });

  it("is 0 for a server with no tools and null with a warning when the listing fails", async () => {
    const empty = await build({ plugins: [CATALOG_PLUGIN], servers: [server] });
    expect((await empty.service.inventory()).rows[0]?.toolCount).toBe(0);
    const failed = await build({ plugins: [CATALOG_PLUGIN], servers: [server], toolCountsFail: true });
    const result = await failed.service.inventory();
    expect(result.rows[0]?.toolCount).toBeNull();
    expect(result.warnings.join(" ")).toContain("tools недоступны");
  });
});

describe("service.search grouping", () => {
  const v = (version: string, extra: Partial<RegistryServer> = {}): RegistryServer => ({ ...REGISTRY_SERVER, version, ...extra });

  it("returns one row per name with the latest version, newest by semver without isLatest", async () => {
    const { service } = await build({ registry: [v("1.2.0"), v("1.10.0"), v("1.9.0"), { ...v("0.1.0"), name: "other/srv" }] });
    const { items } = await service.search({ query: "demo" });
    expect(items.map((item) => item.name)).toEqual([NAME, "other/srv"]);
    expect(items[0]).toMatchObject({ latestVersion: "1.10.0" });
    expect(items[0]?.versions.map((x) => x.version)).toEqual(["1.10.0", "1.9.0", "1.2.0"]);
  });

  it("prefers the version the registry marks isLatest and carries publishedAt", async () => {
    const { service } = await build({
      registry: [v("1.0.0"), v("2.0.0")],
      meta: [
        { publishedAt: "2026-01-01T00:00:00Z", isLatest: true },
        { publishedAt: "2026-02-01T00:00:00Z" },
      ],
    });
    const [item] = (await service.search({ query: "demo" })).items;
    expect(item?.latestVersion).toBe("1.0.0");
    expect(item?.versions.find((x) => x.version === "1.0.0")?.publishedAt).toBe("2026-01-01T00:00:00Z");
    expect(item?.versions.find((x) => x.version === "2.0.0")?.publishedAt).toBe("2026-02-01T00:00:00Z");
  });

  it("marks a name with a review in progress", async () => {
    const { service } = await build({ records: [record({ state: "reviewing" })] });
    const [item] = (await service.search({ query: "demo" })).items;
    expect(item?.reviewing).toBe(true);
  });
});
