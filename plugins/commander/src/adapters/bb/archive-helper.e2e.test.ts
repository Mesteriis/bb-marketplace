import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { Endpoint } from "../../core/model.ts";
import { parsePosix } from "../../core/path.ts";
import { ArchiveHelperClient, type HelperProcess } from "./archive-helper.ts";
import { checkHelperIntegrity } from "./archive-helper-integrity.ts";
import { ArchiveProvider } from "./archive-provider.ts";
import { storedZip } from "./testing/zip-fixture.ts";

// These tests run the real helper binary (macOS arm64 only) against ZIPs built byte by byte.
const BIN = join(dirname(fileURLToPath(import.meta.url)), "../../../bin/commander-archive-helper");
const runnable = process.platform === "darwin" && process.arch === "arm64" && existsSync(BIN);
const ENDPOINT: Endpoint = {
  id: "archive:123e4567-e89b-42d3-a456-426614174000", provider: "archive", label: "a.zip", machine: "server",
  hostId: null, readOnly: true, caseSensitive: true,
};
const signal = new AbortController().signal;
const dirs: string[] = [];
const clients: ArchiveHelperClient[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

async function start() {
  const client = new ArchiveHelperClient({
    binPath: BIN, helperVersion: "0.1.0", platform: process.platform, arch: process.arch,
    spawn: (command, args, options) => spawn(command, args, { ...options, stdio: ["pipe", "pipe", "pipe"] }) as unknown as HelperProcess,
    integrity: checkHelperIntegrity, requestTimeoutMs: 20_000,
  });
  clients.push(client);
  await client.start();
  return client;
}

async function openZip(client: ArchiveHelperClient, entries: Parameters<typeof storedZip>[0]) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "commander-e2e-")));
  dirs.push(dir);
  const file = join(dir, "a.zip");
  writeFileSync(file, storedZip(entries));
  const stat = statSync(file, { bigint: true });
  const b64 = (s: string) => Buffer.from(s).toString("base64");
  const opened = await client.request({
    t: "open", rootB64: b64(dir), segmentsB64: [b64("a.zip")], format: "auto",
    limits: { maxTotalBytes: 10 * 2 ** 30, maxEntries: 100_000, maxRatio: 100 },
    expect: { size: String(stat.size), mtimeNs: String(stat.mtimeNs), dev: String(stat.dev), ino: String(stat.ino) },
  });
  return { dir, file, opened };
}

describe.skipIf(!runnable)("the real helper", () => {
  it("passes its own checksum file and reports its version", async () => {
    expect(checkHelperIntegrity(BIN)).toEqual({ ok: true });
    const client = await start();
    expect(client).toBeDefined();
  });

  it("lists, reads and confirms entries of a ZIP through ArchiveProvider", async () => {
    const client = await start();
    const { opened } = await openZip(client, [
      { name: "a.txt", data: "hello" }, { name: "dir/b.bin", data: Uint8Array.from([1, 2, 3]) }, { name: "empty.txt" },
    ]);
    expect(opened.json).toMatchObject({ format: "zip", entries: 3 });
    const provider = new ArchiveProvider({ endpoint: ENDPOINT, rpc: client, verifySource: async () => {} });
    const root = await provider.list(parsePosix("/"), { cursor: null, limit: 100 }, signal);
    expect(root.entries.map((e) => [e.name, e.kind, e.size])).toEqual([
      [{ t: "a.txt" }, "file", "5"], [{ t: "dir" }, "dir", "0"], [{ t: "empty.txt" }, "file", "0"],
    ]);
    const inner = await provider.list(parsePosix("/dir"), { cursor: null, limit: 100 }, signal);
    expect(inner.entries.map((e) => e.name)).toEqual([{ t: "b.bin" }]);
    const version = { size: "5", mtimeNs: root.entries[0]!.mtimeNs };
    expect(new TextDecoder().decode(await provider.read(parsePosix("/a.txt"), 0n, 5, version, signal))).toBe("hello");
    await provider.finishRead!(parsePosix("/a.txt"), version, signal);
    await provider.finishRead!(parsePosix("/empty.txt"), { size: "0", mtimeNs: root.entries[2]!.mtimeNs }, signal);
    expect([...await provider.read(parsePosix("/dir/b.bin"), 1n, 2, null, signal)]).toEqual([2, 3]);
  });

  it("keeps two readers of one archive apart: a window read between the chunks of a copy changes nothing", async () => {
    const client = await start();
    const a = Uint8Array.from({ length: 5000 }, (_, i) => i % 251);
    const { opened } = await openZip(client, [{ name: "a.bin", data: a }, { name: "b.txt", data: "window" }]);
    expect(opened.json).toMatchObject({ entries: 2 });
    const provider = new ArchiveProvider({ endpoint: ENDPOINT, rpc: client, verifySource: async () => {} });
    const root = await provider.list(parsePosix("/"), { cursor: null, limit: 10 }, signal);
    const versionOf = (name: string) => { const e = root.entries.find((x) => "t" in x.name && x.name.t === name)!; return { size: e.size, mtimeNs: e.mtimeNs }; };
    const copy: number[] = [];
    copy.push(...await provider.read(parsePosix("/a.bin"), 0n, 2000, versionOf("a.bin"), signal));
    expect(new TextDecoder().decode(await provider.read(parsePosix("/b.txt"), 0n, 6, versionOf("b.txt"), signal))).toBe("window");
    expect([...await provider.read(parsePosix("/a.bin"), 100n, 3, versionOf("a.bin"), signal)]).toEqual([100, 101, 102]);
    copy.push(...await provider.read(parsePosix("/a.bin"), 2000n, 3000, versionOf("a.bin"), signal));
    expect(copy).toEqual([...a]);
    await provider.finishRead!(parsePosix("/a.bin"), versionOf("a.bin"), signal);
  });

  it("refuses a ZIP with a repeated name as a whole", async () => {
    const client = await start();
    await expect(openZip(client, [{ name: "x", data: "1" }, { name: "x", data: "2" }]))
      .rejects.toMatchObject({ code: "invalid_archive", reason: "duplicate_name" });
  });

  it("detects a replaced archive file with verify", async () => {
    const client = await start();
    const { file } = await openZip(client, [{ name: "a.txt", data: "hello" }]);
    writeFileSync(file, storedZip([{ name: "a.txt", data: "HELLO!" }]));
    const verdict = await client.request({ t: "verify" });
    expect(verdict.json).toMatchObject({ changed: true });
  });
});
