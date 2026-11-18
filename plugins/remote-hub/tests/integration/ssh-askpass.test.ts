// SSH askpass end to end: the REAL service, the REAL helper (test-hooks build, so the Keychain is a
// temporary one opened by path), the REAL OpenSSH under a real pty, against a throwaway sshd.
//
//  - a saved password and a saved key passphrase are used without being typed;
//  - a wrong saved password is tried ONCE (the server's own log counts it) and reported clearly;
//  - a host-key question and an informational prompt reach the user and are answered once;
//  - a cancelled question refuses the connection and no password is sent;
//  - no secret appears in any channel: helper stderr, session list, credential list, profile
//    and metadata rows, askpass events, terminal output, process arguments and environments.
// (The sentinels are only ever compared, never printed.)
// WHAT THIS CANNOT OBSERVE: the process search is a snapshot taken at the end, so the short-lived askpass
// and Keychain children (which exist for milliseconds) are not in it; BB's own host logging and traces,
// and transient kernel state, are outside this test too. Their argv and environment are covered by
// construction instead (the secret travels only over pipes and the askpass socket; see architecture.md).
// Needs docker and REMOTE_HUB_INTEGRATION=1; a 240 s watchdog aborts a hung run.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HelperProcess } from "../../src/adapters/bb/helper-process.ts";
import { memoryImportBook } from "../../src/adapters/bb/import-test-support.ts";
import { createRpcHandlers } from "../../src/adapters/bb/rpc-handlers.ts";
import { createRemoteHubService, type RemoteHubService } from "../../src/adapters/bb/service.ts";
import { registerStreamSocket } from "../../src/adapters/bb/stream-socket.ts";
import { CredentialBook, type CredentialMeta, type CredentialMetaStore } from "../../src/core/credential.ts";
import { ProfileBook, type ProfileStore } from "../../src/core/profile-book.ts";
import type { Profile, ProfileFields } from "../../src/core/profile.ts";
import type { SshAskpassEvent } from "../../src/core/ssh-askpass-protocol.ts";

const here = dirname(fileURLToPath(import.meta.url));
const HELPER = process.env.REMOTE_HUB_HELPER ?? join(here, "..", "..", "bin", "remote-hub-helper");
const IMAGE = "remote-hub-sshd-test";
const enabled = process.env.REMOTE_HUB_INTEGRATION === "1";
const dockerOk = enabled && !spawnSync("docker", ["info"], { stdio: "ignore", timeout: 15_000 }).error;

const PASSWORD = "S3cr3t-SSHPW-" + randomBytes(6).toString("hex");
const WRONG = "S3cr3t-WRONG-" + randomBytes(6).toString("hex");
const PASSPHRASE = "S3cr3t-PHRASE-" + randomBytes(6).toString("hex");
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

async function poll<T>(fn: () => T | null | undefined | false, timeoutMs: number, what: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("timed out: " + what);
    await sleep(100);
  }
}

class MemoryProfiles implements ProfileStore {
  rows = new Map<string, Profile>();
  all = () => [...this.rows.values()];
  get = (id: string) => this.rows.get(id) ?? null;
  put = (p: Profile) => void this.rows.set(p.id, p);
  remove = (id: string) => this.rows.delete(id);
}
class MemoryMeta implements CredentialMetaStore {
  rows = new Map<string, CredentialMeta>();
  all = () => [...this.rows.values()];
  get = (ref: string) => this.rows.get(ref) ?? null;
  put = (m: CredentialMeta) => void this.rows.set(m.ref, m);
  remove = (ref: string) => this.rows.delete(ref);
}

interface FakeSocket {
  readyState: number;
  sent: Array<string | Uint8Array>;
  send(data: string | Uint8Array): void;
  close(): void;
}
const makeSocket = (): FakeSocket => ({
  readyState: 1,
  sent: [],
  send(data) {
    this.sent.push(data);
  },
  close() {
    this.readyState = 3;
  },
});
type SocketHandlers = {
  onOpen(socket: FakeSocket): Promise<void>;
  onMessage(socket: FakeSocket, data: string | Uint8Array): void;
  onClose(): void;
};

function ourProcesses(helperPid: number): Array<[number, string]> {
  const r = spawnSync("ps", ["-ax", "-ww", "-o", "pid=,ppid=,command="], { encoding: "utf8" });
  if (r.status !== 0 || (r.stdout ?? "").trim() === "") throw new Error("ps failed or returned nothing: the search would prove nothing");
  const rows = r.stdout
    .split("\n")
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line))
    .filter((m): m is RegExpExecArray => m !== null);
  if (!rows.some((m) => Number(m[1]) === helperPid)) throw new Error("the helper process is not in the process table");
  // The helper and every descendant (ssh, a transient askpass client).
  const family = new Set<number>([helperPid]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const m of rows) if (family.has(Number(m[2])) && !family.has(Number(m[1]))) (family.add(Number(m[1])), (grew = true));
  }
  return rows.filter((m) => family.has(Number(m[1]))).map((m) => [Number(m[1]), m[3]]);
}
function environmentText(pid: number): string {
  const r = spawnSync("ps", ["eww", "-p", String(pid), "-o", "command="], { encoding: "utf8" });
  if (r.status !== 0 || (r.stdout ?? "").trim() === "") throw new Error(`cannot read the environment of pid ${pid}: the search would prove nothing`);
  return r.stdout;
}

describe.skipIf(!dockerOk)("SSH askpass: saved secrets, one attempt, user prompts, no leaks", () => {
  let tmp = "";
  let cid = "";
  let port = 0;
  let plainKey = "";
  let lockedKey = "";
  let knownHosts = "";
  let emptyKnownHosts = "";
  let hostKeyLine = "";
  let service: RemoteHubService;
  let stderr = "";
  let helperPid = 0;
  const outputs: string[] = [];
  const events: SshAskpassEvent[] = [];
  const profiles = new ProfileBook({ store: new MemoryProfiles(), now: () => new Date(), newId: () => randomUUID() });
  const meta = new MemoryMeta();
  let book: CredentialBook;
  let rpc: ReturnType<typeof createRpcHandlers>;
  let connectSocket: (url: string) => SocketHandlers;
  const watchdog = setTimeout(() => process.abort(), 240_000);

  const sshFields = (over: Partial<ProfileFields>): ProfileFields => ({
    name: "box",
    protocol: "ssh",
    group: null,
    tags: [],
    favorite: false,
    color: null,
    host: "127.0.0.1",
    port,
    username: "root",
    domain: null,
    authType: "password",
    identityFile: null,
    credentialRef: null,
    rdpWidth: null,
    rdpHeight: null,
    ...over,
  });
  // No configFile: a session with a saved secret reads no SSH configuration at all.
  const target = (over: Record<string, unknown> = {}) => ({ host: "127.0.0.1", port, user: "root", knownHostsFile: knownHosts, extraOptions: [] as string[], ...over });
  const failedPasswords = (): number => ((spawnSync("docker", ["logs", cid], { encoding: "utf8" }).stderr ?? "").match(/Failed password/g) ?? []).length;
  const closedOf = (handle: { generation: string; sessionId: number }) =>
    service.sessionList().find((s) => s.generation === handle.generation && s.sessionId === handle.sessionId && s.state === "closed");

  /** Types a command in the session through the real socket and returns once `needle` shows. */
  async function expectShell(handle: { generation: string; sessionId: number }, a: number, b: number): Promise<void> {
    const token = service.sessionAttach(handle);
    const handlers = connectSocket("ws://bb/api/attach?attach=" + token);
    const socket = makeSocket();
    await handlers.onOpen(socket);
    handlers.onMessage(socket, new TextEncoder().encode(`printf 'A%sB' $((${a}*${b}))\n`));
    const needle = `A${a * b}B`;
    const decoder = new TextDecoder();
    const seen = new Set<number>();
    let text = "";
    const deadline = Date.now() + 40_000;
    while (Date.now() < deadline && !text.includes(needle)) {
      let liveAfter = -1;
      socket.sent.forEach((d, i) => {
        if (typeof d === "string" && d.includes('"live"')) liveAfter = i;
      });
      socket.sent.forEach((d, i) => {
        if (d instanceof Uint8Array && !seen.has(i) && i > liveAfter) {
          seen.add(i);
          text += decoder.decode(d, { stream: true });
          handlers.onMessage(socket, JSON.stringify({ type: "ack", bytes: d.byteLength }));
        }
      });
      await sleep(25);
    }
    outputs.push(text);
    handlers.onClose();
    expect(text, "the shell did not answer").toContain(needle);
  }

  const watch = (handle: { generation: string; sessionId: number }) => service.subscribeSshAskpass(handle, (e) => events.push(e));

  beforeAll(async () => {
    if (!readFileSync(HELPER).includes("REMOTE_HUB_KEYCHAIN_PATH")) {
      throw new Error("REMOTE_HUB_HELPER is not a test-hooks build: build it with cargo build --features test-hooks");
    }
    execFileSync("docker", ["build", "-q", "-t", IMAGE, here], { stdio: "ignore" });
    tmp = mkdtempSync(join(tmpdir(), "rh-askpass-"));
    plainKey = join(tmp, "id_plain");
    lockedKey = join(tmp, "id_locked");
    execFileSync("ssh-keygen", ["-t", "ed25519", "-N", "", "-f", plainKey, "-q"]);
    // The passphrase is never on a command line: ssh-keygen asks for it through a throwaway askpass
    // script that reads it from its own (short-lived) environment.
    execFileSync("ssh-keygen", ["-t", "ed25519", "-N", "", "-f", lockedKey, "-q"]);
    const fixtureAskpass = join(tmp, "fixture-askpass.sh");
    writeFileSync(fixtureAskpass, '#!/bin/sh\nprintf "%s\\n" "$RH_FIXTURE_PASSPHRASE"\n', { mode: 0o700 });
    execFileSync("ssh-keygen", ["-p", "-f", lockedKey, "-q"], {
      env: { ...process.env, SSH_ASKPASS: fixtureAskpass, SSH_ASKPASS_REQUIRE: "force", RH_FIXTURE_PASSPHRASE: PASSPHRASE },
      stdio: ["ignore", "ignore", "inherit"],
    });
    port = await freePort();
    cid = execFileSync("docker", ["run", "-d", "-p", `127.0.0.1:${port}:22`, IMAGE], { encoding: "utf8" }).trim();
    execFileSync("docker", ["exec", "-i", cid, "chpasswd"], { input: `root:${PASSWORD}\n` });
    // Only the encrypted key is authorised, so a passphrase is what the test must supply.
    execFileSync("docker", ["exec", "-i", cid, "sh", "-c", "mkdir -p /root/.ssh && cat > /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys"], {
      input: readFileSync(lockedKey + ".pub"),
    });
    await sleep(2000);
    const hostKey = execFileSync("docker", ["exec", cid, "cat", "/etc/ssh/ssh_host_ed25519_key.pub"], { encoding: "utf8" }).trim();
    hostKeyLine = hostKey;
    knownHosts = join(tmp, "known_hosts");
    // A real session reads OpenSSH's default known_hosts (never touched here); this test-hooks helper allows a file.
    writeFileSync(knownHosts, `[127.0.0.1]:${port} ${hostKey}\n[localhost]:${port} ${hostKey}\n`);
    emptyKnownHosts = join(tmp, "empty_known_hosts");

    const env = { ...process.env, REMOTE_HUB_KEYCHAIN_PATH: join(tmp, "kc.keychain-db"), REMOTE_HUB_KEYCHAIN_CREATE_PASSWORD: "throwaway-kc-password", REMOTE_HUB_TEST_ALLOW_KNOWN_HOSTS: "1", REMOTE_HUB_KNOWN_HOSTS_PATH: join(tmp, "Application Support", "Remote Hub", "known_hosts") };
    service = createRemoteHubService({
      startHelper: () =>
        HelperProcess.spawn(HELPER, (bin, args) => {
          const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"], env }) as unknown as ChildProcessWithoutNullStreams;
          helperPid = child.pid ?? 0;
          child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
          return child;
        }),
      env: { ...process.env, REMOTE_HUB_TEST_ALLOW_KNOWN_HOSTS: "1" } as Record<string, string | undefined>,
    });
    book = new CredentialBook({ store: meta, vault: service.credentialVault, profiles, now: () => new Date(), newId: () => randomUUID() });
    rpc = createRpcHandlers({ service, profiles, credentials: book, imports: memoryImportBook(profiles, book) });
    let captured: ((ctx: { url: URL }) => SocketHandlers) | null = null;
    registerStreamSocket({ http: { experimental_websocket: (_p: string, h: typeof captured) => (captured = h) } } as never, { service });
    connectSocket = (url) => captured!({ url: new URL(url) });
  }, 180_000);

  afterAll(() => {
    clearTimeout(watchdog);
    service?.stop();
    if (cid !== "") spawnSync("docker", ["rm", "-f", cid], { stdio: "ignore" });
    if (tmp !== "") rmSync(tmp, { recursive: true, force: true });
  });

  it("a saved key passphrase unlocks an encrypted key without being typed", async () => {
    const p = profiles.save({ fields: sshFields({ name: "locked", authType: "key", identityFile: lockedKey }) });
    const { ref } = await book.save({ profileId: p.id, secret: PASSPHRASE });
    const handle = await rpc.ssh_open({ target: target({ identityFile: lockedKey }), cols: 80, rows: 24, profileId: p.id, credentialRef: ref } as never);
    watch(handle);
    await expectShell(handle, 6, 7);
  }, 90_000);

  it("a saved password logs in without being typed (password auth is the only method asked for)", async () => {
    const pw = profiles.save({ fields: sshFields({ name: "pw" }) });
    const { ref } = await book.save({ profileId: pw.id, secret: PASSWORD });
    // Password auth must work on the container, which now has the sentinel password.
    const handle = await rpc.ssh_open({ target: target(), cols: 80, rows: 24, profileId: pw.id, credentialRef: ref } as never);
    watch(handle);
    await expectShell(handle, 7, 8);
    expect(events.filter((e) => e.type !== "prompt")).toEqual([]);
  }, 90_000);

  it("a mixed-case host name gets the saved password: OpenSSH prints it in lower case and so does the binding", async () => {
    const mixed = profiles.save({ fields: sshFields({ name: "mixed", host: "LocalHost" }) });
    const { ref } = await book.save({ profileId: mixed.id, secret: PASSWORD });
    const handle = await rpc.ssh_open({ target: target({ host: "LOCALHOST" }), cols: 80, rows: 24, profileId: mixed.id, credentialRef: ref } as never);
    const mine: SshAskpassEvent[] = [];
    service.subscribeSshAskpass(handle, (e) => mine.push(e));
    await expectShell(handle, 4, 9);
    expect(mine, "the saved password was not given to a manual prompt").toEqual([]);
  }, 90_000);

  it("a wrong saved password is tried ONCE, the server's own log counts it, and the failure is reported", async () => {
    const p = profiles.list().find((x) => x.name === "pw")!;
    const ref = p.credentialRef!;
    await book.update(ref, WRONG);
    try {
      const before = failedPasswords();
      const handle = await rpc.ssh_open({ target: target(), cols: 80, rows: 24, profileId: p.id, credentialRef: ref } as never);
      const mine: SshAskpassEvent[] = [];
      service.subscribeSshAskpass(handle, (e) => mine.push(e));
      await poll(() => closedOf(handle), 60_000, "the session ends after the refused password");
      expect(mine.some((e) => e.type === "credential_rejected")).toBe(true);
      expect(failedPasswords() - before, `failed-password lines: ${failedPasswords()} - ${before}`).toBe(1);
      events.push(...mine);
    } finally {
      await book.update(ref, PASSWORD);
    }
  }, 120_000);

  it("a host-key question reaches the user, is answered once, and the saved password then logs in", async () => {
    const p = profiles.list().find((x) => x.name === "pw")!;
    const ref = p.credentialRef!;
    const handle = await rpc.ssh_open({ target: target({ knownHostsFile: emptyKnownHosts }), cols: 80, rows: 24, profileId: p.id, credentialRef: ref } as never);
    const mine: SshAskpassEvent[] = [];
    service.subscribeSshAskpass(handle, (e) => mine.push(e));
    const prompt = (await poll(() => mine.find((e) => e.type === "prompt"), 40_000, "the host-key question").catch((e) => {
      console.log("DEBUG", JSON.stringify(closedOf(handle) ?? "open"), JSON.stringify(mine), stderr.slice(-600));
      throw e;
    })) as Extract<SshAskpassEvent, { type: "prompt" }>;
    expect(prompt.kind).toBe("confirm");
    expect(prompt.text).toContain("continue connecting");
    await service.sshPromptAnswer(handle, prompt.promptId, "yes");
    await expect(service.sshPromptAnswer(handle, prompt.promptId, "yes"), "an answer is accepted only once").rejects.toBeDefined();
    await expectShell(handle, 5, 9);
    events.push(...mine);
  }, 120_000);

  it("a cancelled host-key question refuses the connection and no password is sent", async () => {
    const p = profiles.list().find((x) => x.name === "pw")!;
    const before = failedPasswords();
    const handle = await rpc.ssh_open({ target: target({ knownHostsFile: join(tmp, "empty2") }), cols: 80, rows: 24, profileId: p.id, credentialRef: p.credentialRef! } as never);
    const mine: SshAskpassEvent[] = [];
    service.subscribeSshAskpass(handle, (e) => mine.push(e));
    const prompt = (await poll(() => mine.find((e) => e.type === "prompt"), 40_000, "the host-key question")) as Extract<SshAskpassEvent, { type: "prompt" }>;
    await service.sshPromptAnswer(handle, prompt.promptId, null);
    await poll(() => closedOf(handle), 60_000, "the session ends after cancel");
    expect(failedPasswords() - before).toBe(0);
    events.push(...mine);
  }, 120_000);

  it("a credential saved for another endpoint is refused before anything is started", async () => {
    const p = profiles.list().find((x) => x.name === "pw")!;
    await expect(rpc.ssh_open({ target: target({ host: "localhost" }), cols: 80, rows: 24, credentialRef: p.credentialRef! } as never)).rejects.toMatchObject({
      message: expect.stringContaining("credential_target_mismatch"),
    });
  }, 30_000);

  it("a server that offers only keyboard-interactive, with look-alike password and passphrase prompts, is never asked and never answered", async () => {
    execFileSync("docker", ["build", "-q", "-t", "remote-hub-kbd-test", "-f", join(here, "kbd-Dockerfile"), here], { stdio: "ignore" });
    const kbdPort = await freePort();
    const kbd = execFileSync("docker", ["run", "-d", "-p", `127.0.0.1:${kbdPort}:2222`, "remote-hub-kbd-test"], { encoding: "utf8" }).trim();
    try {
      const logs = () => (spawnSync("docker", ["logs", kbd], { encoding: "utf8" }).stdout ?? "");
      await poll(() => logs().includes("READY"), 30_000, "the keyboard-interactive server");
      const hostKey = /HOSTKEY (\S+ \S+)/.exec(logs())![1];
      const kh = join(tmp, "kbd_known_hosts");
      writeFileSync(kh, `[127.0.0.1]:${kbdPort} ${hostKey}\n`);
      const mine: SshAskpassEvent[] = [];
      // A saved password for this server, and a saved passphrase for the encrypted key.
      const pw = profiles.save({ fields: sshFields({ name: "kbd-pw", port: kbdPort }) });
      const pwRef = (await book.save({ profileId: pw.id, secret: PASSWORD })).ref;
      const key = profiles.save({ fields: sshFields({ name: "kbd-key", port: kbdPort, authType: "key", identityFile: lockedKey }) });
      const keyRef = (await book.save({ profileId: key.id, secret: PASSPHRASE })).ref;
      for (const [profile, ref, extra] of [[pw, pwRef, {}], [key, keyRef, { identityFile: lockedKey }]] as const) {
        const handle = await rpc.ssh_open({ target: target({ port: kbdPort, knownHostsFile: kh, ...extra }), cols: 80, rows: 24, profileId: profile.id, credentialRef: ref } as never);
        service.subscribeSshAskpass(handle, (e) => mine.push(e));
        await poll(() => closedOf(handle), 40_000, "the session ends: the server offers nothing the client may use");
      }
      const log = logs();
      // The client used neither password, key nor keyboard-interactive: the fixed method is not on offer, so ssh stopped.
      expect(log).not.toContain("ATTEMPT keyboard-interactive");
      expect(log).not.toContain("ATTEMPT password");
      expect(log).not.toContain("ATTEMPT publickey");
      expect(log).not.toContain("RESPONSES");
      expect(mine, "no prompt, notice or answer may reach askpass").toEqual([]);
      events.push(...mine);
    } finally {
      spawnSync("docker", ["rm", "-f", kbd], { stdio: "ignore" });
    }
  }, 150_000);

  it("the helper-owned overlay: an unknown key raises the question once, a yes keeps it, the next session is not asked, a changed key blocks", async () => {
    // A path with a space in it, like the production one (~/Library/Application Support/Remote Hub/known_hosts).
    const overlay = join(tmp, "Application Support", "Remote Hub", "known_hosts");
    const p = profiles.list().find((x) => x.name === "pw")!;
    const open = async () => {
      // No knownHostsFile: a saved-secret session reads only the overlay the helper chose.
      const handle = await rpc.ssh_open({ target: target({ knownHostsFile: undefined }), cols: 80, rows: 24, profileId: p.id, credentialRef: p.credentialRef! } as never);
      const mine: SshAskpassEvent[] = [];
      service.subscribeSshAskpass(handle, (e) => mine.push(e));
      return { handle, mine };
    };
    const keyBlob = hostKeyLine.split(" ")[1];

    // 1. Unknown key: the confirm question, once; "yes" lets the saved password log in and the key is kept in the overlay.
    const first = await open();
    const prompt = (await poll(() => first.mine.find((e) => e.type === "prompt"), 40_000, "the host-key question")) as Extract<SshAskpassEvent, { type: "prompt" }>;
    expect(prompt.kind).toBe("confirm");
    await service.sshPromptAnswer(first.handle, prompt.promptId, "yes");
    await expectShell(first.handle, 3, 11);
    expect(first.mine.filter((e) => e.type === "prompt")).toHaveLength(1);
    // ssh wrote the key to its PRIVATE copy; the helper, the only writer of the overlay, merges it when the session ends.
    await service.sessionClose(first.handle);
    await poll(() => (existsSync(overlay) && readFileSync(overlay, "utf8").includes(keyBlob) ? true : null), 20_000, "the confirmed key in the overlay");
    events.push(...first.mine);

    // 2. Trusted now: no question, straight to the shell.
    const second = await open();
    await expectShell(second.handle, 4, 12);
    expect(second.mine.filter((e) => e.type === "prompt")).toEqual([]);
    events.push(...second.mine);

    // 3. The server's key "changes" (the overlay now holds another key for it): the connection is refused,
    //    no question is offered and no password is sent.
    const other = join(tmp, "id_other");
    execFileSync("ssh-keygen", ["-t", "ed25519", "-N", "", "-f", other, "-q"]);
    const otherBlob = readFileSync(other + ".pub", "utf8").split(" ")[1];
    writeFileSync(overlay, readFileSync(overlay, "utf8").split(keyBlob).join(otherBlob), { mode: 0o600 });
    const before = failedPasswords();
    const third = await open();
    await poll(() => closedOf(third.handle), 60_000, "the session ends: the host key changed");
    expect(third.mine.filter((e) => e.type === "prompt"), "a changed key is a refusal, not a question").toEqual([]);
    expect(failedPasswords() - before).toBe(0);
    events.push(...third.mine);
  }, 240_000);

  it("no secret appears in any channel", () => {
    const processes = ourProcesses(helperPid);
    expect(processes.length).toBeGreaterThanOrEqual(1);
    const channels: Record<string, string> = {
      "helper stderr": stderr,
      "session list": JSON.stringify(service.sessionList()),
      "credential list": JSON.stringify(book.list()),
      "profile rows": JSON.stringify(profiles.list()),
      "metadata rows": JSON.stringify([...meta.rows.values()]),
      "askpass events": JSON.stringify(events),
      "terminal output": outputs.join("\n"),
      "process arguments": processes.map(([, argv]) => argv).join("\n"),
      "process environments": processes.map(([pid]) => environmentText(pid)).join("\n"),
    };
    expect(Object.values(channels).some((t) => t.length > 0)).toBe(true);
    for (const [name, text] of Object.entries(channels)) {
      for (const [label, secret] of [["password", PASSWORD], ["wrong password", WRONG], ["passphrase", PASSPHRASE]] as const) {
        expect(text.includes(secret), `the ${label} is in: ${name}`).toBe(false);
      }
    }
  });
});
