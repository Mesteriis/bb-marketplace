// HelperProcess RDP behaviour against a fake child process: requests as the
// helper reads them, unsolicited events, update chunks kept out of the
// scrollback, chunked and single-frame screenshots, and how pending screenshots
// end. The password literal is asserted to appear ONLY in the open frame.
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { describe, expect, it } from "vitest";
import { decodeFrame, encodeControlFrame, encodeStreamFrame, type ControlMessage } from "../../core/protocol.ts";
import { HelperProcess, HelperRequestError, type HelperSpawn, type RdpHelperEvent } from "./helper-process.ts";

const GEN = "a".repeat(32);
const SECRET = "S3cr3t-MARK-91";
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

interface Fake {
  child: EventEmitter & { stdin: Writable; stdout: PassThrough; stderr: PassThrough; kill: (s?: string) => void };
  writes: Buffer[];
}

function makeFake(): Fake {
  const writes: Buffer[] = [];
  const stdin = new Writable({
    write(chunk, _e, cb) {
      writes.push(Buffer.from(chunk));
      cb();
    },
  });
  (stdin as unknown as { end: () => Writable }).end = () => stdin;
  const child = new EventEmitter() as Fake["child"];
  child.stdin = stdin;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {};
  return { child, writes };
}

function sent(fake: Fake): ControlMessage[] {
  let view: Uint8Array = new Uint8Array(Buffer.concat(fake.writes));
  const out: ControlMessage[] = [];
  for (;;) {
    const r = decodeFrame(view);
    if (r.status !== "frame") break;
    view = r.remaining;
    if (r.frame.kind === "control") out.push(r.frame.message);
  }
  return out;
}

function reply(fake: Fake, message: Record<string, unknown>): void {
  fake.child.stdout.push(Buffer.from(encodeControlFrame(message as unknown as ControlMessage)));
}

async function start(): Promise<{ fake: Fake; hp: HelperProcess }> {
  const fake = makeFake();
  const spawn: HelperSpawn = () => {
    setImmediate(() =>
      reply(fake, { type: "hello_ack", protocol: 1, helperVersion: "0.1.0", platform: "test", pid: 99999, generation: GEN }),
    );
    return fake.child as unknown as ChildProcessWithoutNullStreams;
  };
  return { fake, hp: await HelperProcess.spawn("bin", spawn) };
}

async function openRdp(fake: Fake, hp: HelperProcess, sessionId = 7) {
  const pending = hp.openRdp({
    host: "10.1.2.3",
    port: 3389,
    username: "alice",
    password: SECRET,
    domain: null,
    width: 800,
    height: 600,
    expectedFingerprint: null,
  });
  await tick();
  const request = sent(fake).find((m) => m.type === "session.open_rdp") as { id: number };
  reply(fake, { type: "session.opened", id: request.id, sessionId, cols: 1, rows: 1, pid: 5, kind: "rdp" });
  return pending;
}

const lastRequest = (fake: Fake, type: string) => [...sent(fake)].reverse().find((m) => m.type === type) as unknown as { id: number } & Record<string, unknown>;

const REF = "rh-cred:v1:local:0b8e6f4a-5c2d-4e1b-9a37-1f2e3d4c5b6a";
const BIND = { type: "endpoint", protocol: "rdp", host: "h.test", port: 3389, user: "u", domain: null } as const;

describe("HelperProcess credentials (stage 3b)", () => {
  it("credential.save carries the secret down once; the answer carries none", async () => {
    const { fake, hp } = await start();
    const pending = hp.credentialSave(REF, SECRET, BIND);
    await tick();
    const request = lastRequest(fake, "credential.save");
    expect(request).toMatchObject({ type: "credential.save", ref: REF, secret: SECRET, bind: BIND });
    reply(fake, { type: "credential.ok", id: request.id });
    await expect(pending).resolves.toBeUndefined();
    fake.child.emit("exit", 0);
  });

  it("status reads the helper's credential.state; delete and save map error codes to HelperRequestError", async () => {
    const { fake, hp } = await start();
    const status = hp.credentialStatus(REF);
    await tick();
    reply(fake, { type: "credential.state", id: lastRequest(fake, "credential.status").id, present: true });
    await expect(status).resolves.toBe(true);
    const del = hp.credentialDelete(REF);
    await tick();
    reply(fake, { type: "error", id: lastRequest(fake, "credential.delete").id, code: "keychain_locked", message: "the Keychain is locked" });
    await expect(del).rejects.toMatchObject({ name: "HelperRequestError", code: "keychain_locked" });
    const save = hp.credentialSave(REF, SECRET, BIND);
    await tick();
    reply(fake, { type: "error", id: lastRequest(fake, "credential.save").id, code: "keychain_denied", message: "refused" });
    const error = await save.catch((e: Error) => e);
    expect(error).toBeInstanceOf(HelperRequestError);
    expect(String((error as Error).message)).not.toContain(SECRET);
    fake.child.emit("exit", 0);
  });

  it("session.open_rdp with a credentialRef has no password key at all, so the secret never crosses this side", async () => {
    const { fake, hp } = await start();
    const pending = hp.openRdp({ host: "h", port: 3389, username: "alice", credentialRef: REF, domain: null, width: 800, height: 600, expectedFingerprint: null });
    await tick();
    const open = sent(fake).find((m) => m.type === "session.open_rdp") as unknown as Record<string, unknown> & { id: number };
    expect(open.credentialRef).toBe(REF);
    expect("password" in open).toBe(false);
    reply(fake, { type: "session.opened", id: open.id, sessionId: 7, cols: 0, rows: 0, pid: 5, kind: "rdp" });
    await pending;
    fake.child.emit("exit", 0);
  });
});

describe("HelperProcess RDP", () => {
  it("writes session.open_rdp with the helper's field names; the password is only in that frame", async () => {
    const { fake, hp } = await start();
    const handle = await openRdp(fake, hp);
    expect(handle).toEqual({ generation: GEN, sessionId: 7 });
    const open = sent(fake).find((m) => m.type === "session.open_rdp");
    expect(open).toMatchObject({
      type: "session.open_rdp",
      host: "10.1.2.3",
      port: 3389,
      username: "alice",
      password: SECRET,
      domain: null,
      width: 800,
      height: 600,
      expectedFingerprint: null,
    });
    void hp.rdpRefresh(handle).catch(() => {}); // unanswered: only to produce another frame
    await tick();
    const withSecret = fake.writes.filter((w) => w.includes(Buffer.from(SECRET)));
    expect(withSecret.length).toBe(1);
    fake.child.emit("exit", 0);
  });

  it("delivers unsolicited events with the session id and no stream bookkeeping", async () => {
    const { fake, hp } = await start();
    const events: Array<[number, RdpHelperEvent]> = [];
    hp.onRdpEvent((sid, e) => events.push([sid, e]));
    await openRdp(fake, hp);
    reply(fake, { type: "rdp.state", sessionId: 7, state: "tls" });
    reply(fake, { type: "rdp.desktop", sessionId: 7, frameId: 1, width: 800, height: 600, timestamp: 4 });
    await tick();
    expect(events).toEqual([
      [7, { type: "rdp.state", state: "tls" }],
      [7, { type: "rdp.desktop", frameId: 1, width: 800, height: 600, timestamp: 4 }],
    ]);
  });

  it("routes update chunks to the RDP callback, never to the scrollback or the byte credit", async () => {
    const { fake, hp } = await start();
    const updates: Array<[number, number, number]> = [];
    const outputs: number[] = [];
    hp.onRdpUpdate((sid, seq, payload) => updates.push([sid, seq, payload.byteLength]));
    hp.onSessionOutput((sid) => outputs.push(sid));
    await openRdp(fake, hp);
    fake.child.stdout.push(Buffer.from(encodeStreamFrame({ sessionId: 7, seq: 0 }, new Uint8Array(40))));
    fake.child.stdout.push(Buffer.from(encodeStreamFrame({ sessionId: 7, seq: 1 }, new Uint8Array(41))));
    await tick();
    expect(updates).toEqual([
      [7, 0, 40],
      [7, 1, 41],
    ]);
    expect(outputs).toEqual([]);
    expect(hp.scrollbackSnapshot(7).byteLength).toBe(0);
  });

  it("resolves a single-frame screenshot", async () => {
    const { fake, hp } = await start();
    const handle = await openRdp(fake, hp);
    const shot = hp.rdpScreenshot(handle);
    await tick();
    const request = lastRequest(fake, "rdp.screenshot");
    reply(fake, { type: "rdp.screenshot", id: request.id, sessionId: 7, frameId: 3, width: 8, height: 8, timestamp: 9, png: "QUJD" });
    await expect(shot).resolves.toEqual({ frameId: 3, width: 8, height: 8, timestamp: 9, png: "QUJD" });
  });

  it("reassembles a chunked screenshot in order", async () => {
    const { fake, hp } = await start();
    const handle = await openRdp(fake, hp);
    const shot = hp.rdpScreenshot(handle);
    await tick();
    const { id } = lastRequest(fake, "rdp.screenshot");
    reply(fake, { type: "rdp.screenshot", id, sessionId: 7, frameId: 3, width: 3840, height: 2160, timestamp: 9, png: "", chunks: 3 });
    for (const [index, data] of ["AAAA", "BBBB", "CC=="].entries()) {
      reply(fake, { type: "rdp.screenshot_chunk", id, sessionId: 7, index, count: 3, data });
    }
    await expect(shot).resolves.toEqual({ frameId: 3, width: 3840, height: 2160, timestamp: 9, png: "AAAABBBBCC==" });
  });

  it("fails a screenshot whose chunks are out of order with protocol_error", async () => {
    const { fake, hp } = await start();
    const handle = await openRdp(fake, hp);
    const shot = hp.rdpScreenshot(handle);
    await tick();
    const { id } = lastRequest(fake, "rdp.screenshot");
    reply(fake, { type: "rdp.screenshot", id, sessionId: 7, frameId: 3, width: 8, height: 8, timestamp: 9, png: "", chunks: 2 });
    reply(fake, { type: "rdp.screenshot_chunk", id, sessionId: 7, index: 1, count: 2, data: "AAAA" });
    await expect(shot).rejects.toMatchObject({ code: "protocol_error" });
  });

  it("fails a pending screenshot with session_closed when the session closes", async () => {
    const { fake, hp } = await start();
    const handle = await openRdp(fake, hp);
    const shot = hp.rdpScreenshot(handle);
    await tick();
    reply(fake, { type: "session.closed", id: null, sessionId: 7, exitCode: null, signal: null, reason: "network_error" });
    await expect(shot).rejects.toMatchObject({ code: "session_closed" });
  });

  it("passes the helper's own refusal code through (screenshot_too_large, not_ready)", async () => {
    const { fake, hp } = await start();
    const handle = await openRdp(fake, hp);
    const shot = hp.rdpScreenshot(handle);
    await tick();
    const { id } = lastRequest(fake, "rdp.screenshot");
    reply(fake, { type: "error", id, code: "screenshot_too_large", message: "too big" });
    await expect(shot).rejects.toBeInstanceOf(HelperRequestError);
    await expect(shot).rejects.toMatchObject({ code: "screenshot_too_large" });
    const refused = hp.rdpInput(handle, []);
    await tick();
    const req = lastRequest(fake, "rdp.input");
    reply(fake, { type: "error", id: req.id, code: "not_ready", message: "no" });
    await expect(refused).rejects.toMatchObject({ code: "not_ready" });
  });

  it("rejects a pending screenshot when the helper dies", async () => {
    const { fake, hp } = await start();
    const handle = await openRdp(fake, hp);
    const shot = hp.rdpScreenshot(handle);
    await tick();
    fake.child.emit("exit", 1);
    await expect(shot).rejects.toMatchObject({ code: "helper_exited" });
  });

  it("keeps reading helper stdout while input requests are being written", async () => {
    const { fake, hp } = await start();
    const handle = await openRdp(fake, hp);
    const seen: number[] = [];
    hp.onRdpUpdate((_sid, seq) => seen.push(seq));
    const inputs = Array.from({ length: 50 }, () => hp.rdpInput(handle, [{ kind: "ctrl_alt_del" }]).catch(() => {}));
    for (let seq = 0; seq < 20; seq++) fake.child.stdout.push(Buffer.from(encodeStreamFrame({ sessionId: 7, seq }, new Uint8Array(8))));
    await tick();
    expect(seen).toEqual(Array.from({ length: 20 }, (_, i) => i));
    fake.child.emit("exit", 0);
    await Promise.all(inputs);
  });
});

describe("HelperProcess RDP: the first update right behind session.opened", () => {
  it("is an RDP update, never scrollback, when both arrive in ONE stdout read", async () => {
    const { fake, hp } = await start();
    const updates: number[] = [];
    const outputs: number[] = [];
    hp.onRdpUpdate((sid) => updates.push(sid));
    hp.onSessionOutput((sid) => outputs.push(sid));
    const pending = hp.openRdp({
      host: "10.1.2.3",
      port: 3389,
      username: "alice",
      password: SECRET,
      domain: null,
      width: 8,
      height: 4,
      expectedFingerprint: null,
    });
    await tick();
    const request = lastRequest(fake, "session.open_rdp");
    const opened = encodeControlFrame({ type: "session.opened", id: request.id, sessionId: 7, cols: 0, rows: 0, pid: 5, kind: "rdp" } as unknown as ControlMessage);
    const update = new Uint8Array(36 + 8 * 4 * 4);
    const view = new DataView(update.buffer);
    view.setBigUint64(0, 1n, true);
    view.setUint32(8, 8, true);
    view.setUint32(12, 4, true);
    view.setUint32(24, 8, true);
    view.setUint32(28, 4, true);
    view.setUint32(32, 1, true);
    fake.child.stdout.push(Buffer.concat([Buffer.from(opened), Buffer.from(encodeStreamFrame({ sessionId: 7, seq: 0 }, update))]));
    await pending;
    expect(updates).toEqual([7]);
    expect(outputs).toEqual([]);
    expect(hp.scrollbackSnapshot(7).byteLength).toBe(0);
    fake.child.emit("exit", 0);
  });
});


describe("HelperProcess askpass events", () => {
  it("passes a prompt, its expiry and the credential notices on as session events", async () => {
    const { fake, hp } = await start();
    const seen: Array<[number, unknown]> = [];
    hp.onSshAskpass((sessionId, event) => seen.push([sessionId, event]));
    reply(fake, { type: "ssh.prompt", sessionId: 3, promptId: 1, text: "Continue (yes/no)?", kind: "confirm" });
    reply(fake, { type: "ssh.prompt_expired", sessionId: 3, promptId: 1 });
    reply(fake, { type: "ssh.credential_rejected", sessionId: 3 });
    reply(fake, { type: "ssh.credential_failed", sessionId: 3, code: "keychain_locked" });
    await tick();
    await tick();
    expect(seen).toEqual([
      [3, { type: "prompt", promptId: 1, text: "Continue (yes/no)?", kind: "confirm" }],
      [3, { type: "prompt_expired", promptId: 1 }],
      [3, { type: "credential_rejected" }],
      [3, { type: "credential_failed", code: "keychain_locked" }],
    ]);
  });
});
