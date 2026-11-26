import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RuntimeStore, resolveRuntime } from "./runtime-store.ts";

const roots: string[] = [];
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "gw-store-"));
  roots.push(d);
  return d;
};
afterEach(() => {
  for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true });
});

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]));
}

/** A runtime tree as build-runtime.ts writes it. */
function makeRuntime(parent: string, version: string, platform = "darwin-arm64"): string {
  const dir = join(parent, `gitwand-runtime-${version}-${platform}`);
  mkdirSync(join(dir, "bin"), { recursive: true });
  mkdirSync(join(dir, "ui/assets"), { recursive: true });
  writeFileSync(join(dir, "bin/gitwand-bridge"), "#!/bin/sh\n");
  chmodSync(join(dir, "bin/gitwand-bridge"), 0o755);
  writeFileSync(join(dir, "ui/index.html"), "<html></html>");
  writeFileSync(join(dir, "ui/assets/a.js"), "x");
  writeFileSync(join(dir, "runtime.json"), JSON.stringify({ version, gitwandTag: "v3.14.0", commit: "c".repeat(40), platform, protocol: 1, generated: 336, adapted: 5, pluginCommands: [] }));
  const lines = files(dir)
    .map((f) => `${createHash("sha256").update(readFileSync(f)).digest("hex")}  ${relative(dir, f)}`)
    .sort((a, b) => (a.slice(66) < b.slice(66) ? -1 : 1));
  writeFileSync(join(dir, "MANIFEST.sha256"), lines.join("\n") + "\n");
  return dir;
}

function makeArchive(version: string): { bytes: Buffer; sha256: string } {
  const src = temp();
  makeRuntime(src, version);
  const out = join(temp(), "a.tar.gz");
  execFileSync("tar", ["-czf", out, "-C", src, `gitwand-runtime-${version}-darwin-arm64`]);
  const bytes = readFileSync(out);
  return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
}

const fetchOf = (bytes: Buffer): typeof fetch => (async () => new Response(new Uint8Array(bytes))) as typeof fetch;

describe("RuntimeStore.verify", () => {
  it("reads a runtime whose files match its manifest", async () => {
    const dir = makeRuntime(temp(), "3.14.0+bb1");
    const store = new RuntimeStore({ root: temp(), platform: "darwin-arm64" });
    expect(await store.verify(dir)).toEqual({
      dir,
      version: "3.14.0+bb1",
      commit: "c".repeat(40),
      bin: join(dir, "bin/gitwand-bridge"),
      uiDir: join(dir, "ui"),
    });
  });

  it.each([
    ["a changed file", (d: string) => writeFileSync(join(d, "ui/assets/a.js"), "y"), "ui/assets/a.js does not match MANIFEST.sha256"],
    ["a missing file", (d: string) => rmSync(join(d, "ui/index.html")), "ui/index.html is missing"],
    ["an unlisted file", (d: string) => writeFileSync(join(d, "ui/extra.js"), "z"), "ui/extra.js is not in MANIFEST.sha256"],
    ["a symlink", (d: string) => { rmSync(join(d, "ui/assets/a.js")); execFileSync("ln", ["-s", "/etc/hosts", join(d, "ui/assets/a.js")]); }, "ui/assets/a.js is not a regular file"],
    ["a manifest path that leaves the runtime", (d: string) => writeFileSync(join(d, "MANIFEST.sha256"), `${"a".repeat(64)}  ../x\n`), "MANIFEST.sha256 names an unsafe path: ../x"],
  ])("refuses %s", async (_name, damage, message) => {
    const dir = makeRuntime(temp(), "3.14.0+bb1");
    damage(dir);
    await expect(new RuntimeStore({ root: temp(), platform: "darwin-arm64" }).verify(dir)).rejects.toThrow(message);
  });

  it("refuses a runtime built for another platform", async () => {
    const dir = makeRuntime(temp(), "3.14.0+bb1", "linux-x64");
    await expect(new RuntimeStore({ root: temp(), platform: "darwin-arm64" }).verify(dir)).rejects.toThrow("runtime is built for linux-x64, this host is darwin-arm64");
  });
});

describe("RuntimeStore.install and rollback", () => {
  it("downloads, checks, smoke-tests and switches to a new build, keeping the old one as previous", async () => {
    const root = temp();
    const smoked: string[] = [];
    const one = makeArchive("3.14.0+bb1");
    const store = new RuntimeStore({ root, platform: "darwin-arm64", fetch: fetchOf(one.bytes), smoke: async (rt) => void smoked.push(rt.version) });
    await store.install({ version: "3.14.0+bb1", url: "https://x/1", sha256: one.sha256, size: one.bytes.length });
    const two = makeArchive("3.14.0+bb2");
    const store2 = new RuntimeStore({ root, platform: "darwin-arm64", fetch: fetchOf(two.bytes), smoke: async (rt) => void smoked.push(rt.version) });
    await store2.install({ version: "3.14.0+bb2", url: "https://x/2", sha256: two.sha256, size: two.bytes.length });
    expect(smoked).toEqual(["3.14.0+bb1", "3.14.0+bb2"]);
    expect((await store2.current())?.version).toBe("3.14.0+bb2");
    expect(await store2.versions()).toEqual({ current: "3.14.0+bb2", previous: "3.14.0+bb1" });
    expect(readdirSync(root).filter((n) => !n.startsWith(".") && n !== "state.json").sort()).toEqual(["3.14.0+bb1-darwin-arm64", "3.14.0+bb2-darwin-arm64"]);
  });

  it("keeps only the current and the previous build", async () => {
    const root = temp();
    for (const n of [1, 2, 3]) {
      const a = makeArchive(`3.14.0+bb${n}`);
      await new RuntimeStore({ root, platform: "darwin-arm64", fetch: fetchOf(a.bytes), smoke: async () => {} }).install({ version: `3.14.0+bb${n}`, url: "https://x", sha256: a.sha256, size: a.bytes.length });
    }
    expect(readdirSync(root).filter((n) => n.endsWith("-darwin-arm64")).sort()).toEqual(["3.14.0+bb2-darwin-arm64", "3.14.0+bb3-darwin-arm64"]);
  });

  it.each([
    ["a wrong checksum", (a: { sha256: string; bytes: Buffer }) => ({ sha256: "0".repeat(64), size: a.bytes.length }), "archive sha256 does not match"],
    ["a wrong size", (a: { sha256: string; bytes: Buffer }) => ({ sha256: a.sha256, size: a.bytes.length + 1 }), "archive is"],
  ])("leaves the current build in place on %s", async (_name, change, message) => {
    const root = temp();
    const one = makeArchive("3.14.0+bb1");
    await new RuntimeStore({ root, platform: "darwin-arm64", fetch: fetchOf(one.bytes), smoke: async () => {} }).install({ version: "3.14.0+bb1", url: "https://x", sha256: one.sha256, size: one.bytes.length });
    const two = makeArchive("3.14.0+bb2");
    const store = new RuntimeStore({ root, platform: "darwin-arm64", fetch: fetchOf(two.bytes), smoke: async () => {} });
    await expect(store.install({ version: "3.14.0+bb2", url: "https://x", ...change(two) })).rejects.toThrow(message);
    expect((await store.current())?.version).toBe("3.14.0+bb1");
    expect(readdirSync(root).filter((n) => n.startsWith(".tmp"))).toEqual([]);
  });

  it("leaves the current build in place when the new one fails its smoke test", async () => {
    const root = temp();
    const one = makeArchive("3.14.0+bb1");
    await new RuntimeStore({ root, platform: "darwin-arm64", fetch: fetchOf(one.bytes), smoke: async () => {} }).install({ version: "3.14.0+bb1", url: "https://x", sha256: one.sha256, size: one.bytes.length });
    const two = makeArchive("3.14.0+bb2");
    const store = new RuntimeStore({ root, platform: "darwin-arm64", fetch: fetchOf(two.bytes), smoke: async () => Promise.reject(new Error("git_status failed")) });
    await expect(store.install({ version: "3.14.0+bb2", url: "https://x", sha256: two.sha256, size: two.bytes.length })).rejects.toThrow("smoke test failed: git_status failed");
    expect(await store.versions()).toEqual({ current: "3.14.0+bb1", previous: null });
    expect(existsSync(join(root, "3.14.0+bb2-darwin-arm64"))).toBe(false);
  });

  it("refuses an archive whose runtime.json names another version", async () => {
    const root = temp();
    const a = makeArchive("3.14.0+bb5");
    const store = new RuntimeStore({ root, platform: "darwin-arm64", fetch: fetchOf(a.bytes), smoke: async () => {} });
    await expect(store.install({ version: "3.14.0+bb6", url: "https://x", sha256: a.sha256, size: a.bytes.length })).rejects.toThrow("archive holds 3.14.0+bb5, the channel promised 3.14.0+bb6");
  });

  it("swaps current and previous on rollback", async () => {
    const root = temp();
    for (const n of [1, 2]) {
      const a = makeArchive(`3.14.0+bb${n}`);
      await new RuntimeStore({ root, platform: "darwin-arm64", fetch: fetchOf(a.bytes), smoke: async () => {} }).install({ version: `3.14.0+bb${n}`, url: "https://x", sha256: a.sha256, size: a.bytes.length });
    }
    const store = new RuntimeStore({ root, platform: "darwin-arm64" });
    await store.rollback();
    expect(await store.versions()).toEqual({ current: "3.14.0+bb1", previous: "3.14.0+bb2" });
  });

  it("has nothing to roll back to on a single build", async () => {
    await expect(new RuntimeStore({ root: temp(), platform: "darwin-arm64" }).rollback()).rejects.toThrow("There is no previous GitWand runtime to roll back to");
  });
});

describe("resolveRuntime", () => {
  it("prefers the development runtime directory when one is set", async () => {
    const dev = makeRuntime(temp(), "3.14.0+bb1");
    const store = new RuntimeStore({ root: temp(), platform: "darwin-arm64" });
    expect(await resolveRuntime({ devDir: dev, store })).toMatchObject({ dir: dev, source: "dev", version: "3.14.0+bb1" });
  });

  it("falls back to the installed build, and to null without one", async () => {
    const store = new RuntimeStore({ root: temp(), platform: "darwin-arm64" });
    expect(await resolveRuntime({ devDir: null, store })).toBeNull();
  });
});
