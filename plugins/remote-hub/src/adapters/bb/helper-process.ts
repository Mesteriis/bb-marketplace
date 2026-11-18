// The BB adapter for the Rust helper: locates and verifies the binary, spawns
// it through the SDK host process API, performs the version handshake, and
// speaks the versioned stdio protocol from src/core/protocol.ts.
//
// Host imports are allowed here (src/adapters); src/core and src/ui stay free
// of them. The SDK host process API is experimental_spawnHostProcess /
// experimental_execHostFile from "@get-bb/plugin-sdk/process"
// (bundled-types/bb-plugin-sdk-process.d.ts:46-54); both wrap Node's
// child_process, which is what the BB server itself runs on.
import { experimental_execHostFile, experimental_spawnHostProcess } from "@get-bb/plugin-sdk/process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  PROTOCOL_VERSION,
  decodeFrame,
  encodeControlFrame,
  encodeStreamFrame,
  type ControlMessage,
  type RequestMessage,
  type ResponseMessage,
} from "../../core/protocol.ts";
import type { SessionHandle } from "../../core/rpc.ts";
import { parseUpdateChunk, type RdpInputEvent } from "../../core/rdp-protocol.ts";
import { ScreenshotAssembler, type ScreenshotResult } from "../../core/rdp-screenshot.ts";
import { Scrollback, SCROLLBACK_MAX_BYTES } from "../../core/scrollback.ts";
import type { SshSpawnSpec } from "../../core/ssh-args.ts";

export const HELPER_BIN_NAME = "remote-hub-helper";
/** Must match helper/Cargo.toml version; the adapter refuses a mismatch. */
export const HELPER_VERSION = "0.1.0";
/** How long the hello handshake may take before it is reported as handshake_timeout. */
export const HANDSHAKE_TIMEOUT_MS = 5_000;

export interface HelperStartFailure {
  code: string;
  message: string;
  path?: string;
}

export class HelperStartError extends Error {
  readonly error: HelperStartFailure;
  constructor(error: HelperStartFailure) {
    super(error.message);
    this.name = "HelperStartError";
    this.error = error;
  }
}

export type HelperRuntimeErrorCode = "helper_exited" | "protocol_error" | "session_not_found";

/** A runtime failure while a helper was running (exit, protocol error, …). */
export class HelperRuntimeError extends Error {
  readonly code: HelperRuntimeErrorCode;
  constructor(code: HelperRuntimeErrorCode, message: string) {
    super(message);
    this.name = "HelperRuntimeError";
    this.code = code;
  }
}

/** The helper refused one request; `code` is its stable error code
 *  (not_ready, session_not_found, fingerprint_mismatch, screenshot_too_large, ...). */
export class HelperRequestError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "HelperRequestError";
    this.code = code;
  }
}

/** An RDP event the helper sent without being asked (state, prompt, desktop...). */
export type RdpHelperEvent =
  | { type: "rdp.state"; state: string }
  | {
      type: "rdp.cert_prompt";
      host: string;
      port: number;
      fingerprint: string;
      subject: string;
      issuer: string;
      notBefore: string;
      notAfter: string;
      reason: string;
    }
  | { type: "rdp.certificate"; fingerprint: string; validated: boolean }
  | { type: "rdp.input_rejected"; applied: number; rejected: Array<{ index: number; code: string }> }
  | { type: "rdp.desktop"; frameId: number; width: number; height: number; timestamp: number };

export function helperBinaryPath(pluginDir: string): string {
  return join(pluginDir, "bin", HELPER_BIN_NAME);
}

export function platformError(): HelperStartFailure | null {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    return {
      code: "unsupported_platform",
      message:
        "Remote Hub helper is built for darwin/arm64; this machine is " +
        process.platform +
        "/" +
        process.arch,
    };
  }
  return null;
}

export function helperMissingError(path: string): HelperStartFailure {
  return {
    code: "helper_missing",
    message:
      "Remote Hub helper binary is missing at " +
      path +
      "; run 'npm run build:helper' in the plugin directory",
    path,
  };
}

export function helperMismatchError(path: string, expected: string, found: string): HelperStartFailure {
  return {
    code: "helper_mismatch",
    message:
      "Remote Hub helper at " +
      path +
      " reports version '" +
      found +
      "', expected '" +
      expected +
      "'; rebuild it with 'npm run build:helper'",
    path,
  };
}

/** Extract 0.1.0 from a "remote-hub-helper 0.1.0" --version line. */
export function parseHelperVersion(stdout: string): string {
  return stdout.trim().replace(/^remote-hub-helper\s+/, "").split(/\s+/)[0] ?? "";
}

export type HelperProbe =
  | { ok: true; version: string; path: string }
  | { ok: false; error: HelperStartFailure };

/** Locate, platform-check and version-check the helper binary. */
export async function probeHelper(binPath: string): Promise<HelperProbe> {
  const unsupported = platformError();
  if (unsupported !== null) return { ok: false, error: unsupported };
  if (!existsSync(binPath)) return { ok: false, error: helperMissingError(binPath) };
  try {
    const { stdout } = await experimental_execHostFile(binPath, ["--version"]);
    const version = parseHelperVersion(stdout);
    if (version !== HELPER_VERSION) {
      return { ok: false, error: helperMismatchError(binPath, HELPER_VERSION, version || "unknown") };
    }
    return { ok: true, version, path: binPath };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "helper_missing",
        message:
          "Remote Hub helper at " +
          binPath +
          " could not be executed: " +
          (error instanceof Error ? error.message : String(error)),
        path: binPath,
      },
    };
  }
}

export interface HelperStatus {
  version: string;
  pid: number;
  platform: string;
  sessionCount: number;
  alive: boolean;
}

export type HelperSpawn = (binPath: string, args: string[]) => ChildProcessWithoutNullStreams;

/** Per-session buffered terminal output bound, before oldest bytes are dropped. */
const MAX_STREAM_BUFFER_BYTES = 256 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;

interface PendingRequest {
  resolve: (resp: ResponseMessage) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface StreamPart {
  text: string;
  bytes: number;
}

interface StreamState {
  decoder: TextDecoder;
  parts: StreamPart[];
  bytes: number;
  truncated: boolean;
}

interface PendingScreenshot {
  sessionId: number;
  assembler: ScreenshotAssembler | null;
  resolve: (result: ScreenshotResult) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface OneShot {
  predicate: (resp: ResponseMessage) => boolean;
  resolve: (resp: ResponseMessage) => void;
  reject: (error: Error) => void;
}

const defaultSpawn: HelperSpawn = (binPath, args) => experimental_spawnHostProcess(binPath, args);

export class HelperProcess {
  private readonly child: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly oneShots: OneShot[] = [];
  private readonly streams = new Map<number, StreamState>();
  private readonly scrollbacks = new Map<number, Scrollback>();
  private readonly inputSeq = new Map<number, number>();
  private readonly echoSessions = new Set<number>();
  private readonly rdpSessions = new Set<number>();
  private readonly screens = new Map<number, PendingScreenshot>();
  private readonly onRdpEventCallbacks: Array<(sessionId: number, event: RdpHelperEvent) => void> = [];
  private readonly onRdpUpdateCallbacks: Array<(sessionId: number, seq: number, payload: Uint8Array) => void> = [];
  private readonly onSessionClosedCallbacks: Array<(sessionId: number, info: { exitCode: number | null; signal: number | null; reason: string }) => void> = [];
  private readonly onSessionOutputCallbacks: Array<(sessionId: number, data: Uint8Array) => void> = [];
  private readonly onExitCallbacks: Array<() => void> = [];
  private buffer: Uint8Array = new Uint8Array(0);
  private _status: Omit<HelperStatus, "alive"> | null = null;
  private generation = "";
  private dead = false;
  private deadError: Error | null = null;
  private killStarted = false;

  private constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
  }

  get status(): HelperStatus | null {
    if (this._status === null) return null;
    return { ...this._status, alive: !this.dead };
  }

  get currentGeneration(): string {
    return this.generation;
  }

  static async start(pluginDir: string, spawnFn: HelperSpawn = defaultSpawn): Promise<HelperProcess> {
    const binPath = helperBinaryPath(pluginDir);
    const probe = await probeHelper(binPath);
    if (!probe.ok) throw new HelperStartError(probe.error);
    return HelperProcess.spawn(binPath, spawnFn);
  }

  /** Spawn and handshake without probing the binary (used by tests). */
  static async spawn(
    binPath: string,
    spawnFn: HelperSpawn = defaultSpawn,
    opts: { handshakeTimeoutMs?: number } = {},
  ): Promise<HelperProcess> {
    const child = spawnFn(binPath, []);
    const process = new HelperProcess(child);
    process.attach(child);
    try {
      const ack = await process.handshake(opts.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS);
      process.generation = ack.generation;
      process._status = {
        version: ack.helperVersion,
        pid: ack.pid,
        platform: ack.platform,
        sessionCount: 0,
      };
      return process;
    } catch (error) {
      process.stop();
      throw error;
    }
  }

  private attach(child: ChildProcessWithoutNullStreams): void {
    child.stdout.on("data", (chunk: Buffer) => this.onStdout(chunk));
    child.stderr.on("data", () => {
      // Stderr is diagnostics only; never part of the protocol.
    });
    // Without an error listener, an EPIPE on stdin can crash the server worker.
    child.stdin.on("error", () => {
      this.fail(new HelperRuntimeError("helper_exited", "helper stdin closed"), true);
    });
    child.on("error", (error: Error) => {
      this.fail(new HelperRuntimeError("helper_exited", error.message), true);
    });
    child.on("exit", () => {
      this.fail(new HelperRuntimeError("helper_exited", "helper exited"), false);
    });
  }

  private handshake(timeoutMs: number): Promise<Extract<ResponseMessage, { type: "hello_ack" }>> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const waiter: OneShot = {
        predicate: (resp) => resp.type === "hello_ack" || resp.type === "error",
        resolve: (resp) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (resp.type === "error") {
            // Pass the helper's own code through (version_mismatch, …).
            reject(new HelperStartError({ code: resp.code, message: resp.message }));
          } else {
            resolve(resp as Extract<ResponseMessage, { type: "hello_ack" }>);
          }
        },
        reject: (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(error);
        },
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        const index = this.oneShots.indexOf(waiter);
        if (index >= 0) this.oneShots.splice(index, 1);
        reject(
          new HelperStartError({
            code: "handshake_timeout",
            message: "helper did not answer the hello handshake within " + timeoutMs + "ms",
          }),
        );
      }, timeoutMs);
      this.oneShots.push(waiter);
      this.writeControl({ type: "hello", protocol: PROTOCOL_VERSION });
    });
  }

  private onStdout(chunk: Buffer): void {
    const appended = new Uint8Array(this.buffer.length + chunk.length);
    appended.set(this.buffer, 0);
    appended.set(chunk, this.buffer.length);
    this.buffer = appended;
    for (;;) {
      const result = decodeFrame(this.buffer);
      if (result.status === "need_more_data") return;
      if (result.status === "error") {
        // A codec error is fatal: the connection is out of step and must not
        // silently resync.
        this.buffer = new Uint8Array(0);
        this.fail(new HelperRuntimeError("protocol_error", result.message), true);
        return;
      }
      this.buffer = result.remaining;
      if (result.frame.kind === "control") {
        this.handleControl(result.frame.message as ResponseMessage);
      } else {
        this.handleStream(result.frame.header.sessionId, result.frame.header.seq, result.frame.data);
      }
    }
  }

  private handleControl(resp: ResponseMessage): void {
    // Classify the session SYNCHRONOUSLY, before anything awaits: the helper may
    // write session.opened and the first update chunk into one stdout read, and
    // the chunk is handled in this same loop, before openRdp's continuation runs.
    if (resp.type === "session.opened" && resp.kind === "rdp") this.rdpSessions.add(resp.sessionId);
    const oneShotIndex = this.oneShots.findIndex((w) => w.predicate(resp));
    if (oneShotIndex >= 0) {
      const [waiter] = this.oneShots.splice(oneShotIndex, 1);
      waiter.resolve(resp);
      return;
    }
    if (this.handleRdpControl(resp)) return;
    const id = "id" in resp ? (resp as { id?: unknown }).id : undefined;
    if (typeof id === "number" && this.pending.has(id)) {
      const entry = this.pending.get(id)!;
      this.pending.delete(id);
      clearTimeout(entry.timer);
      entry.resolve(resp);
      return;
    }
    if (resp.type === "session.closed") {
      for (const [shotId, entry] of Array.from(this.screens)) {
        if (entry.sessionId === resp.sessionId) {
          this.failScreenshot(shotId, new HelperRequestError("session_closed", "the session closed before the screenshot arrived"));
        }
      }
      this.releaseSession(resp.sessionId);
      const info = { exitCode: resp.exitCode, signal: resp.signal, reason: resp.reason };
      for (const cb of this.onSessionClosedCallbacks) cb(resp.sessionId, info);
      if (this._status !== null) this._status.sessionCount = Math.max(0, this._status.sessionCount - 1);
    }
  }

  /** RDP messages that are not plain request/response pairs. True when consumed. */
  private handleRdpControl(resp: ResponseMessage): boolean {
    switch (resp.type) {
      case "rdp.state":
      case "rdp.cert_prompt":
      case "rdp.certificate":
      case "rdp.input_rejected":
      case "rdp.desktop": {
        const { sessionId, ...rest } = resp as { sessionId: number } & RdpHelperEvent;
        for (const cb of this.onRdpEventCallbacks) cb(sessionId, rest as RdpHelperEvent);
        return true;
      }
      case "rdp.screenshot": {
        const entry = this.screens.get(resp.id);
        if (entry === undefined) return false;
        if (resp.chunks === undefined) {
          this.finishScreenshot(resp.id, { frameId: resp.frameId, width: resp.width, height: resp.height, timestamp: resp.timestamp, png: resp.png });
          return true;
        }
        const header = { id: resp.id, frameId: resp.frameId, width: resp.width, height: resp.height, timestamp: resp.timestamp, chunks: resp.chunks };
        if (!ScreenshotAssembler.valid(header)) {
          this.failScreenshot(resp.id, new HelperRequestError("protocol_error", "a screenshot announced an impossible chunk count"));
        } else {
          entry.assembler = new ScreenshotAssembler(header);
        }
        return true;
      }
      case "rdp.screenshot_chunk": {
        const entry = this.screens.get(resp.id);
        if (entry === undefined) return true; // an answer nobody waits for any more
        if (entry.assembler === null) {
          this.failScreenshot(resp.id, new HelperRequestError("protocol_error", "a screenshot chunk arrived before its header"));
          return true;
        }
        const result = entry.assembler.add(resp);
        if (result.status === "error") {
          this.failScreenshot(resp.id, new HelperRequestError("protocol_error", "a screenshot chunk was out of order or malformed"));
        } else if (result.status === "done") {
          this.finishScreenshot(resp.id, result.result);
        }
        return true;
      }
      case "error": {
        const id = resp.id;
        if (id !== null && this.screens.has(id)) {
          this.failScreenshot(id, new HelperRequestError(resp.code, resp.message));
          return true;
        }
        return false;
      }
      default:
        return false;
    }
  }

  private finishScreenshot(id: number, result: ScreenshotResult): void {
    const entry = this.screens.get(id);
    if (entry === undefined) return;
    this.screens.delete(id);
    clearTimeout(entry.timer);
    entry.resolve(result);
  }

  private failScreenshot(id: number, error: Error): void {
    const entry = this.screens.get(id);
    if (entry === undefined) return;
    this.screens.delete(id);
    clearTimeout(entry.timer);
    entry.reject(error);
  }

  private handleStream(sessionId: number, seq: number, data: Uint8Array): void {
    if (this.rdpSessions.has(sessionId)) {
      // A framebuffer update chunk: never part of the scrollback or the byte credit.
      for (const cb of this.onRdpUpdateCallbacks) cb(sessionId, seq, data);
      return;
    }
    let scrollback = this.scrollbacks.get(sessionId);
    if (scrollback === undefined) {
      scrollback = new Scrollback(SCROLLBACK_MAX_BYTES);
      this.scrollbacks.set(sessionId, scrollback);
    }
    scrollback.append(data);
    for (const cb of this.onSessionOutputCallbacks) cb(sessionId, data);
    // Only the echo console consumes the decoded text buffer (drain()/
    // waitForOutput()); SSH sessions stream bytes straight through and must
    // not accumulate in the 256 KiB echo buffer.
    if (this.echoSessions.has(sessionId)) {
      let state = this.streams.get(sessionId);
      if (state === undefined) {
        state = { decoder: new TextDecoder("utf-8"), parts: [], bytes: 0, truncated: false };
        this.streams.set(sessionId, state);
      }
      const text = state.decoder.decode(data, { stream: true });
      const bytes = data.byteLength;
      if (text.length > 0) state.parts.push({ text, bytes });
      state.bytes += bytes;
      while (state.bytes > MAX_STREAM_BUFFER_BYTES && state.parts.length > 0) {
        const dropped = state.parts.shift()!;
        state.bytes -= dropped.bytes;
        state.truncated = true;
      }
    }
  }

  private releaseSession(sessionId: number): void {
    this.streams.delete(sessionId);
    this.scrollbacks.delete(sessionId);
    this.inputSeq.delete(sessionId);
    this.echoSessions.delete(sessionId);
    this.rdpSessions.delete(sessionId);
  }

  private writeControl(message: ControlMessage): void {
    this.child.stdin.write(encodeControlFrame(message));
  }

  private request(message: RequestMessage, timeoutMs: number = REQUEST_TIMEOUT_MS): Promise<ResponseMessage> {
    if (this.dead) {
      return Promise.reject(this.deadError ?? new HelperRuntimeError("helper_exited", "helper is not running"));
    }
    const id = this.nextId++;
    const withId = { ...message, id } as RequestMessage;
    return new Promise<ResponseMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("helper request timed out"));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.writeControl(withId);
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  private fail(reason: Error, kill: boolean): void {
    if (this.dead) return;
    this.dead = true;
    this.deadError = reason;
    if (kill) this.killChild();
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(reason);
    }
    this.pending.clear();
    for (const id of Array.from(this.screens.keys())) this.failScreenshot(id, reason);
    for (const waiter of this.oneShots.splice(0)) waiter.reject(reason);
    for (const callback of this.onExitCallbacks) {
      try {
        callback();
      } catch {
        // Listener failures must not break teardown.
      }
    }
  }

  private killChild(): void {
    if (this.killStarted) return;
    this.killStarted = true;
    try {
      this.child.stdin.end();
    } catch {
      // Already closed.
    }
    try {
      this.child.kill("SIGTERM");
    } catch {
      // Already gone.
    }
    try {
      this.child.stdout.removeAllListeners("data");
    } catch {
      // Ignore.
    }
    setTimeout(() => {
      try {
        this.child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
    }, 2000);
  }

  /** Register a callback fired once when the helper dies. */
  onExit(callback: () => void): void {
    this.onExitCallbacks.push(callback);
    if (this.dead) callback();
  }

  /** Drain buffered stream output for one session, oldest first. */
  drain(sessionId: number): { output: string; truncated: boolean } {
    const state = this.streams.get(sessionId);
    if (state === undefined) return { output: "", truncated: false };
    const output = state.parts.map((part) => part.text).join("");
    state.parts = [];
    state.bytes = 0;
    const truncated = state.truncated;
    state.truncated = false;
    return { output, truncated };
  }

  private async waitForOutput(
    sessionId: number,
    opts: { quietMs: number; maxMs: number },
  ): Promise<{ output: string; truncated: boolean }> {
    const started = Date.now();
    let lastByteAt = started;
    let accumulated = "";
    let truncated = false;
    for (;;) {
      const drained = this.drain(sessionId);
      if (drained.output.length > 0) {
        accumulated += drained.output;
        truncated = truncated || drained.truncated;
        lastByteAt = Date.now();
      }
      const quiet = Date.now() - lastByteAt >= opts.quietMs;
      const over = Date.now() - started >= opts.maxMs;
      if ((accumulated.length > 0 && quiet) || over) {
        return { output: accumulated, truncated };
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  private assertGeneration(handle: SessionHandle): void {
    if (handle.generation !== this.generation) {
      throw new HelperRuntimeError(
        "session_not_found",
        "session handle belongs to a different helper generation",
      );
    }
  }

  async pingAlive(): Promise<boolean> {
    if (this.dead) return false;
    try {
      const resp = await this.request({ type: "ping" } as RequestMessage, 3_000);
      return resp.type === "pong";
    } catch {
      // A helper that cannot answer ping is effectively dead: kill it and
      // clear the cache (reuses the S5 fail path) so the next call restarts.
      this.fail(new HelperRuntimeError("helper_exited", "helper did not answer ping"), true);
      return false;
    }
  }

  async openEcho(cols: number, rows: number): Promise<SessionHandle> {
    const resp = await this.request({ type: "session.open_echo", cols, rows } as RequestMessage);
    if (resp.type === "error") throw new Error(resp.message);
    if (resp.type !== "session.opened") throw new Error("unexpected helper response: " + resp.type);
    if (this._status !== null) this._status.sessionCount += 1;
    this.echoSessions.add(resp.sessionId);
    return { generation: this.generation, sessionId: resp.sessionId };
  }

  async input(handle: SessionHandle, data: string): Promise<{ output: string; truncated: boolean }> {
    this.assertGeneration(handle);
    const resp = await this.request({ type: "session.input", sessionId: handle.sessionId, data } as RequestMessage);
    if (resp.type === "error") throw new Error(resp.message);
    if (resp.type !== "session.input_ack") throw new Error("unexpected helper response: " + resp.type);
    return this.waitForOutput(handle.sessionId, { quietMs: 40, maxMs: 500 });
  }

  async resize(handle: SessionHandle, cols: number, rows: number): Promise<void> {
    this.assertGeneration(handle);
    const resp = await this.request({ type: "session.resize", sessionId: handle.sessionId, cols, rows } as RequestMessage);
    if (resp.type === "error") throw new Error(resp.message);
  }

  async openSsh(spec: SshSpawnSpec, cols: number, rows: number): Promise<SessionHandle> {
    const resp = await this.request({
      type: "session.open_ssh",
      cols,
      rows,
      program: spec.program,
      argv: spec.argv,
      env: spec.env,
      cwd: null,
    } as RequestMessage);
    if (resp.type === "error") throw new Error(resp.message);
    if (resp.type !== "session.opened") throw new Error("unexpected helper response: " + resp.type);
    if (this._status !== null) this._status.sessionCount += 1;
    return { generation: this.generation, sessionId: resp.sessionId };
  }

  async credit(handle: SessionHandle, bytes: number): Promise<void> {
    this.assertGeneration(handle);
    const resp = await this.request({ type: "session.credit", sessionId: handle.sessionId, bytes } as RequestMessage);
    if (resp.type === "error") throw new Error(resp.message);
  }

  /** Write raw terminal bytes to a session as a binary stream frame. */
  writeInput(sessionId: number, data: Uint8Array): void {
    const seq = this.inputSeq.get(sessionId) ?? 0;
    this.inputSeq.set(sessionId, seq + 1);
    this.child.stdin.write(encodeStreamFrame({ sessionId, seq }, data));
  }

  scrollbackSnapshot(sessionId: number): Uint8Array {
    return this.scrollbacks.get(sessionId)?.snapshot() ?? new Uint8Array(0);
  }

  onSessionClosed(cb: (sessionId: number, info: { exitCode: number | null; signal: number | null; reason: string }) => void): void {
    this.onSessionClosedCallbacks.push(cb);
  }

  onSessionOutput(cb: (sessionId: number, data: Uint8Array) => void): void {
    this.onSessionOutputCallbacks.push(cb);
  }

  async close(handle: SessionHandle): Promise<{ exitCode: number | null; signal: number | null; reason: string }> {
    this.assertGeneration(handle);
    const resp = await this.request({ type: "session.close", sessionId: handle.sessionId } as RequestMessage);
    if (resp.type === "error") throw new Error(resp.message);
    if (resp.type !== "session.closed") throw new Error("unexpected helper response: " + resp.type);
    this.releaseSession(handle.sessionId);
    const info = { exitCode: resp.exitCode, signal: resp.signal, reason: resp.reason };
    if (this._status !== null) this._status.sessionCount = Math.max(0, this._status.sessionCount - 1);
    return info;
  }

  /** Register for unsolicited RDP events (state, prompt, certificate, desktop, input_rejected). */
  onRdpEvent(cb: (sessionId: number, event: RdpHelperEvent) => void): void {
    this.onRdpEventCallbacks.push(cb);
  }

  /** Register for RDP update chunks: the payload is the 32-byte update header + RGBA rows. */
  onRdpUpdate(cb: (sessionId: number, seq: number, payload: Uint8Array) => void): void {
    this.onRdpUpdateCallbacks.push(cb);
  }

  private expectAck(resp: ResponseMessage): void {
    if (resp.type === "error") throw new HelperRequestError(resp.code, resp.message);
    if (resp.type !== "rdp.ack") throw new Error("unexpected helper response: " + resp.type);
  }

  async openRdp(params: {
    host: string;
    port: number;
    username: string;
    password: string;
    domain: string | null;
    width: number;
    height: number;
    expectedFingerprint: string | null;
  }): Promise<SessionHandle> {
    const resp = await this.request({ type: "session.open_rdp", ...params } as RequestMessage);
    if (resp.type === "error") throw new HelperRequestError(resp.code, resp.message);
    if (resp.type !== "session.opened") throw new Error("unexpected helper response: " + resp.type);
    this.rdpSessions.add(resp.sessionId);
    if (this._status !== null) this._status.sessionCount += 1;
    return { generation: this.generation, sessionId: resp.sessionId };
  }

  async rdpCertDecision(handle: SessionHandle, fingerprint: string, accept: "once" | "session_trust" | "reject"): Promise<void> {
    this.assertGeneration(handle);
    this.expectAck(await this.request({ type: "rdp.cert_decision", sessionId: handle.sessionId, fingerprint, accept } as RequestMessage));
  }

  async rdpInput(handle: SessionHandle, events: RdpInputEvent[]): Promise<void> {
    this.assertGeneration(handle);
    this.expectAck(await this.request({ type: "rdp.input", sessionId: handle.sessionId, events } as RequestMessage));
  }

  async rdpUpdateAck(handle: SessionHandle, frameId: number): Promise<void> {
    this.assertGeneration(handle);
    this.expectAck(await this.request({ type: "rdp.update_ack", sessionId: handle.sessionId, frameId } as RequestMessage));
  }

  async rdpRefresh(handle: SessionHandle): Promise<void> {
    this.assertGeneration(handle);
    this.expectAck(await this.request({ type: "rdp.refresh", sessionId: handle.sessionId } as RequestMessage));
  }

  /** Request a PNG of the framebuffer; chunked answers are reassembled. */
  rdpScreenshot(handle: SessionHandle, timeoutMs: number = REQUEST_TIMEOUT_MS): Promise<ScreenshotResult> {
    this.assertGeneration(handle);
    if (this.dead) {
      return Promise.reject(this.deadError ?? new HelperRuntimeError("helper_exited", "helper is not running"));
    }
    const id = this.nextId++;
    return new Promise<ScreenshotResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.screens.delete(id);
        reject(new Error("helper request timed out"));
      }, timeoutMs);
      this.screens.set(id, { sessionId: handle.sessionId, assembler: null, resolve, reject, timer });
      try {
        this.writeControl({ type: "rdp.screenshot", id, sessionId: handle.sessionId } as ControlMessage);
      } catch (error) {
        this.failScreenshot(id, error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** Stop the helper; children are torn down by the helper's own shutdown. */
  stop(): void {
    this.killChild();
  }
}
