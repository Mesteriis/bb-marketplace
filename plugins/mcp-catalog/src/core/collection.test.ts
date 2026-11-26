import { describe, expect, it } from "vitest";
import { CollectionEntryDraft, canonicalJson, loadAcceptedEntry, sha256Hex, type CollectionPort } from "./collection";

const NAME = "io.example/Demo Server";
const serverText = JSON.stringify({ name: NAME, description: "d", version: "1.0.0" }, null, 2) + "\n";

async function fakePort(
  serverJson: string,
  opts: { path?: string; entryOverride?: object; entryRaw?: string; dropFile?: string } = {},
): Promise<CollectionPort & { reads: string[] }> {
  const entry = {
    name: NAME,
    version: "1.0.0",
    serverJsonSha256: await sha256Hex(serverText),
    choice: { kind: "package", index: 0 },
    acceptedAt: "2026-11-26T00:00:00Z",
    ...opts.entryOverride,
  };
  const files: Record<string, string> = {
    "mcp-collection/io-example-demo-server/server.json": serverJson,
    "mcp-collection/io-example-demo-server/review.md": "# review\n",
    "mcp-collection/io-example-demo-server/entry.json": opts.entryRaw ?? JSON.stringify(entry),
  };
  if (opts.dropFile) delete files[`mcp-collection/io-example-demo-server/${opts.dropFile}`];
  const reads: string[] = [];
  return {
    reads,
    readIndex: async () => ({
      servers: [{ name: NAME, version: "1.0.0", path: opts.path ?? "mcp-collection/io-example-demo-server" }],
    }),
    readFile: async (path) => {
      reads.push(path);
      const text = files[path];
      if (text === undefined) throw new Error(`no file ${path}`);
      return text;
    },
    isAccepted: async () => true,
    sameEntryAt: async () => true,
  };
}

describe("sha256Hex", () => {
  it("hashes text as hex", async () => {
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("loadAcceptedEntry docker field", () => {
  const ociText = JSON.stringify({ name: NAME, description: "d", version: "1.0.0", packages: [{ registryType: "oci", identifier: "a/b", transport: { type: "stdio" } }] });
  const load = async (serverJson: string, docker: unknown) =>
    loadAcceptedEntry(await fakePort(serverJson, { entryOverride: { docker, serverJsonSha256: await sha256Hex(serverJson) } }), NAME);

  it("accepts a valid docker field for an OCI choice", async () => {
    expect((await load(ociText, { network: "bridge", user: "image" })).entry.docker).toEqual({ network: "bridge", user: "image" });
  });

  it("rejects docker with a non-OCI choice", async () => {
    const npmText = JSON.stringify({ name: NAME, description: "d", version: "1.0.0", packages: [{ registryType: "npm", identifier: "x", version: "1.0.0", transport: { type: "stdio" } }] });
    await expect(load(npmText, { network: "bridge" })).rejects.toThrow("поле docker допустимо только для образа OCI");
  });

  it("rejects a forbidden environment variable of the chosen OCI package", async () => {
    const bad = JSON.stringify({ name: NAME, description: "d", version: "1.0.0", packages: [{ registryType: "oci", identifier: "a/b", transport: { type: "stdio" }, environmentVariables: [{ name: "DOCKER_HOST" }] }] });
    await expect(load(bad, undefined)).rejects.toThrow("переменная «DOCKER_HOST» запрещена для образа OCI: она меняет запуск docker");
  });

  it.each([[{ network: "host" }], [{ user: "root" }], [{ privileged: true }]])("rejects invalid docker %j", async (docker) => {
    await expect(load(ociText, docker)).rejects.toThrow();
  });
});

describe("loadAcceptedEntry", () => {
  it("loads a good entry", async () => {
    const loaded = await loadAcceptedEntry(await fakePort(serverText), NAME);
    expect(loaded.server.name).toBe(NAME);
    expect(loaded.entry.version).toBe("1.0.0");
    expect(loaded.review).toBe("# review\n");
  });

  it("rejects a modified server.json", async () => {
    const port = await fakePort(serverText.replace("1.0.0", "1.0.1"));
    await expect(loadAcceptedEntry(port, NAME)).rejects.toThrow(
      "запись коллекции повреждена: хэш server.json не совпадает",
    );
  });

  it("rejects a name missing from the index", async () => {
    await expect(loadAcceptedEntry(await fakePort(serverText), "io.example/other")).rejects.toThrow(
      "сервера нет в коллекции",
    );
  });

  it.each(["mcp-collection/../plugins/x", "/etc"])("rejects index path %s without reading", async (path) => {
    const port = await fakePort(serverText, { path });
    await expect(loadAcceptedEntry(port, NAME)).rejects.toThrow("запись коллекции повреждена: неверный путь");
    expect(port.reads).toEqual([]);
  });

  it.each([{ name: "io.example/other" }, { version: "2.0.0" }])(
    "rejects entry.json that disagrees with the index %j",
    async (entryOverride) => {
      const port = await fakePort(serverText, { entryOverride });
      await expect(loadAcceptedEntry(port, NAME)).rejects.toThrow(
        "запись коллекции повреждена: entry.json не совпадает с индексом",
      );
    },
  );

  it.each([{ name: "io.example/other" }, { version: "9.9.9" }])(
    "rejects a server.json whose %j disagrees with entry.json, even with a matching hash",
    async (over) => {
      const text = JSON.stringify({ name: NAME, description: "d", version: "1.0.0", ...over });
      const port = await fakePort(text, { entryOverride: { serverJsonSha256: await sha256Hex(text) } });
      await expect(loadAcceptedEntry(port, NAME)).rejects.toThrow(
        "запись коллекции повреждена: server.json не совпадает с entry.json",
      );
    },
  );

  it("rejects a malformed entry.json", async () => {
    await expect(loadAcceptedEntry(await fakePort(serverText, { entryRaw: "{not json" }), NAME)).rejects.toThrow();
    await expect(loadAcceptedEntry(await fakePort(serverText, { entryRaw: "{}" }), NAME)).rejects.toThrow();
  });

  it("rejects a missing file", async () => {
    await expect(loadAcceptedEntry(await fakePort(serverText, { dropFile: "review.md" }), NAME)).rejects.toThrow();
  });
});

describe("canonicalJson", () => {
  it("sorts keys at every depth and keeps array order", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: null } })).toBe('{"a":{"c":null,"d":[2,{"y":2,"z":1}]},"b":1}');
  });
  it("is equal for the same value written differently", () => {
    expect(canonicalJson(JSON.parse('{ "x": 1, "y": [1, 2] }'))).toBe(canonicalJson({ y: [1, 2], x: 1 }));
    expect(canonicalJson({ y: [2, 1] })).not.toBe(canonicalJson({ y: [1, 2] }));
  });
});

describe("CollectionEntryDraft", () => {
  const base = { name: "io.example/demo", version: "1.0.0", serverJsonSha256: "a".repeat(64), choice: { kind: "package", index: 0 } };
  it("treats a null ociDigest (non-OCI package) as absent", () => {
    const parsed = CollectionEntryDraft.parse({ ...base, ociDigest: null });
    expect(parsed.ociDigest).toBeUndefined();
  });
  it("keeps a real ociDigest", () => {
    expect(CollectionEntryDraft.parse({ ...base, ociDigest: `sha256:${"b".repeat(64)}` }).ociDigest).toBe(`sha256:${"b".repeat(64)}`);
  });
});
