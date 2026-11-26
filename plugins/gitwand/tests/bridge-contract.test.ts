// Contract of a built gitwand-bridge runtime (scripts/build-runtime.ts).
//
// The runtime is found through GITWAND_RUNTIME_DIR or .runtime/current.json;
// without one the suite is skipped and says so. Groups that need more than a
// plain process are opt-out or opt-in, and print why when skipped:
//   GITWAND_CONTRACT_NO_PTY=1  skip PTY and FSEvents checks (agent sandboxes forbid both)
//   GITWAND_KEYCHAIN_TEST=1    run the Keychain round trip (writes, then deletes,
//                              the test entry gitwand:test-bb in the login keychain)
import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { createInterface } from "node:readline";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseBridgeLine } from "../src/core/bridge-protocol.ts";
import { KNOWN_PLUGIN_COMMANDS } from "../src/core/tauri-plugin-commands.ts";

const COMMIT = "436b9684f096e8edd35b6a36e3b4d3af0fd7e084";
const ADAPTED = ["terminal_open", "worktree_run_hook", "git_fetch", "git_clone", "watch_repo_start"];

function runtimeDir(): string | null {
  if (process.env.GITWAND_RUNTIME_DIR) return process.env.GITWAND_RUNTIME_DIR;
  const current = new URL("../.runtime/current.json", import.meta.url);
  if (!existsSync(current)) return null;
  return JSON.parse(readFileSync(current, "utf8")).dir as string;
}

const RUNTIME = runtimeDir();
const NO_PTY = process.env.GITWAND_CONTRACT_NO_PTY === "1";
const KEYCHAIN = process.env.GITWAND_KEYCHAIN_TEST === "1";
if (RUNTIME === null) console.warn("bridge contract: SKIPPED, no runtime built (run scripts/build-runtime.ts or set GITWAND_RUNTIME_DIR)");
if (RUNTIME !== null && NO_PTY) console.warn("bridge contract: PTY and FSEvents checks SKIPPED (GITWAND_CONTRACT_NO_PTY=1)");
if (RUNTIME !== null && !KEYCHAIN) console.warn("bridge contract: Keychain round trip SKIPPED (set GITWAND_KEYCHAIN_TEST=1)");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(check: () => boolean, ms = 8000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await sleep(50);
  }
  return check();
}

class Bridge {
  readonly child: ChildProcessWithoutNullStreams;
  readonly channels = new Map<number, unknown[]>();
  readonly invalid: string[] = [];
  private readonly pending = new Map<number, (r: { ok: boolean; value?: unknown; error?: unknown }) => void>();
  private nextId = 1;

  constructor(bin: string) {
    this.child = spawn(bin, [], { stdio: ["pipe", "pipe", "pipe"] });
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      const m = parseBridgeLine(line);
      if (m.kind === "channel") this.channels.set(m.channel, [...(this.channels.get(m.channel) ?? []), m.message]);
      else if (m.kind === "result") {
        this.pending.get(m.id)?.(m.ok ? { ok: true, value: m.value } : { ok: false, error: m.error });
        this.pending.delete(m.id);
      } else this.invalid.push(line);
    });
  }

  call(cmd: string, args: Record<string, unknown> = {}, conn?: string): Promise<{ ok: boolean; value?: unknown; error?: unknown }> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.child.stdin.write(JSON.stringify({ id, cmd, args, ...(conn ? { conn } : {}) }) + "\n");
    });
  }

  chunks(channel: number): string {
    return (this.channels.get(channel) ?? [])
      .filter((m): m is { type: string; data: string } => (m as { type?: string }).type === "chunk")
      .map((m) => m.data)
      .join("");
  }

  async close(): Promise<number | null> {
    this.child.stdin.end();
    return new Promise((resolve) => {
      if (this.child.exitCode !== null) return resolve(this.child.exitCode);
      this.child.on("exit", (code) => resolve(code));
    });
  }
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.email=probe@example.invalid", "-c", "user.name=probe", ...args], { cwd, encoding: "utf8" });

describe.skipIf(RUNTIME === null)("gitwand-bridge runtime contract", () => {
  const dir = RUNTIME ?? "";
  const bin = join(dir, "bin/gitwand-bridge");
  let work = "";
  let repo = "";
  let bridge: Bridge;

  beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), "gitwand-contract-"));
    repo = join(work, "repo");
    execFileSync("git", ["init", "-q", "--bare", join(work, "remote.git")]);
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    writeFileSync(join(repo, "changed.txt"), "a\n");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "first commit");
    git(repo, "remote", "add", "origin", join(work, "remote.git"));
    git(repo, "push", "-q", "origin", "main");
    writeFileSync(join(repo, "changed.txt"), "a\nb\n");
    bridge = new Bridge(bin);
  });

  afterAll(async () => {
    await bridge?.close();
    rmSync(work, { recursive: true, force: true });
  });

  describe("archive", () => {
    it("lists every shipped file with its sha256 in MANIFEST.sha256", () => {
      const files = (d: string): string[] =>
        readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(d, e.name)) : [join(d, e.name)]));
      const listed = new Map(
        readFileSync(join(dir, "MANIFEST.sha256"), "utf8")
          .trim()
          .split("\n")
          .map((l) => [l.slice(66), l.slice(0, 64)] as const),
      );
      const shipped = files(dir).map((f) => relative(dir, f)).filter((p) => p !== "MANIFEST.sha256").sort();
      expect([...listed.keys()].sort()).toEqual(shipped);
      for (const path of shipped) expect(createHash("sha256").update(readFileSync(join(dir, path))).digest("hex"), path).toBe(listed.get(path));
    });

    it("records the build: GitWand v3.14.0 at the pinned commit, protocol 1, 338 generated commands", () => {
      expect(JSON.parse(readFileSync(join(dir, "runtime.json"), "utf8"))).toMatchObject({
        version: "3.14.0+bb2",
        gitwandTag: "v3.14.0",
        commit: COMMIT,
        platform: "darwin-arm64",
        protocol: 1,
        generated: 338,
        adapted: 5,
      });
    });

    it("ships a UI whose Tauri plugin commands are all known to the shim", () => {
      const { pluginCommands } = JSON.parse(readFileSync(join(dir, "runtime.json"), "utf8")) as { pluginCommands: string[] };
      expect(pluginCommands.length).toBeGreaterThan(0);
      expect(pluginCommands.filter((c) => !KNOWN_PLUGIN_COMMANDS.includes(c))).toEqual([]);
    });

    it("prints its identity with --version", () => {
      expect(execFileSync(bin, ["--version"], { encoding: "utf8" }).trim()).toBe(`gitwand-bridge 3.14.0+bb2 (${COMMIT}) commands=338`);
    });
  });

  describe("protocol", () => {
    it("answers __hello with protocol, versions and command counts", async () => {
      expect(await bridge.call("__hello")).toEqual({
        ok: true,
        value: { protocol: 1, version: "3.14.0", commit: COMMIT, runtime: "3.14.0+bb2", generated: 338, adapted: ADAPTED },
      });
    });

    it("runs a generated command: git_status names the modified file", async () => {
      const r = await bridge.call("git_status", { cwd: repo });
      expect(r.ok).toBe(true);
      expect(r.value).toMatchObject({ branch: "main", staged: [], untracked: [], unstaged: [{ path: "changed.txt", status: "modified" }] });
    });

    it("reports the status of a list of repositories without a workspace file", async () => {
      const r = await bridge.call("workspace_status_all", { repos: [{ path: repo, name: "stand" }] });
      expect(r).toMatchObject({ ok: true, value: [{ path: repo, name: "stand", branch: "main", modified: 1, conflicted: 0, error: null }] });
    });

    it("answers repo_catalog with its desktop stub: the plugin server answers it before the bridge", async () => {
      expect(await bridge.call("repo_catalog")).toEqual({ ok: false, error: "The repository catalog is not available in this build of GitWand" });
    });

    it("answers an unknown command with an error, not a crash", async () => {
      expect(await bridge.call("no_such_command")).toEqual({ ok: false, error: "unknown command: no_such_command" });
      expect((await bridge.call("git_status", { cwd: repo })).ok).toBe(true);
    });

    it("answers wrong argument types with an error naming the argument", async () => {
      expect(await bridge.call("git_status", { cwd: 42 })).toEqual({
        ok: false,
        error: "invalid args `cwd`: invalid type: integer `42`, expected a string",
      });
    });

    it("matches concurrent answers to their requests by id", async () => {
      const calls = Array.from({ length: 12 }, (_, i) =>
        i % 2 === 0
          ? bridge.call("git_exec", { cwd: repo, args: ["log", "-1", "--format=%s"] }).then((r) => ["subject", r] as const)
          : bridge.call("git_exec", { cwd: repo, args: ["rev-parse", "--abbrev-ref", "HEAD"] }).then((r) => ["branch", r] as const),
      );
      for (const [kind, r] of await Promise.all(calls)) {
        expect(r.ok).toBe(true);
        expect((r.value as { stdout: string }).stdout).toBe(kind === "subject" ? "first commit\n" : "main\n");
      }
    });

    it("streams git_fetch progress over its channel and fetches from the local remote", async () => {
      const r = await bridge.call("git_fetch", { cwd: repo, onProgress: "__CHANNEL__:900" });
      expect(r).toMatchObject({ ok: true, value: { success: true } });
      expect((bridge.channels.get(900) ?? []).length).toBeGreaterThan(0);
    });

    it("refuses a channel argument that is not a channel", async () => {
      expect(await bridge.call("git_fetch", { cwd: repo, onProgress: "nope" })).toEqual({
        ok: false,
        error: "invalid args `onProgress`: not a channel",
      });
    });

    it("never writes a line that is not a result or a channel message", () => {
      expect(bridge.invalid).toEqual([]);
    });

    it("exits with code 0 when stdin closes", async () => {
      const short = new Bridge(bin);
      expect((await short.call("__hello")).ok).toBe(true);
      expect(await short.close()).toBe(0);
    });
  });

  describe.skipIf(NO_PTY)("terminal and watcher (PTY, FSEvents)", () => {
    it("runs the integrated terminal over a channel: output, then the exit code", async () => {
      const open = await bridge.call("terminal_open", { cwd: repo, shell: null, agent: null, cols: 80, rows: 24, onOutput: "__CHANNEL__:1" }, "c1");
      expect(open.ok).toBe(true);
      await sleep(500);
      await bridge.call("terminal_write", { id: open.value, data: "echo gw-$((40+2))-ok\n" });
      expect(await until(() => bridge.chunks(1).includes("gw-42-ok"))).toBe(true);
      await bridge.call("terminal_write", { id: open.value, data: "exit 3\n" });
      expect(await until(() => (bridge.channels.get(1) ?? []).some((m) => (m as { type?: string }).type === "exit"))).toBe(true);
      expect((bridge.channels.get(1) ?? []).filter((m) => (m as { type?: string }).type === "exit")).toEqual([{ type: "exit", code: 3 }]);
    });

    it("closes only the terminals of the connection named by __close_conn", async () => {
      const a = await bridge.call("terminal_open", { cwd: repo, shell: null, agent: null, cols: 80, rows: 24, onOutput: "__CHANNEL__:2" }, "c2");
      const b = await bridge.call("terminal_open", { cwd: repo, shell: null, agent: null, cols: 80, rows: 24, onOutput: "__CHANNEL__:3" }, "c3");
      expect(await bridge.call("__close_conn", { conn: "c2" })).toEqual({ ok: true, value: { terminalsClosed: 1 } });
      expect(await bridge.call("terminal_write", { id: a.value, data: "true\n" })).toEqual({ ok: false, error: "session not found" });
      expect((await bridge.call("terminal_write", { id: b.value, data: "true\n" })).ok).toBe(true);
      await bridge.call("__close_conn", { conn: "c3" });
    });

    it("reports an external file change on the watcher channel until its connection closes", async () => {
      const w = await bridge.call("watch_repo_start", { cwd: repo, onChange: "__CHANNEL__:4" }, "w1");
      expect(w.ok).toBe(true);
      await sleep(400);
      writeFileSync(join(repo, "external.txt"), "x\n");
      expect(await until(() => (bridge.channels.get(4) ?? []).length > 0)).toBe(true);
      expect(bridge.channels.get(4)?.[0]).toMatchObject({ paths: ["external.txt"], kinds: ["worktree"] });
      expect(await bridge.call("__close_conn", { conn: "w1" })).toEqual({ ok: true, value: { terminalsClosed: 0 } });
      const seen = (bridge.channels.get(4) ?? []).length;
      writeFileSync(join(repo, "external2.txt"), "y\n");
      await sleep(1500);
      expect((bridge.channels.get(4) ?? []).length).toBe(seen);
    });
  });

  describe.skipIf(!KEYCHAIN)("Keychain", () => {
    it("stores, reads and deletes the test entry gitwand:test-bb", async () => {
      const key = { service: "gitwand:test-bb", account: "contract" };
      const value = `contract-${Date.now()}`;
      expect(await bridge.call("set_credential", { ...key, value })).toEqual({ ok: true, value: null });
      expect(await bridge.call("get_credential", key)).toEqual({ ok: true, value });
      expect(await bridge.call("delete_credential", key)).toEqual({ ok: true, value: null });
      const after = await bridge.call("get_credential", key);
      expect(after.ok).toBe(false);
      expect(String(after.error)).toMatch(/^No credential found for gitwand:test-bb\/contract\./);
    });
  });
});
