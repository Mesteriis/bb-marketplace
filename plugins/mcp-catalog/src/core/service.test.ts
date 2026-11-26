import { describe, expect, it } from "vitest";
import { type CollectionPort, serverSlug, sha256Hex } from "./collection";
import type { BridgePlugin, BridgePort, BridgeServer } from "./inventory";
import type { CatalogSource } from "./catalogs";
import type { RegistryMeta, RegistryPort, RegistryServer } from "./registry";
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
  const records = new Map(initial.map((rec) => [`${rec.name}@${rec.version}`, rec]));
  return {
    records,
    list: async () => [...records.values()],
    put: async (rec) => void records.set(`${rec.name}@${rec.version}`, rec),
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
  toolsSkipped?: number;
  collection?: CollectionPort;
  meta?: RegistryMeta[];
  /** Further catalogs next to the official registry. */
  extraSources?: CatalogSource[];
  /** Replaces the registry's search, e.g. to serve pages. */
  registrySearch?: RegistryPort["search"];
  /** Overrides the collection's answer to "is this accept commit on origin/main". */
  isAccepted?: (commit: string) => Promise<boolean>;
} = {}) {
  const calls: string[] = [];
  const prompts: string[] = [];
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
      return { counts: opts.toolCounts ?? {}, skipped: opts.toolsSkipped ?? 0 };
    },
  };
  const written: Record<string, string>[] = [];
  const cleared: string[][] = [];
  const applied: { values: Record<string, string>; clear: string[] }[] = [];
  const store = memoryStore(opts.records);
  const threads: ThreadsPort = {
    spawnReview: async (prompt, title) => {
      prompts.push(prompt);
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
      apply: async (_slug, values, clear) => void applied.push({ values, clear }),
      remove: async () => {},
      path: (slug) => `${ROOT}/env/${slug}.env`,
    },
    packages: { write: async (slug) => `${ROOT}/packages/${slug}`, remove: async () => {}, read: async () => null },
    registry: {
      search:
        opts.registrySearch ??
        (async () => ({ servers: opts.registry ?? [REGISTRY_SERVER], ...(opts.meta ? { meta: opts.meta } : {}) })),
    },
    ...(opts.extraSources ? { extraSources: opts.extraSources } : {}),
    threads,
    write,
    reviews: store,
    launcher: async () => opts.launcher ?? { ok: true },
    now: () => 1_000,
  });
  return { service, calls, prompts, written, cleared, applied, store };
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
      secretState: { API_KEY: "set" },
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
    expect(store.records.get(`${NAME}@1.0.0 rm -rf`)?.state).toBe("failed");
    expect(calls).toEqual([]);
  });

  it("spawns a review and stamps startedAt", async () => {
    const { service, store } = await build();
    const item = await service.startReview({ name: NAME, version: "1.0.0" });
    expect(item).toMatchObject({ state: "reviewing", threadId: "thr_1" });
    expect(store.records.get(`${NAME}@1.0.0`)?.startedAt).toBe(1_000);
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
    expect(store.records.get(`${NAME}@1.0.0`)).toMatchObject({ state: "ready", worktree: "/wt", branch: "b" });
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
    expect(store.records.get(`${NAME}@1.0.0`)).toMatchObject({ state: "accepted", acceptCommit: "c1" });
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
    expect(store.records.get(`${NAME}@1.0.0`)?.state).toBe("ready");
  });

  it("re-accepting a newer version gets its own record next to the old one, and the update then goes through", async () => {
    const v2: RegistryServer = { ...REGISTRY_SERVER, version: "2.0.0", packages: REGISTRY_SERVER.packages?.map((pkg) => ({ ...pkg, version: "2.0.0" })) };
    let expected: unknown;
    const b = await build({
      plugins: [CATALOG_PLUGIN],
      records: [ACCEPTED],
      registry: [REGISTRY_SERVER, v2],
      info: { status: "done", worktree: "/wt2", branch: "b2" },
      collection: await collectionPort("2.0.0", REGISTRY_SERVER),
      secretState: { API_KEY: "set" },
      accept: async (_w, _s, opts) => {
        expected = opts.expected;
        return { commit: "b".repeat(40) };
      },
    });
    await expect(b.service.update({ pluginId: "pc" })).rejects.toThrow("запись не принята в этом каталоге");
    expect((await b.service.startReview({ name: NAME, version: "2.0.0" })).state).toBe("reviewing");
    expect((await b.service.reviews()).items.map((item) => [item.version, item.state])).toEqual([["1.0.0", "accepted"], ["2.0.0", "ready"]]);
    await b.service.accept({ name: NAME });
    expect(expected).toEqual(v2);
    expect(b.store.records.get(`${NAME}@1.0.0`)?.state).toBe("accepted");
    expect(b.store.records.get(`${NAME}@2.0.0`)).toMatchObject({ state: "accepted", version: "2.0.0", acceptCommit: "b".repeat(40) });
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
    expect(store.records.get(`${NAME}@1.0.0`)).toMatchObject({ state: "ready", acceptCommit: "c9" });
    await service.accept({ name: NAME });
    expect(seen).toEqual([undefined, "c9"]);
    expect(store.records.get(`${NAME}@1.0.0`)?.state).toBe("accepted");
  });

  it("refuses to accept a review that is not ready", async () => {
    const { service } = await build({ records: [record({ state: "reviewing" })] });
    await expect(service.accept({ name: NAME })).rejects.toThrow("закончена");
  });

  it("reject records the rejection", async () => {
    const { service, store, calls } = await build({ records: [record()] });
    await service.reject({ name: NAME });
    expect(calls).toEqual(["reject /wt"]);
    expect(store.records.get(`${NAME}@1.0.0`)?.state).toBe("rejected");
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
  it("applies typed values and cleared keys in one call and returns nothing", async () => {
    const { service, written, cleared, applied } = await build({ plugins: [CATALOG_PLUGIN] });
    const result = await service.setSecrets({ pluginId: "pc", values: { API_KEY: SECRET }, clear: ["REGION"] });
    expect(result).toBeUndefined();
    expect(applied).toEqual([{ values: { API_KEY: SECRET }, clear: ["REGION"] }]);
    expect(written).toEqual([]);
    expect(cleared).toEqual([]);
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

describe("service.inventory skipped tools", () => {
  it("warns how many listed tools could not be attributed", async () => {
    const server: BridgeServer = { pluginId: "pc", serverId: SLUG, type: "stdio", status: "running", lastError: null, approved: 1, enabled: 1 };
    const { service } = await build({ plugins: [CATALOG_PLUGIN], servers: [server], toolsSkipped: 3 });
    const result = await service.inventory();
    expect(result.warnings).toEqual(["инструментов, которые не удалось сопоставить с сервером: 3; в числах они не учтены"]);
    const clean = await build({ plugins: [CATALOG_PLUGIN], servers: [server] });
    expect((await clean.service.inventory()).warnings).toEqual([]);
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

  it("marks reviewing per version, and the item when any version is under review", async () => {
    const v = (version: string): RegistryServer => ({ ...REGISTRY_SERVER, version, packages: REGISTRY_SERVER.packages?.map((pkg) => ({ ...pkg, version })) });
    const { service } = await build({
      registry: [v("1.0.0"), v("2.0.0")],
      records: [record({ state: "reviewing", version: "1.0.0" }), record({ state: "reviewing", name: "other/server", version: "2.0.0" })],
    });
    const [item] = (await service.search({ query: "demo" })).items;
    expect(item?.versions.map((x) => [x.version, x.reviewing])).toEqual([
      ["2.0.0", false],
      ["1.0.0", true],
    ]);
    expect(item?.reviewing).toBe(true);
  });

  it("refuses to review a version that is already accepted and keeps its record", async () => {
    const { service, store } = await build({ records: [record({ state: "accepted", version: "1.0.0", acceptCommit: ACCEPT_SHA })] });
    await expect(service.startReview({ name: NAME, version: "1.0.0" })).rejects.toThrow("эта версия уже принята в коллекцию");
    expect(store.records.get(`${NAME}@1.0.0`)).toMatchObject({ state: "accepted", acceptCommit: ACCEPT_SHA });
  });
});

describe("review records per name and version", () => {
  const v = (version: string): RegistryServer => ({ ...REGISTRY_SERVER, version, packages: REGISTRY_SERVER.packages?.map((pkg) => ({ ...pkg, version })) });

  it("starts a review of v2 while v1 is under review, and still refuses a second review of the same version", async () => {
    const { service, store } = await build({ registry: [v("1.0.0"), v("2.0.0")], records: [record({ state: "reviewing", version: "1.0.0" })] });
    const second = await service.startReview({ name: NAME, version: "2.0.0" });
    expect(second).toMatchObject({ version: "2.0.0", state: "reviewing" });
    expect([...store.records.keys()].sort()).toEqual([`${NAME}@1.0.0`, `${NAME}@2.0.0`]);
    await expect(service.startReview({ name: NAME, version: "1.0.0" })).rejects.toThrow("уже идёт");
    await expect(service.startReview({ name: NAME, version: "2.0.0" })).rejects.toThrow("уже идёт");
  });

  it("reinstalls the accepted v1 while v2 is under review", async () => {
    const { service } = await build({
      records: [record({ state: "accepted", version: "1.0.0", acceptCommit: ACCEPT_SHA }), record({ state: "reviewing", version: "2.0.0" })],
      secretState: { API_KEY: "set" },
    });
    await expect(service.install({ name: NAME, values: {} })).resolves.toMatchObject({ ok: true });
  });

  it("accepts the version the caller names, not another review of the same server", async () => {
    const worktrees: string[] = [];
    const { service } = await build({
      registry: [v("1.0.0"), v("2.0.0")],
      records: [record({ version: "1.0.0", worktree: "/wt1" }), record({ version: "2.0.0", worktree: "/wt2" })],
      accept: async (worktree) => {
        worktrees.push(worktree);
        return { commit: "d".repeat(40) };
      },
    });
    await service.accept({ name: NAME, version: "2.0.0" });
    expect(worktrees).toEqual(["/wt2"]);
  });

  it("without a version, accepts the newest review that is ready and rejects the right one", async () => {
    const accepted: string[] = [];
    const { service, calls } = await build({
      registry: [v("1.0.0"), v("2.0.0")],
      records: [
        record({ version: "1.0.0", worktree: "/wt1" }),
        record({ version: "2.0.0", worktree: "/wt2" }),
        record({ version: "3.0.0", worktree: "/wt3", state: "reviewing" }),
      ],
      accept: async (worktree) => {
        accepted.push(worktree);
        return { commit: "d".repeat(40) };
      },
    });
    await service.accept({ name: NAME });
    expect(accepted).toEqual(["/wt2"]);
    await service.reject({ name: NAME, version: "1.0.0" });
    expect(calls).toContain("reject /wt1");
  });

  it("an update needs the accepted record of exactly that version", async () => {
    const v2 = await collectionPort("2.0.0");
    const { service } = await build({
      plugins: [CATALOG_PLUGIN],
      collection: v2,
      records: [record({ state: "accepted", version: "1.0.0", acceptCommit: ACCEPT_SHA })],
    });
    await expect(service.update({ pluginId: "pc" })).rejects.toThrow("запись не принята в этом каталоге");
  });
});

describe("startReview registry paging", () => {
  const server = (version: string): RegistryServer => ({ ...REGISTRY_SERVER, version, packages: REGISTRY_SERVER.packages?.map((pkg) => ({ ...pkg, version })) });

  it("follows nextCursor beyond three pages until the version is found", async () => {
    const asked: (string | undefined)[] = [];
    const { service } = await build({
      registrySearch: async (_query, cursor) => {
        asked.push(cursor);
        const page = cursor === undefined ? 0 : Number(cursor);
        return page === 6 ? { servers: [server("1.0.0")] } : { servers: [server(`9.${page}.0`)], nextCursor: String(page + 1) };
      },
    });
    const item = await service.startReview({ name: NAME, version: "1.0.0" });
    expect(item.state).toBe("reviewing");
    expect(asked).toEqual([undefined, "1", "2", "3", "4", "5", "6"]);
  });

  it("stops at the end of the cursor with a clear error", async () => {
    let calls = 0;
    const { service } = await build({
      registrySearch: async (_query, cursor) => {
        calls++;
        return cursor === undefined ? { servers: [server("9.0.0")], nextCursor: "1" } : { servers: [server("9.1.0")] };
      },
    });
    await expect(service.startReview({ name: NAME, version: "1.0.0" })).rejects.toThrow("такой версии сервера нет в реестре");
    expect(calls).toBe(2);
  });

  it("gives up after 20 pages with an error that says so", async () => {
    let calls = 0;
    const { service } = await build({
      registrySearch: async () => {
        calls++;
        return { servers: [server("9.0.0")], nextCursor: `c${calls}` };
      },
    });
    await expect(service.startReview({ name: NAME, version: "1.0.0" })).rejects.toThrow("не найдена в первых 20 страницах реестра");
    expect(calls).toBe(20);
  });
});

describe("service catalogs", () => {
  it("search items carry the catalogs and no unsupported reason by default", async () => {
    const { service } = await build();
    const [item] = (await service.search({ query: "demo" })).items;
    expect(item?.catalogs).toEqual(["official"]);
    expect(item?.unsupported).toBeNull();
  });

  it("search merges the same server from GitHub into one item with both labels", async () => {
    const github: CatalogSource = { id: "github", port: { search: async () => ({ servers: [REGISTRY_SERVER] }) } };
    const { service } = await build({ extraSources: [github] });
    const result = await service.search({ query: "demo" });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.catalogs).toEqual(["official", "github"]);
  });

  it("search honours the enabled catalogs", async () => {
    const github: CatalogSource = { id: "github", port: { search: async () => ({ servers: [{ ...REGISTRY_SERVER, name: "io.example/gh-only" }] }) } };
    const { service } = await build({ extraSources: [github] });
    const result = await service.search({ query: "demo", catalogs: ["github"] });
    expect(result.items.map((item) => item.name)).toEqual(["io.example/gh-only"]);
  });

  it("search joins a catalog failure with the collection warning", async () => {
    const github: CatalogSource = {
      id: "github",
      port: {
        search: async () => {
          throw new Error("реестр MCP недоступен: 500");
        },
      },
    };
    const collection = await collectionPort();
    const { service } = await build({ extraSources: [github], collection: { ...collection, readIndex: async () => { throw new Error("нет сети"); } } });
    const { warning } = await service.search({ query: "demo" });
    expect(warning).toBe("«GitHub»: реестр MCP недоступен: 500; коллекция недоступна, пометки «в коллекции» нет: нет сети");
  });

  it("search item carries the unsupported reason", async () => {
    const { service } = await build({ meta: [{ unsupported: "нужен Docker Desktop" }] });
    const [item] = (await service.search({ query: "demo" })).items;
    expect(item?.unsupported).toBe("нужен Docker Desktop");
  });

  it("each version carries its own unsupported reason", async () => {
    const v2 = { ...REGISTRY_SERVER, version: "2.0.0" };
    const { service } = await build({ registry: [REGISTRY_SERVER, v2], meta: [{ unsupported: "старая" }, { isLatest: true }] });
    const [item] = (await service.search({ query: "demo" })).items;
    expect(item?.versions.map((v) => [v.version, v.unsupported])).toEqual([["2.0.0", null], ["1.0.0", "старая"]]);
    expect(item?.unsupported).toBeNull();
  });

  it("startReview refuses an unsupported server", async () => {
    const { service, calls } = await build({ meta: [{ unsupported: "нужен Docker Desktop" }] });
    await expect(service.startReview({ name: NAME, version: "1.0.0" })).rejects.toThrow("не поддерживается: нужен Docker Desktop");
    expect(calls.some((call) => call.startsWith("spawn"))).toBe(false);
  });
});

describe("service docker records", () => {
  const DIGEST = `sha256:${"ab".repeat(32)}`;
  const DOCKER_NAME = "com.docker.mcp/brave";
  const dockerServer: RegistryServer = {
    name: DOCKER_NAME,
    description: "d",
    version: "sha256-abababababab",
    packages: [{ registryType: "oci", identifier: "mcp/brave", version: DIGEST, transport: { type: "stdio" } }],
  };
  const docker = (record: { unsupported?: string; allowHosts?: string[] } = {}): CatalogSource => ({
    id: "docker",
    port: { search: async () => ({ servers: [dockerServer] }) },
    lookup: async () => ({ server: dockerServer, ...record }),
  });

  it("startReview of a docker record puts the digest and allowHosts in the prompt", async () => {
    const { service, prompts } = await build({ extraSources: [docker({ allowHosts: ["api.search.example:443"] })] });
    await service.startReview({ name: DOCKER_NAME, version: "sha256-abababababab" });
    expect(prompts[0]).toContain(`ociDigest для entry.json: ${DIGEST}`);
    expect(prompts[0]).toContain("Сеть: allowHosts api.search.example:443 — каталог Docker это не применяет, отрази в review.md");
  });

  it("startReview of a docker record without allowHosts has no network line", async () => {
    const { service, prompts } = await build({ extraSources: [docker()] });
    await service.startReview({ name: DOCKER_NAME, version: "sha256-abababababab" });
    expect(prompts[0]).toContain(`ociDigest для entry.json: ${DIGEST}`);
    expect(prompts[0]).not.toContain("Сеть:");
  });

  it("startReview refuses an unsupported docker record", async () => {
    const { service, calls } = await build({ extraSources: [docker({ unsupported: "нужны тома (volumes)" })] });
    await expect(service.startReview({ name: DOCKER_NAME, version: "sha256-abababababab" })).rejects.toThrow(
      "не поддерживается: нужны тома (volumes)",
    );
    expect(calls.some((call) => call.startsWith("spawn"))).toBe(false);
  });

  it("a non-docker review prompt carries no docker hints", async () => {
    const { service, prompts } = await build();
    await service.startReview({ name: NAME, version: "1.0.0" });
    expect(prompts[0]).not.toContain("ociDigest для entry.json");
  });

  it("accept without a version takes the most recently started docker record", async () => {
    const accepted: string[] = [];
    const old = record({ name: DOCKER_NAME, version: "sha256-bbbbbbbbbbbb", worktree: "/wtOld", startedAt: 1 });
    const fresh = record({ name: DOCKER_NAME, version: "sha256-aaaaaaaaaaaa", worktree: "/wtNew", startedAt: 2 });
    const { service } = await build({
      records: [old, fresh],
      extraSources: [{ ...docker(), lookup: async () => ({ server: dockerServer }) }],
      accept: async (worktree) => {
        accepted.push(worktree);
        return { commit: "abc" };
      },
    });
    await service.accept({ name: DOCKER_NAME });
    expect(accepted).toEqual(["/wtNew"]);
  });
});
