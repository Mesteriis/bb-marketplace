// Node integration for Remote Hub: drives the REAL registerStreamSocket route
// handlers against the real Rust helper (a fake bb.http + fake socket + acks
// from a fake renderer). No manual credit anywhere.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HelperProcess } from "../../src/adapters/bb/helper-process.ts";
import { createCreditWindow } from "../../src/core/credit.ts";
import type { SessionHandle } from "../../src/core/rpc.ts";
import { createRemoteHubService, type RemoteHubService } from "../../src/adapters/bb/service.ts";
import { registerStreamSocket } from "../../src/adapters/bb/stream-socket.ts";

const here = dirname(fileURLToPath(import.meta.url));
const HELPER =
  process.env.REMOTE_HUB_HELPER ??
  join(here, "..", "..", "bin", "remote-hub-helper");
const IMAGE = "remote-hub-sshd-test";

const enabled = process.env.REMOTE_HUB_INTEGRATION === "1";

function dockerAvailable(): boolean {
  const r = spawnSync("docker", ["info"], { stdio: "ignore", timeout: 15_000 });
  return !r.error && r.status === 0;
}

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

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

const spawnHelper = (bin: string) =>
  HelperProcess.spawn(
    bin,
    (b, args) => spawn(b, args, { stdio: ["pipe", "pipe", "pipe"] }) as unknown as ChildProcessWithoutNullStreams,
  );

interface FakeSocket {
  readyState: number;
  sent: Array<string | Uint8Array>;
  closed: Array<{ code?: number; reason?: string }>;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
}

function makeSocket(): FakeSocket {
  return {
    readyState: 1,
    sent: [],
    closed: [],
    send(data) {
      this.sent.push(data);
    },
    close(code, reason) {
      this.readyState = 3;
      this.closed.push({ code, reason });
    },
  };
}

type SocketHandlers = {
  onOpen(socket: FakeSocket): Promise<void>;
  onMessage(socket: FakeSocket, data: string | Uint8Array): void;
  onClose(): void;
  onError(): void;
};

function wireSocket(service: RemoteHubService): (url: string) => SocketHandlers {
  let captured: ((ctx: { url: URL }) => SocketHandlers) | null = null;
  const bb = {
    http: { experimental_websocket(_path: string, h: typeof captured) { captured = h; } },
  };
  registerStreamSocket(bb as never, { service });
  return (url: string) => captured!( { url: new URL(url) } );
}

async function drainAndAck(socket: FakeSocket, handlers: SocketHandlers, needle: string, timeoutMs = 10_000): Promise<string> {
  const decoder = new TextDecoder();
  let out = "";
  const acked = new Set<Uint8Array>();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const data of socket.sent) {
      if (data instanceof Uint8Array && !acked.has(data)) {
        acked.add(data);
        out += decoder.decode(data, { stream: true });
        handlers.onMessage(socket, JSON.stringify({ type: "ack", bytes: data.byteLength }));
      }
    }
    if (out.includes(needle)) return out;
    await sleep(15);
  }
  return out;
}

const runDocker = enabled && dockerAvailable();

it("docker is available when integration is requested", () => {
  if (enabled && !dockerAvailable()) {
    console.log("not run");
    throw new Error("not run: docker unavailable");
  }
});

describe.skipIf(!runDocker)("ssh service integration through the real socket handlers", () => {
  let tmp: string;
  let cid: string;
  let port: number;
  let key: string;
  let knownHosts: string;
  let cfg: string;
  let service: RemoteHubService;

  beforeAll(async () => {
    execFileSync("docker", ["build", "-q", "-t", IMAGE, here], { stdio: "ignore" });
    tmp = mkdtempSync(join(tmpdir(), "rh-"));
    key = join(tmp, "id_ed25519");
    execFileSync("ssh-keygen", ["-t", "ed25519", "-N", "", "-f", key, "-q"]);
    port = await freePort();
    cid = execFileSync("docker", ["run", "-d", "-p", "127.0.0.1:" + port + ":22", IMAGE])
      .toString()
      .trim();
    const pub = execFileSync("cat", [key + ".pub"]);
    execFileSync(
      "docker",
      ["exec", "-i", cid, "sh", "-c", "mkdir -p /root/.ssh && cat > /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys"],
      { input: pub },
    );
    await sleep(2000);
    const hostkey = execFileSync("docker", ["exec", cid, "cat", "/etc/ssh/ssh_host_ed25519_key.pub"])
      .toString()
      .trim();
    knownHosts = join(tmp, "known_hosts");
    writeFileSync(knownHosts, "[127.0.0.1]:" + port + " " + hostkey + "\n");
    cfg = join(tmp, "config");
    writeFileSync(cfg, "Host rh\n");

    const helper = await spawnHelper(HELPER);
    service = createRemoteHubService({
      startHelper: async () => helper,
      env: process.env as Record<string, string | undefined>,
    });
  }, 120_000);

  afterAll(() => {
    service.stop();
    if (cid) spawnSync("docker", ["rm", "-f", cid], { stdio: "ignore" });
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it("case 1: key auth echoes a UTF-8 line through the real socket, acked by the renderer", async () => {
    const target = { host: "127.0.0.1", port, configFile: cfg, knownHostsFile: knownHosts, identityFile: key, extraOptions: [] as string[] };
    const handle = await service.sshOpen(target, 80, 24);
    const token = service.sessionAttach(handle);
    const wire = wireSocket(service);
    const handlers = wire("ws://bb/api/attach?attach=" + token);
    const socket = makeSocket();
    await handlers.onOpen(socket);
    handlers.onMessage(socket, new TextEncoder().encode("printf 'h\u00e9llo-ok'\n"));
    const out = await drainAndAck(socket, handlers, "h\u00e9llo-ok");
    expect(out).toContain("h\u00e9llo-ok");
  });

  it("case 5: unknown host key prompts, runs nothing, and no closes with 255 ssh_error", async () => {
    const emptyKh = join(tmp, "empty_known_hosts");
    writeFileSync(emptyKh, "");
    const target = { host: "127.0.0.1", port, configFile: cfg, knownHostsFile: emptyKh, identityFile: key, extraOptions: [] as string[] };
    const handle = await service.sshOpen(target, 80, 24);
    const token = service.sessionAttach(handle);
    const wire = wireSocket(service);
    const handlers = wire("ws://bb/api/attach?attach=" + token);
    const socket = makeSocket();
    await handlers.onOpen(socket);
    const out = await drainAndAck(socket, handlers, "Are you sure you want to continue connecting");
    expect(out).not.toContain("Welcome to Alpine");
    expect(out).not.toContain("~#");
    handlers.onMessage(socket, new TextEncoder().encode("no\n"));
    await sleep(1000);
    const info = service.sessionList().find((s) => s.generation === handle.generation && s.sessionId === handle.sessionId);
    expect(info?.state).toBe("closed");
    expect(info?.exitCode).toBe(255);
    expect(info?.reason).toBe("ssh_error");
    expect(statSync(emptyKh).size).toBe(0);
  });
});

// A small test-only harness around HelperProcess for a free-form (test-hooks)
// session. The credit window logic is the real createCreditWindow; only the
// service wiring around it is reimplemented, so the production service never
// accepts program/argv/env from a caller.
function rawSessionService(hp: HelperProcess, handle: SessionHandle): RemoteHubService {
  const credit = createCreditWindow();
  let ownerId: string | null = null;
  const listeners = new Set<(data: Uint8Array) => void>();
  hp.onSessionOutput((sessionId, data) => {
    if (sessionId === handle.sessionId) {
      for (const cb of listeners) cb(data);
    }
  });
  return {
    consumeAttachToken: () => ({ sessionId: handle.sessionId, generation: handle.generation }),
    sessionList: () => [
      { generation: handle.generation, sessionId: handle.sessionId, kind: "ssh", state: "running", exitCode: null, signal: null, reason: null },
    ],
    attachStream: () => ({
      snapshot: hp.scrollbackSnapshot(handle.sessionId),
      subscribe: (cb) => {
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
    }),
    subscribeSessionEnd: () => () => {},
    onHelperExit: () => () => {},
    creditAttach: (_h, attachId) => {
      if (ownerId === null) {
        ownerId = attachId;
        return { grant: credit.attach(), isOwner: true };
      }
      return { grant: 0, isOwner: false };
    },
    creditDetach: (_h, attachId) => {
      if (ownerId === attachId) {
        ownerId = null;
        credit.detach();
      }
    },
    creditAck: (_h, attachId, bytes) => (ownerId === attachId ? credit.ack(bytes) : 0),
    sessionCredit: (h, bytes) => hp.credit(h, bytes),
    sessionResize: (h, cols, rows) => hp.resize(h, cols, rows),
    sessionTerminalInput: (h, data) => {
      hp.writeInput(h.sessionId, data);
      return Promise.resolve();
    },
    helperStatus: async () => ({ version: "0.1.0", pid: 0, platform: "test", sessionCount: 1, alive: true }),
    echoOpen: async () => handle,
    echoInput: async () => ({ output: "", truncated: false }),
    echoClose: async () => ({ closed: true }),
    sshOpen: async () => handle,
    sessionClose: async () => ({ exitCode: null, signal: null, reason: "exited" }),
    sessionAttach: () => "",
    sessionScrollback: async () => hp.scrollbackSnapshot(handle.sessionId),
    subscribeSession: () => () => {},
    stop: () => hp.stop(),
  } as RemoteHubService;
}

describe.skipIf(!enabled)("credit flow through the real socket (test-hooks)", () => {
  it("receives PROBE-42 from /bin/sh with only renderer acks", async () => {
    const hp = await spawnHelper(HELPER);
    const handle = await hp.openSsh(
      { program: "/bin/sh", argv: ["sh", "-c", "echo PROBE-$((6*7))"], env: { TERM: "xterm-256color" } },
      80,
      24,
    );
    const service = rawSessionService(hp, handle);
    const wire = wireSocket(service);
    const handlers = wire("ws://bb/api/attach?attach=probe");
    const socket = makeSocket();
    await handlers.onOpen(socket);
    const out = await drainAndAck(socket, handlers, "PROBE-42");
    expect(out).toContain("PROBE-42");
    service.stop();
  });
});
