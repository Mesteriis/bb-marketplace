import { spawn } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { Endpoint } from "../../core/model.ts";
import { parsePosix } from "../../core/path.ts";
import { FakeProvider } from "../../core/testing/fake-provider.ts";
import { ArchiveHelperClient, type HelperProcess } from "./archive-helper.ts";
import { checkHelperIntegrity } from "./archive-helper-integrity.ts";
import { ArchiveProvider } from "./archive-provider.ts";
import { packToStaging, publishStaging, type PackEntry } from "./archive-writer.ts";

const BIN = join(dirname(fileURLToPath(import.meta.url)), "../../../bin/commander-archive-helper");
const runnable = process.platform === "darwin" && process.arch === "arm64" && existsSync(BIN);
const ENDPOINT: Endpoint = {
  id: "archive:123e4567-e89b-42d3-a456-426614174000", provider: "archive", label: "a", machine: "server",
  hostId: null, readOnly: true, caseSensitive: true,
};
const signal = new AbortController().signal;
const dirs: string[] = [];
const clients: ArchiveHelperClient[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});
const b64 = (s: string) => Buffer.from(s).toString("base64");

async function helper() {
  const client = new ArchiveHelperClient({
    binPath: BIN, helperVersion: "0.1.0", platform: process.platform, arch: process.arch,
    spawn: (command, args, options) => spawn(command, args, { ...options, stdio: ["pipe", "pipe", "pipe"] }) as unknown as HelperProcess,
    integrity: checkHelperIntegrity, requestTimeoutMs: 20_000,
  });
  clients.push(client);
  await client.start();
  return client;
}
const tmp = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "commander-pack-")));
  dirs.push(dir);
  return dir;
};
const entry = (name: string, text: string): PackEntry => {
  const bytes = new TextEncoder().encode(text);
  return { name, kind: "file", size: BigInt(bytes.length), mtime: 1732665600, mode: 0o644, read: async (o, l) => bytes.slice(Number(o), Number(o) + l) };
};
const three = () => [entry("a.txt", "hello"), { ...entry("dir", ""), kind: "dir" as const, size: 0n }, entry("dir/b.bin", "abcdef"), entry("c.txt", "")];

async function listAfter(path: string, dir: string) {
  const client = await helper();
  const stat = statSync(path, { bigint: true });
  await client.request({
    t: "open", rootB64: b64(dir), segmentsB64: [b64(path.slice(dir.length + 1))], format: "auto",
    limits: { maxTotalBytes: 10 * 2 ** 30, maxEntries: 100_000, maxRatio: 100 },
    expect: { size: String(stat.size), mtimeNs: String(stat.mtimeNs), dev: String(stat.dev), ino: String(stat.ino) },
  });
  const provider = new ArchiveProvider({ endpoint: ENDPOINT, rpc: client, verifySource: async () => {} });
  const root = await provider.list(parsePosix("/"), { cursor: null, limit: 100 }, signal);
  const inner = await provider.list(parsePosix("/dir"), { cursor: null, limit: 100 }, signal);
  return { root: root.entries.map((e) => [e.name, e.kind, e.size]), inner: inner.entries.map((e) => [e.name, e.kind, e.size]) };
}

describe.skipIf(!runnable)("packing with the real helper", () => {
  it.each(["zip", "tar"] as const)("a %s of three files lists the same names and sizes", async (format) => {
    const dir = tmp();
    const staging = join(dir, "out." + format);
    const client = await helper();
    const result = await packToStaging(client, { format, stagingPath: staging, entries: three(), signal });
    expect(result.size).toBe(BigInt(statSync(staging).size));
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(lstatSync(staging).mode & 0o777).toBe(0o600);
    const listed = await listAfter(staging, dir);
    expect(listed.root).toEqual([[{ t: "a.txt" }, "file", "5"], [{ t: "dir" }, "dir", "0"], [{ t: "c.txt" }, "file", "0"]]);
    expect(listed.inner).toEqual([[{ t: "b.bin" }, "file", "6"]]);
  });

  it("refuses an unsafe or repeated entry name before anything is written", async () => {
    const dir = tmp();
    const client = await helper();
    for (const name of ["../x", "/abs", "a\\b"]) {
      await expect(packToStaging(client, { format: "zip", stagingPath: join(dir, "x.zip"), entries: [entry(name, "x")], signal }))
        .rejects.toMatchObject({ code: "invalid_path" });
    }
    await expect(packToStaging(client, { format: "zip", stagingPath: join(dir, "y.zip"), entries: [entry("a", "1"), entry("a", "2")], signal }))
      .rejects.toMatchObject({ code: "invalid_archive", reason: "duplicate_name" });
    expect(existsSync(join(dir, "x.zip"))).toBe(false);
    expect(existsSync(join(dir, "y.zip"))).toBe(false);
  });

  it("a source that ends early aborts the pack and removes the staging file", async () => {
    const dir = tmp();
    const client = await helper();
    const broken: PackEntry = { ...entry("a", "hello"), read: async () => new Uint8Array(0) };
    await expect(packToStaging(client, { format: "zip", stagingPath: join(dir, "z.zip"), entries: [broken], signal }))
      .rejects.toMatchObject({ code: "changed_since_plan" });
    expect(existsSync(join(dir, "z.zip"))).toBe(false);
  });

  it("an AES-256 zip needs the password to read and gives the same bytes back with it", async () => {
    const dir = tmp();
    const staging = join(dir, "enc.zip");
    const client = await helper();
    const password = () => Promise.resolve(new TextEncoder().encode("s3cret-пароль"));
    await packToStaging(client, { format: "zip", stagingPath: staging, entries: [entry("a.txt", "hello")], encryption: "aes256", password, signal });
    const reader = await helper();
    const stat = statSync(staging, { bigint: true });
    await reader.request({
      t: "open", rootB64: b64(dir), segmentsB64: [b64("enc.zip")], format: "auto",
      limits: { maxTotalBytes: 10 * 2 ** 30, maxEntries: 100_000, maxRatio: 100 },
      expect: { size: String(stat.size), mtimeNs: String(stat.mtimeNs), dev: String(stat.dev), ino: String(stat.ino) },
    });
    const withoutPassword = new ArchiveProvider({ endpoint: ENDPOINT, rpc: reader, verifySource: async () => {} });
    const root = await withoutPassword.list(parsePosix("/"), { cursor: null, limit: 10 }, signal);
    const version = { size: "5", mtimeNs: root.entries[0]!.mtimeNs };
    await expect(withoutPassword.read(parsePosix("/a.txt"), 0n, 5, version, signal)).rejects.toMatchObject({ code: "auth_failed", reason: "password_required" });
    const owner = new ArchiveProvider({ endpoint: ENDPOINT, rpc: reader, verifySource: async () => {}, password });
    expect(new TextDecoder().decode(await owner.read(parsePosix("/a.txt"), 0n, 5, version, signal))).toBe("hello");
    await owner.finishRead!(parsePosix("/a.txt"), version, signal);
    expect(readFileSync(staging).includes(Buffer.from("hello"))).toBe(false);
  });
});

describe("publishing the staging file through a WriteSession", () => {
  it("writes the temp, then commits once with replace and expectTarget; the target holds the bytes", async () => {
    const dir = tmp();
    const staging = join(dir, "s.bin");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(staging, "archive-bytes");
    const provider = new FakeProvider("host:t");
    const fingerprint = await publishStaging({
      stagingPath: staging, provider, target: parsePosix("/out.zip"), tempName: { t: ".t.part" }, replace: false, expectTarget: null, signal,
    });
    expect(provider.contents(parsePosix("/out.zip"))).toEqual(new TextEncoder().encode("archive-bytes"));
    expect(fingerprint.size).toBe("13");
    expect(provider.temporaryCount).toBe(0);
  });
  it("removes the temp when the target changed, and the commit conflict surfaces", async () => {
    const dir = tmp();
    const staging = join(dir, "s.bin");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(staging, "x");
    const provider = new FakeProvider("host:t");
    provider.put(parsePosix("/out.zip"), Uint8Array.of(1), "7");
    await expect(publishStaging({
      stagingPath: staging, provider, target: parsePosix("/out.zip"), tempName: { t: ".t.part" }, replace: true,
      expectTarget: { size: "1", mtimeNs: "8" }, signal,
    })).rejects.toMatchObject({ code: "changed_since_plan" });
    expect(provider.temporaryCount).toBe(0);
    expect(provider.contents(parsePosix("/out.zip"))).toEqual(Uint8Array.of(1));
  });
});
