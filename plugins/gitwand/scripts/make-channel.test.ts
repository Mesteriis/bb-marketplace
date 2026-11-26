import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseChannelManifest } from "../src/core/update-channel.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const script = new URL("./make-channel.ts", import.meta.url).pathname;
const run = (args: string[]) => execFileSync(process.execPath, [script, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

describe("make-channel.ts", () => {
  it("puts the archives under release asset names and writes a channel.json that the plugin accepts", () => {
    const src = mkdtempSync(join(tmpdir(), "gw-mc-src-"));
    const out = mkdtempSync(join(tmpdir(), "gw-mc-out-"));
    dirs.push(src, out);
    // "abc" has the well-known sha256 ba7816bf…
    writeFileSync(join(src, "gitwand-runtime-3.14.0+bb1-darwin-arm64.tar.gz"), "abc");
    const printed = run([
      "--version", "3.14.0+bb1", "--tag", "v3.14.0", "--commit", "436b9684f096e8edd35b6a36e3b4d3af0fd7e084",
      "--min-plugin", "0.1.0", "--base-url", "https://example.invalid/dl", "--out", out,
      join(src, "gitwand-runtime-3.14.0+bb1-darwin-arm64.tar.gz"),
    ]);
    expect(readdirSync(out).sort()).toEqual(["channel.json", "gitwand-runtime-3.14.0-bb1-darwin-arm64.tar.gz"]);
    expect(parseChannelManifest(readFileSync(join(out, "channel.json"), "utf8")).platforms["darwin-arm64"]).toEqual({
      url: "https://example.invalid/dl/gitwand-runtime-3.14.0-bb1-darwin-arm64.tar.gz",
      sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      size: 3,
    });
    expect(printed).toContain("channel.json: 3.14.0+bb1, 1 platform(s)");
  });

  it("fails without archives and says why", () => {
    const out = mkdtempSync(join(tmpdir(), "gw-mc-out-"));
    dirs.push(out);
    expect(() => run(["--version", "3.14.0+bb1", "--tag", "v3.14.0", "--commit", "4".repeat(40), "--min-plugin", "0.1.0", "--base-url", "https://x", "--out", out])).toThrow(/no archives/);
  });
});
