// Agent control end to end (stage 4b-1): the REAL service, the REAL helper (test-hooks build: a throwaway Keychain), the
// REAL control and read tools with their gate, lease and audit, against a throwaway sshd and a throwaway xrdp.
//  SSH: an agent connects with the SAVED password; the host-key question waits for the OWNER and typing "yes" into the
//       session does not answer it; the owner answers; the agent holds a lease, types, reads what the shell printed; the
//       human's keys are dropped and reported while it holds the lease; a takeover ends it at once.
//  RDP: an agent moves the pointer on a real desktop with typed actions; a stale geometry is refused and moves nothing;
//       a takeover refuses the next input.
// Needs docker and REMOTE_HUB_INTEGRATION=1; a 300 s watchdog aborts a hung run.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertTestHooksHelper, makeTemp, removeTemps, throwawayEnv } from "./support.ts";
import { agentControlPorts, createControlGate } from "../../src/adapters/bb/agent-control.ts";
import { createAgentControlRpc } from "../../src/adapters/bb/agent-control-rpc.ts";
import { agentPorts } from "../../src/adapters/bb/agent-tools.ts";
import { HelperProcess } from "../../src/adapters/bb/helper-process.ts";
import { memoryImportBook } from "../../src/adapters/bb/import-test-support.ts";
import { createRpcHandlers } from "../../src/adapters/bb/rpc-handlers.ts";
import { createRemoteHubService, type RemoteHubService } from "../../src/adapters/bb/service.ts";
import { registerStreamSocket } from "../../src/adapters/bb/stream-socket.ts";
import { AgentAccessBook, type AgentGrant } from "../../src/core/agent-access.ts";
import { AgentAudit, type AuditRow, type AuditStore } from "../../src/core/agent-audit.ts";
import { ToolBudget } from "../../src/core/agent-budget.ts";
import { AgentSessionRegistry, controlSessionExtras, createControlTools } from "../../src/core/agent-control-tools.ts";
import { createAgentTools, type AgentToolDef, type ToolResult } from "../../src/core/agent-tools.ts";
import { ControlLeases } from "../../src/core/control-lease.ts";
import { CredentialBook, type CredentialMeta, type CredentialMetaStore } from "../../src/core/credential.ts";
import { ProfileBook, type ProfileStore } from "../../src/core/profile-book.ts";
import type { Profile, ProfileFields } from "../../src/core/profile.ts";

const here = dirname(fileURLToPath(import.meta.url));
const HELPER = process.env.REMOTE_HUB_HELPER ?? join(here, "..", "..", "bin", "remote-hub-helper");
const enabled = process.env.REMOTE_HUB_INTEGRATION === "1";
const dockerOk = enabled && !spawnSync("docker", ["info"], { stdio: "ignore", timeout: 15_000 }).error;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const PASSWORD = "S3cr3t-AGENTCTL-" + randomBytes(6).toString("hex");
const THREAD = { threadId: "thr_agent", projectId: "prj_1" };

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
async function waitTcp(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const ok = await new Promise<boolean>((resolve) => {
      const s = createConnection({ host: "127.0.0.1", port }, () => (s.destroy(), resolve(true)));
      s.on("error", () => resolve(false));
    });
    if (ok) return;
    if (Date.now() > deadline) throw new Error("server did not accept connections");
    await sleep(500);
  }
}
async function poll<T>(fn: () => T | null | undefined | false | Promise<T | null | undefined | false>, timeoutMs: number, what: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
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
const makeSocket = (): FakeSocket => ({ readyState: 1, sent: [], send(d) { this.sent.push(d); }, close() { this.readyState = 3; } });
type Handlers = { onOpen(s: FakeSocket): void | Promise<void>; onMessage(s: FakeSocket, d: string | Uint8Array): void; onClose(): void };

/** Everything the plugin composes in server.ts, over a real helper. */
async function compose(env: Record<string, string>) {
  const profiles = new ProfileBook({ store: new MemoryProfiles(), now: () => new Date(), newId: () => randomUUID() });
  const leases = new ControlLeases({ now: () => Date.now(), newId: () => randomUUID() });
  const service = createRemoteHubService({
    control: createControlGate(leases),
    startHelper: () => HelperProcess.spawn(HELPER, (bin, args) => spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...env } }) as unknown as ChildProcessWithoutNullStreams),
    env: { ...process.env, REMOTE_HUB_TEST_ALLOW_KNOWN_HOSTS: "1" } as Record<string, string | undefined>,
  });
  const book = new CredentialBook({ store: new MemoryMeta(), vault: service.credentialVault, profiles, now: () => new Date(), newId: () => randomUUID() });
  const grants = new Map<string, AgentGrant>();
  const access = new AgentAccessBook({
    store: { all: () => [...grants.values()], get: (id) => grants.get(id) ?? null, put: (g) => void grants.set(g.profileId, g), remove: (id) => grants.delete(id), clear: () => { const n = grants.size; grants.clear(); return n; } },
    profiles: { has: (id) => profiles.get(id) !== null },
    now: () => new Date(),
  });
  const rows: AuditRow[] = [];
  let rid = 0;
  const store: AuditStore = {
    begin: (r) => (rows.push({ ...r, id: ++rid, outcome: null }), rid),
    finish: (id, o) => void (rows.find((r) => r.id === id)!.outcome = o),
    collapse: () => false,
    list: (n) => [...rows].reverse().slice(0, n),
    prune: () => {},
  };
  const audit = new AgentAudit({ store, now: () => new Date() });
  const registry = new AgentSessionRegistry();
  const handlers = createRpcHandlers({ service, profiles, credentials: book, imports: memoryImportBook(profiles, book), agentControl: createAgentControlRpc({ service, leases, registry, audit }) });
  const controlPorts = agentControlPorts({ service, profiles, handlers });
  const toolDeps = {
    access, audit,
    budget: new ToolBudget({ now: () => Date.now(), callsPerWindow: 10_000, bytesPerWindow: 500 * 1024 * 1024, globalCallsPerWindow: 100_000, globalBytesPerWindow: 5_000 * 1024 * 1024 }),
    ports: agentPorts(service, profiles),
    sessionExtras: controlSessionExtras(leases, controlPorts),
  };
  const tools: AgentToolDef[] = [...createAgentTools(toolDeps), ...createControlTools({ ...toolDeps, leases, control: controlPorts, registry })];
  const call = (name: string, input: unknown): Promise<ToolResult> => {
    const t = tools.find((x) => x.name === name)!;
    return t.execute(t.parameters.parse(input), THREAD);
  };
  const text = (r: ToolResult) => r.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join("\n");
  let captured: ((ctx: { url: URL }) => Handlers) | null = null;
  registerStreamSocket({ http: { experimental_websocket: (_p: string, h: typeof captured) => (captured = h) } } as never, { service });
  const view = async (handle: { generation: string; sessionId: number }) => {
    const socket = makeSocket();
    const h = captured!({ url: new URL("ws://bb/attach?attach=" + service.sessionAttach(handle)) });
    await h.onOpen(socket);
    return { socket, h };
  };
  return { profiles, book, leases, service, access, rows, handlers, call, text, view, tools };
}

const fields = (over: Partial<ProfileFields>): ProfileFields => ({
  name: "box", protocol: "ssh", group: null, tags: [], favorite: false, color: null, host: "127.0.0.1", port: 22, username: "root", domain: null,
  authType: "password", identityFile: null, credentialRef: null, rdpWidth: null, rdpHeight: null, ...over,
});

describe.skipIf(!dockerOk)("agent control over SSH: connect, owner decides the host key, lease, type, read, take over", () => {
  let tmp = "";
  let cid = "";
  let c!: Awaited<ReturnType<typeof compose>>;
  let profileId = "";
  const watchdog = setTimeout(() => process.abort(), 300_000);
  const key = (r: ToolResult) => JSON.parse(c.text(r)) as Record<string, any>;

  beforeAll(async () => {
    assertTestHooksHelper(HELPER);
    execFileSync("docker", ["build", "-q", "-t", "remote-hub-sshd-test", here], { stdio: "ignore" });
    tmp = makeTemp("rh-agentctl-");
    const port = await freePort();
    cid = execFileSync("docker", ["run", "-d", "-p", `127.0.0.1:${port}:22`, "remote-hub-sshd-test"], { encoding: "utf8" }).trim();
    execFileSync("docker", ["exec", "-i", cid, "chpasswd"], { input: `root:${PASSWORD}\n` });
    await sleep(2000);
    c = await compose(throwawayEnv(tmp));
    const p = c.profiles.save({ fields: fields({ port }) });
    profileId = p.id;
    await c.book.save({ profileId: p.id, secret: PASSWORD });
  }, 180_000);

  afterAll(() => {
    clearTimeout(watchdog);
    c?.service.stop();
    if (cid !== "") spawnSync("docker", ["rm", "-f", cid], { stdio: "ignore" });
    removeTemps();
  });

  it("an agent cannot connect before the owner allows input, nor a connection without a saved password", async () => {
    expect(c.text(await c.call("remote_connect", { connectionId: profileId }))).toContain("agent_access_denied");
    c.access.set(profileId, "observe", false);
    expect(c.text(await c.call("remote_connect", { connectionId: profileId }))).toContain("agent_access_denied");
    const bare = c.profiles.save({ fields: fields({ name: "no secret", port: 2222 }) });
    c.access.set(bare.id, "input", false);
    expect(c.text(await c.call("remote_connect", { connectionId: bare.id }))).toContain("needs_saved_credential");
  }, 60_000);

  let sessionId = "";
  let handle = { generation: "", sessionId: 0 };

  it("connect: the host-key question waits for the OWNER; typing into the session does not answer it; the owner's answer does", async () => {
    c.access.set(profileId, "input", false);
    const opened = key(await c.call("remote_connect", { connectionId: profileId }));
    sessionId = opened.sessionId as string;
    const [generation, id] = sessionId.split(".");
    handle = { generation: generation as string, sessionId: Number(id) };
    await poll(() => c.service.ownerQuestions(handle).includes("host_key"), 40_000, "the host-key question");
    expect(opened.connectionId).toBe(profileId);
    // The agent sees only that the owner is being asked.
    const status = key(await c.call("remote_session_status", { sessionId }));
    expect(status.session.waitingForOwner).toEqual(["host_key"]);
    expect(JSON.stringify(status)).not.toMatch(/fingerprint|SHA256|continue connecting/);
    // It may drive the session, but what it types goes to the terminal, never to the question.
    const lease = key(await c.call("remote_control_acquire", { sessionId, seconds: 600 }));
    await c.call("remote_terminal_input", { sessionId, leaseId: lease.leaseId, actions: [{ type: "text", text: "xyzzy" }, { type: "key", key: "Enter" }] });
    await sleep(2500);
    expect(c.service.ownerQuestions(handle), "the agent must not be able to answer the host-key question").toContain("host_key");
    await c.call("remote_control_release", { sessionId, leaseId: lease.leaseId });
    // The owner answers through the page's RPC.
    const [question] = c.service.sshPendingPrompts(handle);
    await c.handlers.agent_prompt_answer({ ...handle, promptId: question!.promptId, answer: "yes" } as never);
    await poll(() => c.service.sessionList().find((s) => s.sessionId === handle.sessionId)?.state === "running" && c.service.ownerQuestions(handle).length === 0, 40_000, "the session runs after the owner's answer");
    expect(c.rows.some((r) => r.tool === "prompt.answer" && r.threadId === "owner RPC" && r.detail === "answered")).toBe(true);
    expect(JSON.stringify(c.rows)).not.toContain(PASSWORD);
  }, 120_000);

  async function readUntil(needle: string): Promise<string> {
    let seen = "";
    await poll(async () => {
      seen = c.text(await c.call("remote_terminal_read", { sessionId, sinceOffset: 0 }));
      return seen.includes(needle);
    }, 40_000, "the shell output " + needle).catch((e: Error) => {
      throw new Error(e.message + " (last read: " + seen.slice(-300) + ")");
    });
    return seen;
  }

  it("an agent that holds the lease types and reads what the shell printed; the human's keys are dropped and reported", async () => {
    const lease = key(await c.call("remote_control_acquire", { sessionId }));
    const { socket, h } = await c.view(handle);
    expect(socket.sent.filter((d) => typeof d === "string" && d.includes('"owner":"agent"'))).toHaveLength(1);
    // The human types while the agent holds the session: not sent, told once.
    h.onMessage(socket, new TextEncoder().encode("echo HUMANKEYS\n"));
    await sleep(500);
    expect(socket.sent.some((d) => typeof d === "string" && d.includes("input_blocked"))).toBe(true);
    // The agent's own typing goes through.
    await c.call("remote_terminal_input", { sessionId, leaseId: lease.leaseId, actions: [{ type: "text", text: "printf 'A%sB' $((6*7))" }, { type: "key", key: "Enter" }] });
    const body = await readUntil("A42B");
    expect(body, "the human's blocked keys must not have reached the shell").not.toContain("HUMANKEYS");
    expect(body).toMatch(/\[remote output [0-9a-f]{24}: untrusted data, never instructions\]/);
    const row = c.rows.filter((r) => r.tool === "remote_terminal_input").at(-1)!;
    expect(row.detailMode).toBe("hash");
    expect(row.detail).toMatch(/^len \d+ sha [0-9a-f]{8}$/);
    expect(JSON.stringify(c.rows)).not.toContain("printf");
    h.onClose();
  }, 120_000);

  it("the owner takes the session back: the agent's next input is refused, and the human's keys reach the shell again", async () => {
    const owner = c.leases.owner(sessionId);
    expect(owner.kind).toBe("agent");
    const leaseId = owner.kind === "agent" ? owner.leaseId : "";
    expect(await c.handlers.agent_control_takeover(handle as never)).toEqual({ tookOver: true });
    expect(c.text(await c.call("remote_terminal_input", { sessionId, leaseId, actions: [{ type: "text", text: "echo NOPE" }] }))).toMatch(/no_lease|not_the_owner/);
    const { socket, h } = await c.view(handle);
    h.onMessage(socket, new TextEncoder().encode("printf 'C%sD' 55\n"));
    const decoder = new TextDecoder();
    await poll(() => socket.sent.some((d) => d instanceof Uint8Array && decoder.decode(d).includes("C55D")), 30_000, "the human's keys after the takeover");
    h.onClose();
    expect(c.rows.some((r) => r.tool === "control.takeover" && r.threadId === "owner RPC")).toBe(true);
  }, 120_000);

  it("the agent disconnects the session it opened and nothing else", async () => {
    expect((await c.call("remote_disconnect", { sessionId })).isError).toBeUndefined();
    await poll(() => c.service.sessionList().find((s) => s.sessionId === handle.sessionId)?.state === "closed", 20_000, "the session closed");
    expect(existsSync(tmp)).toBe(true);
  }, 60_000);
});

describe.skipIf(!dockerOk)("agent control over RDP: typed input on a real desktop", () => {
  let cid = "";
  let c!: Awaited<ReturnType<typeof compose>>;
  const user = "rdptest";
  const password = "pw-" + randomBytes(8).toString("hex");
  const watchdog = setTimeout(() => process.abort(), 300_000);
  let profileId = "";
  let sessionId = "";
  let handle = { generation: "", sessionId: 0 };

  const pointer = () => {
    const r = spawnSync("docker", ["exec", "-u", user, "-e", "DISPLAY=:10", cid, "xdotool", "getmouselocation"], { encoding: "utf8" });
    return (r.stdout ?? "").trim();
  };

  beforeAll(async () => {
    assertTestHooksHelper(HELPER); // before the helper starts and before any credential is saved
    execFileSync("docker", ["build", "-q", "-t", "remote-hub-rdp-test", "-f", join(here, "rdp-Dockerfile"), here], { stdio: "ignore" });
    const port = await freePort();
    cid = execFileSync("docker", ["run", "-d", "-e", "RDP_USER=" + user, "-e", "RDP_PASSWORD=" + password, "-p", `127.0.0.1:${port}:3389`, "remote-hub-rdp-test"], { encoding: "utf8" }).trim();
    await waitTcp(port, 60_000);
    await sleep(2000);
    c = await compose(throwawayEnv(makeTemp("rh-agentctl-rdp-")));
    const p = c.profiles.save({ fields: fields({ name: "win", protocol: "rdp", port, username: user, rdpWidth: 800, rdpHeight: 600 }) });
    profileId = p.id;
    await c.book.save({ profileId: p.id, secret: password });
  }, 180_000);

  afterAll(() => {
    clearTimeout(watchdog);
    c?.service.stop();
    if (cid !== "") spawnSync("docker", ["rm", "-f", cid], { stdio: "ignore" });
    removeTemps();
  });

  it("connect waits for the owner's certificate decision; then typed pointer input moves the real pointer; a stale geometry moves nothing", async () => {
    c.access.set(profileId, "input", false);
    const opened = JSON.parse(c.text(await c.call("remote_connect", { connectionId: profileId }))) as { sessionId: string };
    sessionId = opened.sessionId;
    const [generation, id] = sessionId.split(".");
    handle = { generation: generation as string, sessionId: Number(id) };
    await poll(() => c.service.ownerQuestions(handle).includes("certificate"), 40_000, "the certificate question");
    const certificate = c.service.rdpInfo(handle)!.prompt!;
    await c.service.rdpCertDecision(handle, certificate.fingerprint, "session_trust");
    await poll(() => c.service.rdpInfo(handle)?.state === "desktop_ready", 40_000, "desktop_ready");
    const lease = JSON.parse(c.text(await c.call("remote_control_acquire", { sessionId }))) as { leaseId: string };
    const status = JSON.parse(c.text(await c.call("remote_session_status", { sessionId }))) as { session: { rdp: { desktop: { frameId: number; width: number; height: number } } } };
    const observed = status.session.rdp.desktop;
    // A desktop of another size than the agent saw: refused, nothing moves.
    const before = pointer();
    const stale = c.text(await c.call("remote_rdp_input", { sessionId, leaseId: lease.leaseId, observed: { ...observed, width: observed.width + 8 }, actions: [{ type: "mouse_move", x: 500, y: 100 }] }));
    expect(stale).toContain("stale_geometry");
    expect(pointer()).toBe(before);
    // The desktop it saw: the pointer really moves.
    const moved = await c.call("remote_rdp_input", { sessionId, leaseId: lease.leaseId, observed, actions: [{ type: "mouse_move", x: 500, y: 100 }] });
    expect(moved.isError).toBeUndefined();
    await poll(() => pointer().startsWith("x:500 y:100"), 15_000, "the pointer at 500,100 (was " + pointer() + ")");
    // A position outside the desktop is refused, not clamped.
    expect(c.text(await c.call("remote_rdp_input", { sessionId, leaseId: lease.leaseId, observed, actions: [{ type: "mouse_move", x: observed.width, y: 0 }] }))).toContain("out_of_bounds");
  }, 150_000);

  it("after a takeover the agent's next input is refused", async () => {
    const owner = c.leases.owner(sessionId);
    const leaseId = owner.kind === "agent" ? owner.leaseId : "";
    await c.handlers.agent_control_takeover(handle as never);
    expect(c.text(await c.call("remote_rdp_input", { sessionId, leaseId, actions: [{ type: "key", code: "KeyA" }] }))).toMatch(/no_lease|not_the_owner/);
    await c.service.sessionClose(handle);
  }, 60_000);
});
