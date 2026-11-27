// SFTP for other plugins, end to end: the REAL RPC handlers, channel rules, service and helper (test-hooks build, so the
// Keychain is a temporary one opened by path and Remote Hub's host-key file lives in a temp directory), the REAL OpenSSH
// with the sftp subsystem, against a throwaway sshd.
//
//  - only a plugin may call hub_sftp_*, only the owner's page may call sftp_access_*;
//  - nothing opens without the owner's grant; a grant is per plugin; another plugin cannot use a channel it did not open;
//  - a saved password, a saved key passphrase and the SSH agent each open a channel; files go there and back unchanged;
//  - a host key nobody confirmed and a host key that changed refuse the channel for all three kinds of sign-in;
//  - an agent connection without an agent says so;
//  - a revoke ends the channel and the next call is consent_revoked;
//  - no answer, refusal, event or helper log holds a secret, a key path, a credential reference or the temp directory.
// The user's own ~/.ssh is never read: connections without a saved secret run with `-F <temp config>` here, which is the
// one thing this test does differently from production (where they use the user's configuration).
// Needs docker and REMOTE_HUB_INTEGRATION=1; a 300 s watchdog aborts a hung run.
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertTestHooksHelper, throwawayEnv } from "./support.ts";
import { HelperProcess } from "../../src/adapters/bb/helper-process.ts";
import { memoryImportBook } from "../../src/adapters/bb/import-test-support.ts";
import { createRpcHandlers, type RpcCallContext, type RpcHandlers } from "../../src/adapters/bb/rpc-handlers.ts";
import { createRemoteHubService, type RemoteHubService } from "../../src/adapters/bb/service.ts";
import { createHostKeyHint, createSftpTransport, sftpProfileFacts, sshAgentPresent } from "../../src/adapters/bb/sftp-transport.ts";
import { profileToSshTarget } from "../../src/core/catalogue.ts";
import { CredentialBook, type CredentialMeta, type CredentialMetaStore } from "../../src/core/credential.ts";
import { PluginGrantBook, type PluginGrantRow } from "../../src/core/plugin-grants.ts";
import { ProfileBook, type ProfileStore } from "../../src/core/profile-book.ts";
import type { Profile, ProfileFields } from "../../src/core/profile.ts";
import { rpcSchemas } from "../../src/core/rpc.ts";
import { SftpChannels, type SftpTransport } from "../../src/core/sftp-channels.ts";
import { fromBase64, toBase64 } from "../../src/core/sftp-codec.ts";

const here = dirname(fileURLToPath(import.meta.url));
const HELPER = process.env.REMOTE_HUB_HELPER ?? join(here, "..", "..", "bin", "remote-hub-helper");
const IMAGE = "remote-hub-sshd-test";
const enabled = process.env.REMOTE_HUB_INTEGRATION === "1";
const dockerOk = enabled && !spawnSync("docker", ["info"], { stdio: "ignore", timeout: 15_000 }).error;

const PASSWORD = "S3cr3t-SFTPPW-" + randomBytes(6).toString("hex");
const PASSPHRASE = "S3cr3t-SFTPPH-" + randomBytes(6).toString("hex");
const COMMANDER: RpcCallContext = { experimental_caller: { kind: "plugin", pluginId: "makosh-commander" } };
const STRANGER: RpcCallContext = { experimental_caller: { kind: "plugin", pluginId: "some-other-plugin" } };
const PAGE: RpcCallContext = { experimental_caller: { kind: "client" } };
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

describe.skipIf(!dockerOk)("SFTP for other plugins: grants, three kinds of sign-in, host keys, revoke, no leaks", () => {
  let tmp = "";
  let cid = "";
  let port = 0;
  let lockedKey = "";
  let agentSock = "";
  let agent: ChildProcess | null = null;
  let service: RemoteHubService;
  let serviceNoAgent: RemoteHubService;
  let rpc: RpcHandlers;
  let rpcNoAgent: RpcHandlers;
  let stderr = "";
  /** Everything a plugin or a page was given back, and every event: searched for secrets at the end. */
  const spoken: string[] = [];
  const events: string[] = [];
  const store = new MemoryProfiles();
  const profiles = new ProfileBook({ store, now: () => new Date(), newId: () => randomUUID() });
  const meta = new MemoryMeta();
  /** The ssh configuration a connection WITHOUT a saved secret runs with here, by profile id. */
  const configOf = new Map<string, string>();
  const watchdog = setTimeout(() => process.abort(), 300_000);

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

  /** Calls a handler the way the host does (parsed input, the caller in the context) and checks the answer's shape. */
  async function call<K extends keyof RpcHandlers>(handlers: RpcHandlers, name: K, input: unknown, ctx: RpcCallContext): Promise<Awaited<ReturnType<RpcHandlers[K]>>> {
    const parsed = (rpcSchemas[name].input as { parse(v: unknown): unknown }).parse(input);
    try {
      const out = await (handlers[name] as (i: unknown, c: RpcCallContext) => unknown)(parsed, ctx);
      const text = JSON.stringify(out);
      // A file's own bytes are not a secret the hub holds; keep the search fast.
      spoken.push(text.length > 100_000 ? text.slice(0, 2000) : text);
      (rpcSchemas[name].output as { parse(v: unknown): unknown }).parse(out);
      return out as Awaited<ReturnType<RpcHandlers[K]>>;
    } catch (error) {
      spoken.push(String((error as Error).message) + " " + JSON.stringify(error));
      throw error;
    }
  }
  const refusal = async (work: Promise<unknown>): Promise<string> => {
    try {
      await work;
      return "ok";
    } catch (error) {
      return String((error as Error).message).split(":")[0] as string;
    }
  };
  const text = (s: string) => ({ text: s });

  function build(svc: RemoteHubService, env: Record<string, string | undefined>): RpcHandlers {
    const book = new CredentialBook({ store: meta, vault: svc.credentialVault, profiles, now: () => new Date(), newId: () => randomUUID() });
    const real = createSftpTransport({ service: svc, profiles, credentials: book });
    // The only difference from production: a connection without a saved secret gets `-F <temp config>` so the user's own
    // ~/.ssh is never read by a test.
    const transport: SftpTransport = {
      open(profileId, sink) {
        const profile = profiles.get(profileId);
        if (profile !== null && profile.credentialRef === null) return svc.sftpOpen({ ...profileToSshTarget(profile), configFile: configOf.get(profileId) as string }, null, sink);
        return real.open(profileId, sink);
      },
    };
    const rows = new Map<string, PluginGrantRow>();
    let channels: SftpChannels | undefined;
    const grants = new PluginGrantBook({
      store: { all: () => [...rows.values()], get: (p, f) => rows.get(p + "|" + f) ?? null, put: (row) => void rows.set(row.pluginId + "|" + row.profileId, row), remove: (p, f) => rows.delete(p + "|" + f) },
      now: () => new Date(),
      newId: () => randomUUID(),
      profileExists: (id) => profiles.get(id) !== null,
      onChange: (c) => {
        if (c.state === "revoked" || c.state === "none") channels?.revoked(c.pluginId, c.profileId);
        events.push(JSON.stringify({ type: "sftp.consent", profileId: c.profileId, state: c.state }));
      },
    });
    channels = new SftpChannels({
      grants,
      transport,
      profile: (id) => sftpProfileFacts(profiles.get(id)),
      agentPresent: (host) => sshAgentPresent(env, host, () => ""),
      newId: () => randomUUID(),
      now: () => new Date(),
      onEvent: (e) => void events.push(JSON.stringify({ channelId: e.channelId, state: e.state })),
    });
    return createRpcHandlers({ service: svc, profiles, credentials: book, imports: memoryImportBook(profiles, book), sftp: { channels, grants, profiles, hostKeyKnown: createHostKeyHint({ service: svc, userKnownHosts: () => "" }) } });
  }

  let pw: Profile;
  let key: Profile;
  let viaAgent: Profile;
  let hostKey = "";
  let otherKey = "";

  beforeAll(async () => {
    assertTestHooksHelper(HELPER);
    execFileSync("docker", ["build", "-q", "-t", IMAGE, here], { stdio: "ignore" });
    tmp = mkdtempSync(join(tmpdir(), "rh-sftp-"));
    lockedKey = join(tmp, "id_locked");
    const agentKey = join(tmp, "id_agent");
    const strayKey = join(tmp, "id_stray");
    for (const k of [lockedKey, agentKey, strayKey]) execFileSync("ssh-keygen", ["-t", "ed25519", "-N", "", "-f", k, "-q"]);
    const fixtureAskpass = join(tmp, "fixture-askpass.sh");
    writeFileSync(fixtureAskpass, '#!/bin/sh\nprintf "%s\\n" "$RH_FIXTURE_PASSPHRASE"\n', { mode: 0o700 });
    execFileSync("ssh-keygen", ["-p", "-f", lockedKey, "-q"], { env: { ...process.env, SSH_ASKPASS: fixtureAskpass, SSH_ASKPASS_REQUIRE: "force", RH_FIXTURE_PASSPHRASE: PASSPHRASE }, stdio: ["ignore", "ignore", "inherit"] });
    otherKey = readFileSync(strayKey + ".pub", "utf8").trim().split(" ").slice(0, 2).join(" ");

    port = await freePort();
    cid = execFileSync("docker", ["run", "-d", "-p", `127.0.0.1:${port}:22`, IMAGE], { encoding: "utf8" }).trim();
    execFileSync("docker", ["exec", "-i", cid, "chpasswd"], { input: `root:${PASSWORD}\n` });
    execFileSync("docker", ["exec", "-i", cid, "sh", "-c", "mkdir -p /root/.ssh && cat > /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys"], {
      input: Buffer.concat([readFileSync(lockedKey + ".pub"), readFileSync(agentKey + ".pub")]),
    });
    await sleep(2000);
    hostKey = execFileSync("docker", ["exec", cid, "cat", "/etc/ssh/ssh_host_ed25519_key.pub"], { encoding: "utf8" }).trim().split(" ").slice(0, 2).join(" ");

    // An SSH agent that holds the one key; the private key file is then removed, so only the agent can sign with it.
    agentSock = join(tmp, "agent.sock");
    agent = spawn("ssh-agent", ["-D", "-a", agentSock], { stdio: "ignore" });
    for (let i = 0; i < 50 && !existsSync(agentSock); i++) await sleep(100);
    execFileSync("ssh-add", ["-q", agentKey], { env: { ...process.env, SSH_AUTH_SOCK: agentSock }, stdio: "ignore" });
    rmSync(agentKey);

    const helperEnv = { ...process.env, ...throwawayEnv(tmp) };
    const start = (ours: Record<string, string | undefined>) =>
      createRemoteHubService({
        startHelper: () =>
          HelperProcess.spawn(HELPER, (bin, args) => {
            const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"], env: helperEnv }) as unknown as ChildProcessWithoutNullStreams;
            child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
            return child;
          }),
        env: ours,
      });
    const withAgent = { PATH: process.env.PATH, HOME: process.env.HOME, USER: process.env.USER, SSH_AUTH_SOCK: agentSock };
    const noAgent = { PATH: process.env.PATH, HOME: process.env.HOME, USER: process.env.USER, SSH_AUTH_SOCK: join(tmp, "no-agent.sock") };
    service = start(withAgent);
    serviceNoAgent = start(noAgent);
    rpc = build(service, withAgent);
    rpcNoAgent = build(serviceNoAgent, noAgent);

    // Remote Hub's own host keys (what a saved-secret connection is checked against): 127.0.0.1 is confirmed.
    await service.knownHosts.add([`[127.0.0.1]:${port} ${hostKey}`]);

    const book = new CredentialBook({ store: meta, vault: service.credentialVault, profiles, now: () => new Date(), newId: () => randomUUID() });
    pw = profiles.save({ fields: sshFields({ name: "pw" }) });
    await book.save({ profileId: pw.id, secret: PASSWORD });
    key = profiles.save({ fields: sshFields({ name: "key", authType: "key", identityFile: lockedKey }) });
    await book.save({ profileId: key.id, secret: PASSPHRASE });
    viaAgent = profiles.save({ fields: sshFields({ name: "agent", authType: "agent" }) });
    pw = profiles.get(pw.id) as Profile;
    key = profiles.get(key.id) as Profile;
  }, 240_000);

  afterAll(() => {
    clearTimeout(watchdog);
    service?.stop();
    serviceNoAgent?.stop();
    agent?.kill();
    if (cid !== "") spawnSync("docker", ["rm", "-f", cid], { stdio: "ignore" });
    if (tmp !== "") rmSync(tmp, { recursive: true, force: true });
  });

  /** An ssh configuration for a connection without a saved secret: its own host-key file, the agent's key by its public half. */
  function agentConfig(name: string, knownHostsLines: string[]): string {
    const known = join(tmp, `known-${name}`);
    writeFileSync(known, knownHostsLines.map((l) => l + "\n").join(""));
    const path = join(tmp, `config-${name}`);
    writeFileSync(path, `Host *\n  UserKnownHostsFile "${known}"\n  GlobalKnownHostsFile /dev/null\n  IdentitiesOnly yes\n  IdentityFile "${join(tmp, "id_agent.pub")}"\n`);
    return path;
  }
  const grant = (handlers: RpcHandlers, profileId: string, level: "read" | "write", pluginId = "makosh-commander") => call(handlers, "sftp_access_grant", { pluginId, profileId, level }, PAGE);

  it("only a plugin may call hub_sftp_*, and only the owner's page may grant or revoke", async () => {
    const id = "00000000-0000-4000-8000-000000000000";
    const pluginCalls: Array<[keyof RpcHandlers, unknown]> = [
      ["hub_sftp_profiles", {}],
      ["hub_sftp_request_access", { profileId: pw.id, level: "read" }],
      ["hub_sftp_grants", {}],
      ["hub_sftp_open", { profileId: pw.id }],
      ["hub_sftp_op", { channelId: id, op: "realpath", path: text(".") }],
      ["hub_sftp_close", { channelId: id }],
    ];
    for (const [name, input] of pluginCalls) {
      expect(await refusal(call(rpc, name, input, PAGE)), name).toBe("caller_not_plugin");
      expect(await refusal((rpc[name] as (i: unknown) => Promise<unknown>)(input)), name + " without a caller").toBe("caller_not_plugin");
    }
    const ownerCalls: Array<[keyof RpcHandlers, unknown]> = [
      ["sftp_access_list", {}],
      ["sftp_access_grant", { pluginId: "makosh-commander", profileId: pw.id, level: "write" }],
      ["sftp_access_decline", { requestId: id }],
      ["sftp_access_revoke", { pluginId: "makosh-commander", profileId: pw.id }],
      ["sftp_access_revoke_all", {}],
    ];
    for (const [name, input] of ownerCalls) await expect(call(rpc, name, input, COMMANDER), name).rejects.toThrow(/not for other plugins/);
    expect((await call(rpc, "sftp_access_list", {}, PAGE)).grants).toEqual([]);
  });

  it("asking grants nothing; the owner's grant opens a channel for that plugin only", async () => {
    const listed = await call(rpc, "hub_sftp_profiles", {}, COMMANDER);
    expect(listed.profiles.find((p) => p.id === pw.id)).toMatchObject({ name: "pw", host: "127.0.0.1", port, user: "root", authType: "password", consent: "none", level: null, hostKey: "trusted" });
    const asked = await call(rpc, "hub_sftp_request_access", { profileId: pw.id, level: "write", reason: "copy a build" }, COMMANDER);
    expect(asked.state).toBe("pending");
    expect(await refusal(call(rpc, "hub_sftp_open", { profileId: pw.id }, COMMANDER))).toBe("consent_required");
    expect((await call(rpc, "sftp_access_list", {}, PAGE)).requests).toMatchObject([{ requestId: asked.requestId, pluginId: "makosh-commander", profileId: pw.id, level: "write", reason: "copy a build" }]);
    await grant(rpc, pw.id, "write");
    expect((await call(rpc, "hub_sftp_grants", {}, COMMANDER)).grants).toMatchObject([{ profileId: pw.id, level: "write", state: "granted" }]);
    expect((await call(rpc, "hub_sftp_grants", {}, STRANGER)).grants).toEqual([]);
    expect(await refusal(call(rpc, "hub_sftp_open", { profileId: pw.id }, STRANGER))).toBe("consent_required");

    const { channelId, generation } = await call(rpc, "hub_sftp_open", { profileId: pw.id }, COMMANDER);
    expect(generation).toMatch(/^[0-9a-f]{32}$/);
    expect(await call(rpc, "hub_sftp_op", { channelId, op: "realpath", path: text(".") }, COMMANDER)).toEqual({ op: "realpath", path: text("/root") });
    // Another plugin, even one the owner trusts with the same connection, cannot use or close this channel.
    await grant(rpc, pw.id, "write", "some-other-plugin");
    expect(await refusal(call(rpc, "hub_sftp_op", { channelId, op: "realpath", path: text(".") }, STRANGER))).toBe("channel_closed");
    expect(await call(rpc, "hub_sftp_close", { channelId }, STRANGER)).toEqual({ closed: false });
    expect(await call(rpc, "hub_sftp_op", { channelId, op: "realpath", path: text("/") }, COMMANDER)).toEqual({ op: "realpath", path: text("/") });
    expect(await call(rpc, "hub_sftp_close", { channelId }, COMMANDER)).toEqual({ closed: true });
  }, 120_000);

  it("a file of several megabytes goes there and back unchanged, and directories are listed, renamed and removed", async () => {
    const { channelId } = await call(rpc, "hub_sftp_open", { profileId: pw.id }, COMMANDER);
    const op = (input: Record<string, unknown>) => call(rpc, "hub_sftp_op", { channelId, ...input }, COMMANDER);
    await op({ op: "mkdir", path: text("/tmp/rh") });
    expect(await refusal(op({ op: "mkdir", path: text("/tmp/rh") }))).toBe("exists");
    const data = randomBytes(5 * 1024 * 1024 + 123);
    const CHUNK = 4 * 1024 * 1024;
    expect(await op({ op: "write", path: text("/tmp/rh/big.bin"), offset: "0", data: toBase64(data.subarray(0, CHUNK)), create: "exclusive" })).toEqual({ op: "write", written: CHUNK });
    expect(await refusal(op({ op: "write", path: text("/tmp/rh/big.bin"), offset: "0", data: "", create: "exclusive" }))).toBe("exists");
    expect(await op({ op: "write", path: text("/tmp/rh/big.bin"), offset: String(CHUNK), data: toBase64(data.subarray(CHUNK)), create: "existing" })).toEqual({ op: "write", written: data.length - CHUNK });
    const onServer = execFileSync("docker", ["exec", cid, "sha256sum", "/tmp/rh/big.bin"], { encoding: "utf8" }).split(" ")[0];
    expect(onServer).toBe(createHash("sha256").update(data).digest("hex"));

    const stat = (await op({ op: "stat", path: text("/tmp/rh/big.bin"), follow: true })) as { attrs: { type: string; size: string } };
    expect(stat.attrs).toMatchObject({ type: "file", size: String(data.length) });
    const first = (await op({ op: "read", path: text("/tmp/rh/big.bin"), offset: "0", length: CHUNK })) as { data: string; eof: boolean };
    const second = (await op({ op: "read", path: text("/tmp/rh/big.bin"), offset: String(CHUNK), length: CHUNK })) as { data: string; eof: boolean };
    expect([first.eof, second.eof]).toEqual([false, true]);
    expect(createHash("sha256").update(fromBase64(first.data)).update(fromBase64(second.data)).digest("hex")).toBe(onServer);

    await op({ op: "write", path: text("/tmp/rh/ёлка.txt"), offset: "0", data: toBase64(new TextEncoder().encode("hi")), create: "truncate" });
    const listing = (await op({ op: "list", path: text("/tmp/rh") })) as { entries: Array<{ name: { text?: string }; attrs: { type: string } }>; nextCursor: string | null };
    expect(listing.entries.map((e) => e.name.text)).toEqual(["big.bin", "ёлка.txt"]);
    await op({ op: "rename", from: text("/tmp/rh/ёлка.txt"), to: text("/tmp/rh/note.txt"), overwrite: false });
    expect(await refusal(op({ op: "rename", from: text("/tmp/rh/note.txt"), to: text("/tmp/rh/big.bin"), overwrite: false }))).toBe("exists");
    expect(await refusal(op({ op: "remove", path: text("/tmp/rh"), kind: "dir" }))).toBe("not_empty");
    expect(await refusal(op({ op: "stat", path: text("/tmp/rh/nothing"), follow: false }))).toBe("no_such_file");
    await op({ op: "remove", path: text("/tmp/rh/note.txt"), kind: "file" });
    await op({ op: "remove", path: text("/tmp/rh/big.bin"), kind: "file" });
    await op({ op: "remove", path: text("/tmp/rh"), kind: "dir" });
    await call(rpc, "hub_sftp_close", { channelId }, COMMANDER);
  }, 180_000);

  it("a read grant reads and refuses every change", async () => {
    await grant(rpc, key.id, "read");
    const { channelId } = await call(rpc, "hub_sftp_open", { profileId: key.id }, COMMANDER);
    // The saved passphrase unlocked the key: nobody typed anything.
    expect(await call(rpc, "hub_sftp_op", { channelId, op: "realpath", path: text(".") }, COMMANDER)).toEqual({ op: "realpath", path: text("/root") });
    expect(await refusal(call(rpc, "hub_sftp_op", { channelId, op: "mkdir", path: text("/tmp/never") }, COMMANDER))).toBe("consent_required");
    expect(spawnSync("docker", ["exec", cid, "test", "-e", "/tmp/never"]).status).not.toBe(0);
    await call(rpc, "hub_sftp_close", { channelId }, COMMANDER);
  }, 120_000);

  it("the SSH agent signs a connection that has no saved secret, and without an agent the plugin is told so", async () => {
    configOf.set(viaAgent.id, agentConfig("trusted", [`[127.0.0.1]:${port} ${hostKey}`]));
    await grant(rpc, viaAgent.id, "read");
    const { channelId } = await call(rpc, "hub_sftp_open", { profileId: viaAgent.id }, COMMANDER);
    expect(await call(rpc, "hub_sftp_op", { channelId, op: "realpath", path: text(".") }, COMMANDER)).toEqual({ op: "realpath", path: text("/root") });
    await call(rpc, "hub_sftp_close", { channelId }, COMMANDER);

    await grant(rpcNoAgent, viaAgent.id, "read");
    expect(await refusal(call(rpcNoAgent, "hub_sftp_open", { profileId: viaAgent.id }, COMMANDER))).toBe("agent_unavailable");
  }, 120_000);

  it("a host key nobody confirmed refuses the channel: password, key and agent", async () => {
    const book = new CredentialBook({ store: meta, vault: service.credentialVault, profiles, now: () => new Date(), newId: () => randomUUID() });
    // "localhost" is the same server under a name whose key was never confirmed.
    const pwLocal = profiles.save({ fields: sshFields({ name: "pw-local", host: "localhost" }) });
    await book.save({ profileId: pwLocal.id, secret: PASSWORD });
    const keyLocal = profiles.save({ fields: sshFields({ name: "key-local", host: "localhost", authType: "key", identityFile: lockedKey }) });
    await book.save({ profileId: keyLocal.id, secret: PASSPHRASE });
    const agentLocal = profiles.save({ fields: sshFields({ name: "agent-local", host: "localhost", authType: "agent" }) });
    configOf.set(agentLocal.id, agentConfig("unknown", []));
    const listed = await call(rpc, "hub_sftp_profiles", {}, COMMANDER);
    expect(listed.profiles.find((p) => p.id === pwLocal.id)?.hostKey).toBe("unknown");
    for (const p of [pwLocal, keyLocal, agentLocal]) {
      await grant(rpc, p.id, "write");
      expect(await refusal(call(rpc, "hub_sftp_open", { profileId: p.id }, COMMANDER)), p.name).toBe("host_key_unknown");
    }
    // Nothing was accepted on the way: asking again gives the same answer.
    expect(await refusal(call(rpc, "hub_sftp_open", { profileId: agentLocal.id }, COMMANDER))).toBe("host_key_unknown");
    expect(readFileSync(join(tmp, "known-unknown"), "utf8")).toBe("");

    // The key that was confirmed is not the one the server shows now.
    await service.knownHosts.add([`[localhost]:${port} ${otherKey}`]);
    configOf.set(agentLocal.id, agentConfig("changed", [`[localhost]:${port} ${otherKey}`]));
    for (const p of [pwLocal, keyLocal, agentLocal]) expect(await refusal(call(rpc, "hub_sftp_open", { profileId: p.id }, COMMANDER)), p.name).toBe("host_key_changed");
    expect((await call(rpc, "sftp_access_list", {}, PAGE)).channels).toEqual([]);
  }, 240_000);

  it("a revoke ends the channel at once and the next call is consent_revoked", async () => {
    // The server's own process table says whether a connection is there (this sshd serves sftp inside its session process).
    const sshdNow = () => Number(spawnSync("docker", ["exec", cid, "sh", "-c", "ps | grep -c '[s]shd' || true"], { encoding: "utf8" }).stdout.trim());
    await sleep(3000);
    const idle = sshdNow();
    const { channelId } = await call(rpc, "hub_sftp_open", { profileId: pw.id }, COMMANDER);
    expect((await call(rpc, "sftp_access_list", {}, PAGE)).channels.map((c) => c.channelId)).toEqual([channelId]);
    expect(sshdNow(), "the open channel has a session on the server").toBeGreaterThan(idle);
    expect(await call(rpc, "sftp_access_revoke", { pluginId: "makosh-commander", profileId: pw.id }, PAGE)).toEqual({ revoked: true, channelsClosed: 1 });
    expect((await call(rpc, "sftp_access_list", {}, PAGE)).channels).toEqual([]);
    expect(await refusal(call(rpc, "hub_sftp_op", { channelId, op: "realpath", path: text(".") }, COMMANDER))).toBe("consent_revoked");
    expect(await refusal(call(rpc, "hub_sftp_open", { profileId: pw.id }, COMMANDER))).toBe("consent_revoked");
    expect((await call(rpc, "hub_sftp_grants", {}, COMMANDER)).grants.find((g) => g.profileId === pw.id)?.state).toBe("revoked");
    expect(events).toContain(JSON.stringify({ channelId, state: "revoked" }));
    // The other plugin's grant on the same connection is untouched.
    const other = await call(rpc, "hub_sftp_open", { profileId: pw.id }, STRANGER);
    await call(rpc, "hub_sftp_close", { channelId: other.channelId }, STRANGER);
    // ssh of the revoked channel is gone too.
    await sleep(3000);
    expect(sshdNow(), "the revoked channel's session is gone from the server").toBe(idle);
  }, 120_000);

  it("no answer, refusal, event or helper log holds a secret, a key path, a credential reference or a temp path", () => {
    const everything = [...spoken, ...events, stderr].join("\n");
    expect(spoken.length).toBeGreaterThan(40);
    for (const [what, needle] of [
      ["the password", PASSWORD],
      ["the passphrase", PASSPHRASE],
      ["the temp directory (key files, the Keychain, ssh configuration)", tmp],
      ["a key file name", "id_locked"],
      ["a credential reference", "rh-cred:"],
      ["the Keychain file", "keychain-db"],
      ["the agent socket", "agent.sock"],
    ] as const) {
      expect(everything.includes(needle), what).toBe(false);
    }
  });
});
