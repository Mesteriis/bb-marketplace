import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFsSourceReader } from "./fs-source-reader.ts";

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rh-fsr-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const reader = () => createFsSourceReader({ home: "/home/fixture", env: {} });

describe("fs source reader (fixture directories only)", () => {
  it("reads at most the bytes asked for, only regular files, and nothing it cannot open; the reader has no way to take a file head", () => {
    writeFileSync(join(dir, "big"), "x".repeat(10_000));
    mkdirSync(join(dir, "sub"));
    const r = reader();
    expect(r.readText(join(dir, "big"), 100)).toHaveLength(100);
    expect(r.readText(join(dir, "sub"), 100)).toBeNull();
    expect(r.readText(join(dir, "missing"), 100)).toBeNull();
    writeFileSync(join(dir, "locked"), "secret");
    chmodSync(join(dir, "locked"), 0o000);
    expect(r.readText(join(dir, "locked"), 100)).toBeNull();
    chmodSync(join(dir, "locked"), 0o600);
  });

  it("lists a directory with kinds, and null for what is not one", () => {
    writeFileSync(join(dir, "f"), "1");
    mkdirSync(join(dir, "d"));
    const list = reader().listDir(dir)!;
    expect(list.sort((a, b) => a.name.localeCompare(b.name))).toEqual([{ name: "d", kind: "dir" }, { name: "f", kind: "file" }]);
    expect(reader().listDir(join(dir, "f"))).toBeNull();
  });

  it("an Include is followed inside the config's directory: a relative name, a glob in the file name, sorted", () => {
    mkdirSync(join(dir, "conf.d"));
    writeFileSync(join(dir, "config"), "x");
    writeFileSync(join(dir, "conf.d", "b.conf"), "Host b");
    writeFileSync(join(dir, "conf.d", "a.conf"), "Host a");
    writeFileSync(join(dir, "conf.d", "skip.txt"), "no");
    writeFileSync(join(dir, "extra"), "Host extra");
    const r = reader();
    expect(r.include(join(dir, "config"), "conf.d/*.conf").map((f) => f.text)).toEqual(["Host a", "Host b"]);
    expect(r.include(join(dir, "config"), "extra").map((f) => f.text)).toEqual(["Host extra"]);
    expect(r.include(join(dir, "config"), "conf.d/missing")).toEqual([]);
  });

  it("an Include cannot leave the directory: absolute paths elsewhere, .., a link out, a glob in the directory part", () => {
    const outside = mkdtempSync(join(tmpdir(), "rh-fsr-out-"));
    try {
      writeFileSync(join(outside, "secret.conf"), "Host leaked");
      mkdirSync(join(dir, "ssh"));
      writeFileSync(join(dir, "ssh", "config"), "x");
      symlinkSync(join(outside, "secret.conf"), join(dir, "ssh", "link.conf"));
      symlinkSync(outside, join(dir, "ssh", "linkdir"));
      const r = reader();
      const config = join(dir, "ssh", "config");
      expect(r.include(config, join(outside, "secret.conf"))).toEqual([]);
      expect(r.include(config, "../../" + outside.split("/").pop() + "/secret.conf")).toEqual([]);
      expect(r.include(config, "link.conf")).toEqual([]);
      expect(r.include(config, "linkdir/secret.conf")).toEqual([]);
      expect(r.include(config, "*/secret.conf")).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("ssh -G resolves a fixture config without connecting (real /usr/bin/ssh, fixture file only)", async () => {
    writeFileSync(join(dir, "config"), "Host web\n  HostName web.fixture.invalid\n  Port 2022\n  User deploy\n");
    const out = await reader().sshG(join(dir, "config"), "web");
    expect(out).toContain("hostname web.fixture.invalid");
    expect(out).toContain("port 2022");
    expect(out).toContain("user deploy");
    expect(await reader().sshG(join(dir, "config"), "-oProxyCommand=x")).toBeNull(); // a host token that is an option is refused
  });

  it("ssh-add with no agent is null, never a throw", async () => {
    expect(await createFsSourceReader({ env: { SSH_AUTH_SOCK: join(dir, "nope.sock") } }).agentList()).toBeNull();
  });
});
