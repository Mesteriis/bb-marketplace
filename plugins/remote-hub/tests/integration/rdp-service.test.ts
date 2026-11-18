// Case 6b and case 8 of the stage-2b contract through the REAL service, the REAL
// attach-socket handlers and the REAL helper, against a throwaway xrdp container
// (tests/integration/rdp-Dockerfile). Needs docker and REMOTE_HUB_INTEGRATION=1.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, createConnection } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HelperProcess } from "../../src/adapters/bb/helper-process.ts";
import { createRemoteHubService, type RemoteHubService } from "../../src/adapters/bb/service.ts";
import { registerStreamSocket } from "../../src/adapters/bb/stream-socket.ts";
import type { SessionHandle } from "../../src/core/rpc.ts";

const here = dirname(fileURLToPath(import.meta.url));
const HELPER = process.env.REMOTE_HUB_HELPER ?? join(here, "..", "..", "bin", "remote-hub-helper");
const IMAGE = "remote-hub-rdp-test";
const enabled = process.env.REMOTE_HUB_INTEGRATION === "1";

function dockerAvailable(): boolean {
  const r = spawnSync("docker", ["info"], { stdio: "ignore", timeout: 15_000 });
  return !r.error && r.status === 0;
}
const runDocker = enabled && dockerAvailable();

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

async function waitTcp(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const ok = await new Promise<boolean>((resolve) => {
      const s = createConnection({ host: "127.0.0.1", port }, () => {
        s.destroy();
        resolve(true);
      });
      s.on("error", () => resolve(false));
    });
    if (ok) return;
    if (Date.now() > deadline) throw new Error("xrdp did not accept connections");
    await sleep(500);
  }
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

function dexec(cid: string, user: string | null, ...cmd: string[]): { code: number; out: string } {
  const args = ["exec", ...(user !== null ? ["-u", user] : []), ...(cmd[0] === "xdotool" ? ["-e", "DISPLAY=:10"] : []), cid, ...cmd];
  const r = spawnSync("docker", args, { encoding: "utf8" });
  return { code: r.status ?? -1, out: r.stdout ?? "" };
}

function certFingerprint(cid: string): string {
  const out = execFileSync("docker", ["exec", cid, "openssl", "x509", "-in", "/etc/xrdp/cert.pem", "-noout", "-fingerprint", "-sha256"], { encoding: "utf8" });
  return out.trim().split("=")[1];
}

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
type Handlers = {
  onOpen(socket: FakeSocket): void | Promise<void>;
  onMessage(socket: FakeSocket, data: string | Uint8Array): void;
  onClose(): void;
};

const frameIdOf = (d: Uint8Array) => Number(new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(0, true));

/** A renderer: acks every update it has not acked yet, unless `silent`. */
class View {
  readonly socket = makeSocket();
  readonly frames: number[] = [];
  private seen = 0;
  constructor(readonly handlers: Handlers, readonly silent: boolean) {}
  pump(): void {
    for (; this.seen < this.socket.sent.length; this.seen++) {
      const d = this.socket.sent[this.seen];
      if (typeof d === "string") continue;
      const id = frameIdOf(d);
      this.frames.push(id);
      if (!this.silent) this.handlers.onMessage(this.socket, JSON.stringify({ type: "ack", frameId: id }));
    }
  }
  distinct(): number[] {
    return Array.from(new Set(this.frames));
  }
  last(): number | undefined {
    return this.frames.at(-1);
  }
}

describe.skipIf(!runDocker)("RDP service against xrdp (cases 6b and 8)", () => {
  let cid = "";
  let port = 0;
  const user = "rdptest";
  const password = "pw-" + randomBytes(8).toString("hex");
  let service: RemoteHubService;
  let wire: (url: string) => Handlers;
  const views: View[] = [];

  const newService = () => {
    const created = createRemoteHubService({
      startHelper: () =>
        HelperProcess.spawn(HELPER, (bin, args) => spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"], env: {} }) as unknown as ChildProcessWithoutNullStreams),
      env: {},
    });
    let captured: ((ctx: { url: URL }) => Handlers) | null = null;
    registerStreamSocket({ http: { experimental_websocket(_p: string, h: typeof captured) { captured = h; } } } as never, { service: created });
    return { created, wire: (url: string) => captured!({ url: new URL(url) }) };
  };

  const attachView = async (handle: SessionHandle, silent: boolean): Promise<View> => {
    const handlers = wire("ws://x/attach?attach=" + service.sessionAttach(handle));
    const view = new View(handlers, silent);
    await handlers.onOpen(view.socket);
    views.push(view);
    return view;
  };

  const pumpAll = () => views.forEach((v) => v.pump());

  async function connect(): Promise<SessionHandle> {
    const handle = await service.rdpOpen({ host: "127.0.0.1", port, username: user, password }, 800, 600);
    return handle;
  }

  beforeAll(async () => {
    execFileSync("docker", ["build", "-q", "-t", IMAGE, "-f", join(here, "rdp-Dockerfile"), here], { stdio: "ignore" });
    port = await freePort();
    cid = execFileSync(
      "docker",
      ["run", "-d", "-e", "RDP_USER=" + user, "-e", "RDP_PASSWORD=" + password, "-p", "127.0.0.1:" + port + ":3389", IMAGE],
      { encoding: "utf8" },
    ).trim();
    await waitTcp(port, 60_000);
    await sleep(2000);
    const made = newService();
    service = made.created;
    wire = made.wire;
  }, 180_000);

  afterAll(() => {
    service?.stop();
    if (cid !== "") spawnSync("docker", ["rm", "-f", cid], { stdio: "ignore" });
  });

  it("case 8: two views show the same frame after quiescence; a view that never acks receives exactly one update while the other keeps updating", async () => {
    const fp = certFingerprint(cid);
    const handle = await connect();
    const prompt = await poll(() => service.rdpInfo(handle)?.prompt, 30_000, "cert prompt");
    expect(prompt.fingerprint).toBe(fp);
    await service.rdpCertDecision(handle, fp, "session_trust"); // trust for this BB run (used by case 6b)
    await poll(() => service.rdpInfo(handle)?.state === "desktop_ready", 30_000, "desktop_ready");
    for (let i = 0; i < 60 && dexec(cid, null, "pgrep", "-u", user, "xterm").code !== 0; i++) await sleep(500);

    const a = await attachView(handle, false);
    const b = await attachView(handle, false);
    // Both views get the full frame; they ack every update they receive.
    await poll(() => (pumpAll(), a.frames.length > 0 && b.frames.length > 0), 20_000, "first update on both views");
    // Force a known full frame to both views (a refresh from view A), then compare
    // what each has been shown: both ack everything, so both receive every update
    // and their histories end identically (the desktop itself never goes fully
    // quiet: the xterm cursor blinks).
    const refreshFrom = a.frames.length;
    a.handlers.onMessage(a.socket, JSON.stringify({ type: "refresh" }));
    await poll(() => (pumpAll(), a.frames.length > refreshFrom && b.frames.length > 0), 20_000, "the refreshed frame on both views");
    // What must hold is not that the two histories are identical at one instant: the desktop keeps painting (the cursor
    // blinks) and a view that is busy may legitimately skip an intermediate update while the other receives it. What must
    // hold is that each view only ever moves FORWARD, and that both end on the same newest frame.
    pumpAll();
    const forward = (ids: number[]) => ids.every((id, i) => i === 0 || id >= (ids[i - 1] as number));
    expect(forward(a.frames), JSON.stringify(a.frames)).toBe(true);
    expect(forward(b.frames), JSON.stringify(b.frames)).toBe(true);
    await poll(() => (pumpAll(), a.last() !== undefined && a.last() === b.last()), 20_000, "both views end on the same newest frame");

    // A third view never acks. It gets exactly the one full update it is sent on attach.
    const silent = await attachView(handle, true);
    await poll(() => (pumpAll(), silent.frames.length > 0), 20_000, "the silent view's first update " + JSON.stringify({ a: a.frames.slice(-5), b: b.frames.slice(-5), c: silent.frames, texts: silent.socket.sent.filter((x) => typeof x === "string") }));
    await sleep(500);
    pumpAll();
    const silentFrame = silent.distinct();
    expect(silentFrame.length).toBe(1);
    // Real paints: move over the xterm and type; view A keeps receiving updates.
    const before = a.distinct().length;
    const geom = { fbWidth: 800, fbHeight: 600 };
    const [moveSocket, moveHandlers] = [a.socket, a.handlers] as const;
    moveHandlers.onMessage(moveSocket, JSON.stringify({ type: "input", events: [{ kind: "mouse_move", x: 500, y: 100, ...geom }] }));
    await poll(() => dexec(cid, user, "xdotool", "getmouselocation").out.startsWith("x:500 y:100"), 10_000, "pointer over the xterm");
    const keys = [0x1e, 0x30, 0x2e, 0x20, 0x12, 0x21].flatMap((sc) => [
      { kind: "key", scancode: sc, extended: false, down: true },
      { kind: "key", scancode: sc, extended: false, down: false },
    ]);
    moveHandlers.onMessage(moveSocket, JSON.stringify({ type: "input", events: keys }));
    await poll(() => (pumpAll(), a.distinct().length >= before + 2), 20_000, "view A keeps receiving updates");
    pumpAll();
    expect(silent.distinct()).toEqual(silentFrame); // still exactly one
    expect(a.distinct().length).toBeGreaterThanOrEqual(before + 2);

    // Late attach behind a silent SOLE view (L1): with every other view gone, a new
    // silent view receives the current full frame and never acks it. A healthy view
    // that attaches then must still get a frame (the held frame is released so the
    // refresh can flow), not starve.
    for (const v of views) v.handlers.onClose();
    views.length = 0;
    const sole = await attachView(handle, true);
    await poll(() => (pumpAll(), sole.frames.length > 0), 20_000, "the sole silent view's frame");
    const late = await attachView(handle, false);
    await poll(() => (pumpAll(), late.frames.length > 0), 20_000, "a late healthy view's first frame while a silent view holds the current frame");
    expect(sole.distinct().length).toBe(1);

    for (const v of views) v.handlers.onClose();
    views.length = 0;
    await service.sessionClose(handle);
    // The disconnect did not log the user off (case 9 through the service).
    expect(dexec(cid, null, "pgrep", "-u", user, "xterm").code).toBe(0);
  }, 180_000);

  it("case 6b: a trusted certificate replaced on a trusted host:port gives a prompt with reason cert_changed and no credentials are sent", async () => {
    const oldFp = certFingerprint(cid);
    // Same container, same published port, a NEW certificate.
    execFileSync("docker", [
      "exec", cid, "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "/etc/xrdp/key.pem",
      "-out", "/etc/xrdp/cert.pem", "-days", "30", "-subj", "/CN=rdp-test-replaced",
    ], { stdio: "ignore" });
    const newFp = certFingerprint(cid);
    expect(newFp).not.toBe(oldFp);
    execFileSync("docker", ["restart", cid], { stdio: "ignore" });
    await waitTcp(port, 60_000);
    await sleep(2000);

    const handle = await connect();
    const prompt = await poll(() => service.rdpInfo(handle)?.prompt, 30_000, "cert_changed prompt");
    expect(prompt.fingerprint).toBe(newFp);
    expect(prompt.reason).toBe("cert_changed");
    // Not auto-accepted, and the engine never reached authentication.
    await sleep(1000);
    expect(service.rdpInfo(handle)?.state).toBe("cert_prompt");
    expect(service.rdpInfo(handle)?.trace).toEqual(["connecting", "tls", "cert_prompt"]);
    // The old fingerprint is refused as the answer to the new prompt.
    await expect(service.rdpCertDecision(handle, oldFp, "once")).rejects.toMatchObject({ code: "fingerprint_mismatch" });
    await service.rdpCertDecision(handle, newFp, "reject");
    const closed = await poll(() => service.sessionList().find((s) => s.sessionId === handle.sessionId && s.state === "closed"), 15_000, "closed");
    expect(closed.reason).toBe("cert_rejected");
    expect(service.rdpInfo(handle)?.trace).not.toContain("authenticating");
  }, 180_000);
});
