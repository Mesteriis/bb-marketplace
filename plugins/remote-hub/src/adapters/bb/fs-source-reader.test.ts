import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFsSourceReader } from "./fs-source-reader.ts";

let root = "";
/** The fixture ~/.ssh: OpenSSH anchors a relative Include of a user config here. */
let dir = "";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "rh-fsr-"));
  dir = join(root, ".ssh");
  mkdirSync(dir);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const budget = () => ({ files: 50, bytes: 1024 * 1024 });
const reader = () => createFsSourceReader({ home: root, env: {} });

describe("fs source reader (fixture directories only)", () => {
  it("reads at most the bytes asked for, only regular files, and nothing it cannot open; the reader has no way to take a file head", () => {
    writeFileSync(join(dir, "big"), "x".repeat(10_000));
    mkdirSync(join(dir, "sub"));
    const r = reader();
    expect(r.readText(join(dir, "big"), 100)).toEqual({ text: "x".repeat(100), truncated: true });
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
    expect(r.include(join(dir, "config"), "conf.d/*.conf", budget()).files.map((f) => f.text)).toEqual(["Host a", "Host b"]);
    expect(r.include(join(dir, "config"), "extra", budget()).files.map((f) => f.text)).toEqual(["Host extra"]);
    expect(r.include(join(dir, "config"), "conf.d/missing", budget()).files).toEqual([]);
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
      expect(r.include(config, join(outside, "secret.conf"), budget()).files).toEqual([]);
      expect(r.include(config, "../../" + outside.split("/").pop() + "/secret.conf", budget()).files).toEqual([]);
      expect(r.include(config, "link.conf", budget()).files).toEqual([]);
      expect(r.include(config, "linkdir/secret.conf", budget()).files).toEqual([]);
      expect(r.include(config, "*/secret.conf", budget()).files).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("a FIFO reached through an Include is refused without opening it (a read would block forever); a FIFO as the registered file reads as nothing", () => {
    writeFileSync(join(dir, "config"), "x");
    execFileSync("/usr/bin/mkfifo", [join(dir, "fifo")]);
    const r = reader();
    const result = r.include(join(dir, "config"), "fifo", budget());
    expect(result.files).toEqual([]);
    expect(result.complete).toBe(false);
    expect(r.readText(join(dir, "fifo"), 100)).toBeNull();
  });

  it("the budget is shared and drained: files and bytes read are subtracted, and running out says the result is incomplete", () => {
    writeFileSync(join(dir, "config"), "x");
    for (const n of ["a", "b", "c"]) writeFileSync(join(dir, n + ".conf"), "Host " + n);
    const b = { files: 2, bytes: 1024 };
    const r = reader();
    const result = r.include(join(dir, "config"), "*.conf", b);
    expect(result.files.map((f) => f.text)).toEqual(["Host a", "Host b"]);
    expect(result.complete).toBe(false);
    expect(b.files).toBe(0);
    expect(r.include(join(dir, "config"), "c.conf", b)).toEqual({ files: [], complete: false });
  });

  it("a lookup that FAILS (permission) is incomplete, not 'nothing there' (W3c)", () => {
    writeFileSync(join(dir, "config"), "x");
    mkdirSync(join(dir, "locked"));
    writeFileSync(join(dir, "locked", "a.conf"), "Host a");
    chmodSync(join(dir, "locked"), 0o000);
    try {
      const r = reader();
      // A literal file inside a directory ssh could not search, and a glob over a directory it could not list.
      expect(r.include(join(dir, "config"), "locked/a.conf", budget())).toEqual({ files: [], complete: false });
      expect(r.include(join(dir, "config"), "locked/*.conf", budget())).toEqual({ files: [], complete: false });
      // A directory or file that is really absent is still just absent.
      expect(r.include(join(dir, "config"), "absent/a.conf", budget())).toEqual({ files: [], complete: true });
      expect(r.include(join(dir, "config"), "absent.conf", budget())).toEqual({ files: [], complete: true });
    } finally {
      chmodSync(join(dir, "locked"), 0o700);
    }
  });

  it("a relative Include of a config that is not in ~/.ssh is incomplete: OpenSSH would anchor it to ~/.ssh (W3b)", () => {
    mkdirSync(join(root, "elsewhere"));
    writeFileSync(join(root, "elsewhere", "config"), "x");
    writeFileSync(join(root, "elsewhere", "extra.conf"), "Host p");
    expect(reader().include(join(root, "elsewhere", "config"), "extra.conf", budget())).toEqual({ files: [], complete: false });
    // The same file named by an absolute path inside its own directory is still read.
    expect(reader().include(join(root, "elsewhere", "config"), join(root, "elsewhere", "extra.conf"), budget()).files.map((f) => f.text)).toEqual(["Host p"]);
  });

  it("an Include path with a glob metacharacter this reader does not implement is incomplete, never a literal file name (X2)", () => {
    writeFileSync(join(dir, "config"), "x");
    writeFileSync(join(dir, "extra1.conf"), "Host a");
    writeFileSync(join(dir, "[12].conf"), "Host literal");
    const r = reader();
    for (const pattern of ["extra[12].conf", "extra{1,2}.conf", "extra\\1.conf", "[12].conf", "extra1].conf"]) {
      expect(r.include(join(dir, "config"), pattern, budget()), pattern).toEqual({ files: [], complete: false });
    }
    // The wildcards it does implement still work.
    expect(r.include(join(dir, "config"), "extra?.conf", budget()).files.map((f) => f.text)).toEqual(["Host a"]);
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
