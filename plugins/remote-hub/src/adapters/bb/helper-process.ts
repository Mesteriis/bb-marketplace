// The BB adapter for the Rust helper: locates and verifies the binary, spawns
// it through the SDK host process API, performs the version handshake, and
// speaks the versioned stdio protocol from src/core/protocol.ts.
//
// Host imports are allowed here (src/adapters); src/core and src/ui stay free
// of them. The SDK host process API is experimental_spawnHostProcess /
// experimental_execHostFile from "@get-bb/plugin-sdk/process"
// (bundled-types/bb-plugin-sdk-process.d.ts:46-54); both wrap Node's
// child_process, which is what the BB server itself runs on.
import type { ExecFinishedMessage, ExecStateMessage } from "../../core/exec-protocol.ts";
import type { CredentialBind } from "../../core/credential.ts";
import type { RdpOptions } from "../../core/rdp-options.ts";
import type { PveConnect, PveConsoleTarget, PveGuest, PveNode, PvePlan, PveSteps } from "../../core/pve-protocol.ts";
import type { SshAskpassEvent } from "../../core/ssh-askpass-protocol.ts";
import { checkHelperIntegrity, type IntegrityResult } from "./helper-integrity.ts";
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
import { Scrollback, SCROLLBACK_MAX_BYTES, type ScrollbackRead } from "../../core/scrollback.ts";
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
/** What a Proxmox console reports about itself. `vnc_password` is delivered once to the one view and never logged. */
export type PveSessionEvent =
  | { type: "state"; state: string }
  | { type: "error"; code: string; message: string; fingerprint: string | null }
  | { type: "vnc_password"; password: string };

/** A PVE request the helper refused or could not finish: the closed code, and the certificate the server presented (certificate refusals). */
export class PveRequestFailure extends Error {
  readonly code: string;
  readonly fingerprint: string | null;
  readonly steps: PveSteps | null;
  constructor(code: string, message: string, fingerprint: string | null, steps: PveSteps | null = null) {
    super(message);
    this.name = "PveRequestFailure";
    this.code = code;
    this.fingerprint = fingerprint;
    this.steps = steps;
  }
}

/** How long a PVE discovery or onboarding may take in all: the engine bounds each step; this bounds the sum. */
const PVE_REQUEST_TIMEOUT_MS = 90_000;

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
      firstUse?: boolean;
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
  // Before anything is executed, and with no way around it: bin/SHA256SUMS must exist and match the binary. This detects a
  // corrupted or half-updated install; it does not defend against someone who can write to the plugin directory (they could
  // replace the checksum file or the plugin's code as well).
  let integrity: IntegrityResult;
  try {
    integrity = checkHelperIntegrity(binPath);
  } catch {
    integrity = { ok: false, code: "helper_checksum_failed", reason: "unreadable_sums" };
  }
  if (!integrity.ok) {
    return {
      ok: false,
      error: {
        code: integrity.code,
        message:
          "Remote Hub helper at " + binPath + " failed its checksum check (" + integrity.reason + ") and was not started. The check detects a corrupted or partly updated install, not someone who can write to the plugin directory. Reinstall the plugin" +
          (integrity.reason === "no_sums" ? ", or run 'npm run build:helper' in a development checkout" : "") + ".",
        path: binPath,
      },
    };
  }
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
  /** `verified`: the binary matched bin/SHA256SUMS before it was started (the only way the plugin starts it). */
  checksum: "verified" | "not_checked";
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
  /** Graphical PVE consoles: their stream frames are raw RFB, never terminal text (no scrollback, no byte credit). */
  private readonly vncSessions = new Set<number>();
  private readonly screens = new Map<number, PendingScreenshot>();
  private readonly onExecFinishedCallbacks: Array<(event: ExecFinishedMessage) => void> = [];
  private readonly onSshAskpassCallbacks: Array<(sessionId: number, event: SshAskpassEvent) => void> = [];
  private readonly onRdpEventCallbacks: Array<(sessionId: number, event: RdpHelperEvent) => void> = [];
  private readonly onRdpUpdateCallbacks: Array<(sessionId: number, seq: number, payload: Uint8Array) => void> = [];
  private readonly onSessionClosedCallbacks: Array<(sessionId: number, info: { exitCode: number | null; signal: number | null; reason: string }) => void> = [];
  private readonly onPveEventCallbacks: Array<(sessionId: number, event: PveSessionEvent) => void> = [];
  private readonly onVncDataCallbacks: Array<(sessionId: number, data: Uint8Array) => void> = [];
  private readonly onSessionOutputCallbacks: Array<(sessionId: number, data: Uint8Array) => void> = [];
  private readonly onExitCallbacks: Array<() => void> = [];
  private buffer: Uint8Array = new Uint8Array(0);
  private _status: Omit<HelperStatus, "alive" | "checksum"> | null = null;
  /** Set by `start` once the binary matched its checksum file; a bare `spawn` (tests) never checked. */
  checksumVerified = false;
  private generation = "";
  private dead = false;
  private deadError: Error | null = null;
  private killStarted = false;

  private constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
  }

  get status(): HelperStatus | null {
    if (this._status === null) return null;
    return { ...this._status, alive: !this.dead, checksum: this.checksumVerified ? "verified" : "not_checked" };
  }

  get currentGeneration(): string {
    return this.generation;
  }

  static async start(pluginDir: string, spawnFn: HelperSpawn = defaultSpawn): Promise<HelperProcess> {
    const binPath = helperBinaryPath(pluginDir);
    const probe = await probeHelper(binPath);
    if (!probe.ok) throw new HelperStartError(probe.error);
    const started = await HelperProcess.spawn(binPath, spawnFn);
    started.checksumVerified = true;
    return started;
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
          } else if ((resp as Extract<ResponseMessage, { type: "hello_ack" }>).protocol !== PROTOCOL_VERSION) {
            // A helper that answers for another protocol is refused even if it did not refuse the hello itself.
            reject(new HelperStartError({ code: "version_mismatch", message: "helper speaks protocol " + (resp as Extract<ResponseMessage, { type: "hello_ack" }>).protocol + ", this plugin speaks " + PROTOCOL_VERSION }));
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
    if (resp.type === "session.opened" && resp.kind === "vnc") this.vncSessions.add(resp.sessionId);
    const oneShotIndex = this.oneShots.findIndex((w) => w.predicate(resp));
    if (oneShotIndex >= 0) {
      const [waiter] = this.oneShots.splice(oneShotIndex, 1);
      waiter.resolve(resp);
      return;
    }
    if (this.handleRdpControl(resp)) return;
    if (this.handleSshAskpassControl(resp)) return;
    if (this.handlePveControl(resp)) return;
    if (resp.type === "exec.finished") {
      for (const cb of this.onExecFinishedCallbacks) cb(resp);
      return;
    }
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

  /** Askpass events of an SSH session (a prompt for the user, what happened to a saved credential). */
  private handleSshAskpassControl(resp: ResponseMessage): boolean {
    switch (resp.type) {
      case "ssh.prompt":
        this.emitSshAskpass(resp.sessionId, { type: "prompt", promptId: resp.promptId, text: resp.text, kind: resp.kind });
        return true;
      case "ssh.prompt_expired":
        this.emitSshAskpass(resp.sessionId, { type: "prompt_expired", promptId: resp.promptId });
        return true;
      case "ssh.credential_used":
        this.emitSshAskpass(resp.sessionId, { type: "credential_used" });
        return true;
      case "ssh.connected":
        this.emitSshAskpass(resp.sessionId, { type: "connected" });
        return true;
      case "ssh.credential_rejected":
        this.emitSshAskpass(resp.sessionId, { type: "credential_rejected" });
        return true;
      case "ssh.credential_failed":
        this.emitSshAskpass(resp.sessionId, { type: "credential_failed", code: resp.code });
        return true;
      default:
        return false;
    }
  }

  private emitSshAskpass(sessionId: number, event: SshAskpassEvent): void {
    for (const cb of this.onSshAskpassCallbacks) cb(sessionId, event);
  }

  /** Register for askpass events of SSH sessions. */
  onSshAskpass(cb: (sessionId: number, event: SshAskpassEvent) => void): void {
    this.onSshAskpassCallbacks.push(cb);
  }

  /** The user's answer to an `ssh.prompt` (null = cancelled). It is passed on once and never kept. */
  async sshPromptAnswer(handle: SessionHandle, promptId: number, answer: string | null): Promise<void> {
    this.assertGeneration(handle);
    const resp = await this.request({ type: "ssh.prompt_answer", sessionId: handle.sessionId, promptId, answer } as RequestMessage);
    if (resp.type === "error") throw new HelperRequestError(resp.code, resp.message);
    if (resp.type !== "ssh.prompt_ack") throw new Error("unexpected helper response: " + resp.type);
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
    if (this.vncSessions.has(sessionId)) {
      for (const cb of this.onVncDataCallbacks) cb(sessionId, data);
      return;
    }
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
    this.vncSessions.delete(sessionId);
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

  async openSsh(spec: SshSpawnSpec, cols: number, rows: number, askpass?: { credentialRef: string }): Promise<SessionHandle> {
    const resp = await this.request({
      type: "session.open_ssh",
      cols,
      rows,
      program: spec.program,
      argv: spec.argv,
      env: spec.env,
      cwd: null,
      ...(askpass !== undefined ? { askpass } : {}),
    } as RequestMessage);
    if (resp.type === "error") throw new HelperRequestError(resp.code, resp.message);
    if (resp.type !== "session.opened") throw new Error("unexpected helper response: " + resp.type);
    if (this._status !== null) this._status.sessionCount += 1;
    return { generation: this.generation, sessionId: resp.sessionId };
  }

  /**
   * Opens a Proxmox console. A node or LXC console is a terminal session (`kind` "pve"); a virtual machine's graphics is a
   * `vnc` session whose stream frames are the raw RFB bytes. The secret is resolved by the helper from `connect.credentialRef`.
   */
  async openPve(connect: PveConnect, target: PveConsoleTarget, cols: number, rows: number): Promise<{ handle: SessionHandle; kind: "pve" | "vnc" }> {
    const resp = await this.request({ type: "session.open_pve", connect, target, cols, rows } as RequestMessage);
    if (resp.type === "error") throw new HelperRequestError(resp.code, resp.message);
    if (resp.type !== "session.opened") throw new Error("unexpected helper response: " + resp.type);
    if (this._status !== null) this._status.sessionCount += 1;
    return { handle: { generation: this.generation, sessionId: resp.sessionId }, kind: resp.kind === "vnc" ? "vnc" : "pve" };
  }

  /** Raw RFB bytes from the view to a graphical console. */
  async pveVncInput(handle: SessionHandle, data: Uint8Array): Promise<void> {
    this.assertGeneration(handle);
    const resp = await this.request({ type: "pve.vnc_input", sessionId: handle.sessionId, data: Buffer.from(data).toString("base64") } as RequestMessage);
    if (resp.type === "error") throw new HelperRequestError(resp.code, resp.message);
    if (resp.type !== "session.input_ack") throw new Error("unexpected helper response: " + resp.type);
  }

  /** Console state and error events (and the one-time VNC password) of PVE sessions. True when consumed. */
  private handlePveControl(resp: ResponseMessage): boolean {
    switch (resp.type) {
      case "pve.state":
        for (const cb of this.onPveEventCallbacks) cb(resp.sessionId, { type: "state", state: resp.state });
        return true;
      case "pve.error":
        for (const cb of this.onPveEventCallbacks) cb(resp.sessionId, { type: "error", code: resp.code, message: resp.message, fingerprint: resp.fingerprint ?? null });
        return true;
      case "pve.vnc_password":
        for (const cb of this.onPveEventCallbacks) cb(resp.sessionId, { type: "vnc_password", password: resp.password });
        return true;
      default:
        return false;
    }
  }

  onPveEvent(cb: (sessionId: number, event: PveSessionEvent) => void): void {
    this.onPveEventCallbacks.push(cb);
  }

  /** Raw RFB bytes of graphical consoles, as the helper sends them. */
  onVncData(cb: (sessionId: number, data: Uint8Array) => void): void {
    this.onVncDataCallbacks.push(cb);
  }

  /**
   * Starts ONE remote command (ssh without a pty). The helper validates the argv again, answers the saved secret for its one
   * expected prompt and refuses every other question. Returns the run's id (same allocator as sessions).
   */
  async execRun(spec: SshSpawnSpec, askpass: { credentialRef: string }, timeoutMs: number, maxBytes: number): Promise<number> {
    const resp = await this.request({ type: "exec.run", program: spec.program, argv: spec.argv, env: spec.env, askpass, timeoutMs, maxBytes } as RequestMessage);
    if (resp.type === "error") throw new HelperRequestError(resp.code, resp.message);
    if (resp.type !== "exec.started") throw new HelperRequestError("protocol_error", "unexpected answer to exec.run");
    return resp.execId;
  }

  async execRead(execId: number, stdoutFrom: number, stderrFrom: number, max: number): Promise<ExecStateMessage> {
    const resp = await this.request({ type: "exec.read", execId, stdoutFrom, stderrFrom, max } as RequestMessage);
    if (resp.type === "error") throw new HelperRequestError(resp.code, resp.message);
    if (resp.type !== "exec.state") throw new HelperRequestError("protocol_error", "unexpected answer to exec.read");
    return resp;
  }

  async execCancel(execId: number): Promise<ExecStateMessage> {
    const resp = await this.request({ type: "exec.cancel", execId } as RequestMessage);
    if (resp.type === "error") throw new HelperRequestError(resp.code, resp.message);
    if (resp.type !== "exec.state") throw new HelperRequestError("protocol_error", "unexpected answer to exec.cancel");
    return resp;
  }

  async execForget(execId: number): Promise<void> {
    const resp = await this.request({ type: "exec.forget", execId } as RequestMessage);
    if (resp.type === "error") throw new HelperRequestError(resp.code, resp.message);
  }

  /** A run ended (the helper tells it unasked). */
  onExecFinished(cb: (event: ExecFinishedMessage) => void): void {
    this.onExecFinishedCallbacks.push(cb);
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

  /** Bytes of a session's terminal output from a read position (or the newest ones when `from` is null); never a copy of the whole buffer. */
  scrollbackRead(sessionId: number, from: number | null, max: number): ScrollbackRead {
    const scrollback = this.scrollbacks.get(sessionId) ?? new Scrollback(1);
    return from === null ? scrollback.tail(max) : scrollback.read(from, max);
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

  /** Stores a secret in the Keychain under `ref`. The secret goes down once; nothing comes back. */
  async credentialSave(ref: string, secret: string, bind: CredentialBind): Promise<void> {
    const resp = await this.request({ type: "credential.save", ref, secret, bind } as RequestMessage);
    if (resp.type === "error") throw new HelperRequestError(resp.code, resp.message);
    if (resp.type !== "credential.ok") throw new Error("unexpected helper response: " + resp.type);
  }

  /** Discovery on one PVE connection. A failure is a PveRequestFailure (code, message, fingerprint). */
  async pveTargets(connect: PveConnect): Promise<{ version: string | null; nodes: PveNode[]; guests: PveGuest[] }> {
    const resp = await this.request({ type: "pve.targets", connect } as RequestMessage, PVE_REQUEST_TIMEOUT_MS);
    if (resp.type === "pve.failed") throw new PveRequestFailure(resp.code, resp.message, resp.fingerprint ?? null, resp.steps ?? null);
    if (resp.type === "error") throw new HelperRequestError(resp.code, resp.message);
    if (resp.type !== "pve.targets_result") throw new Error("unexpected helper response: " + resp.type);
    return { version: resp.version, nodes: resp.nodes, guests: resp.guests };
  }

  /** Onboarding mode 1: the plan (dry run) or the applied steps. The new password never comes back. A failure is a PveRequestFailure with the steps. */
  async pveProvision(args: {
    connect: PveConnect;
    dryRun: boolean;
    aclPath: string;
    userId: string;
    replaceRole?: boolean;
    planDigest?: string;
    save?: Array<{ ref: string; bind: CredentialBind }>;
  }): Promise<{ kind: "plan"; plan: PvePlan } | { kind: "applied"; steps: PveSteps }> {
    const message = {
      type: "pve.provision",
      connect: args.connect,
      dryRun: args.dryRun,
      aclPath: args.aclPath,
      userId: args.userId,
      ...(args.replaceRole === true ? { replaceRole: true } : {}),
      ...(args.planDigest === undefined ? {} : { planDigest: args.planDigest }),
      ...(args.save === undefined ? {} : { save: args.save }),
    } as RequestMessage;
    const resp = await this.request(message, PVE_REQUEST_TIMEOUT_MS);
    if (resp.type === "pve.failed") throw new PveRequestFailure(resp.code, resp.message, resp.fingerprint ?? null, resp.steps ?? null);
    if (resp.type === "error") throw new HelperRequestError(resp.code, resp.message);
    if (resp.type === "pve.plan") {
      const { type: _t, id: _i, ...plan } = resp;
      return { kind: "plan", plan };
    }
    if (resp.type === "pve.provisioned") return { kind: "applied", steps: resp.steps };
    throw new Error("unexpected helper response: " + resp.type);
  }

  async credentialDelete(ref: string): Promise<void> {
    const resp = await this.request({ type: "credential.delete", ref } as RequestMessage);
    if (resp.type === "error") throw new HelperRequestError(resp.code, resp.message);
    if (resp.type !== "credential.ok") throw new Error("unexpected helper response: " + resp.type);
  }

  /** Whether the credential exists and the Keychain would hand it over (the value is never returned). */
  /** The helper-owned known_hosts overlay: its lines. */
  async knownHostsList(): Promise<string[]> {
    const resp = await this.request({ type: "known_hosts.list" } as RequestMessage);
    if (resp.type === "error") throw new HelperRequestError(resp.code, resp.message);
    if (resp.type !== "known_hosts.lines") throw new Error("unexpected helper response: " + resp.type);
    return resp.lines;
  }

  /** Adds plain host-key lines; resolves to how many were new. An invalid line refuses the whole call. */
  async knownHostsAdd(lines: string[]): Promise<number> {
    const resp = await this.request({ type: "known_hosts.add", lines } as RequestMessage);
    if (resp.type === "error") throw new HelperRequestError(resp.code, resp.message);
    if (resp.type !== "known_hosts.done") throw new Error("unexpected helper response: " + resp.type);
    return resp.count;
  }

  /** Forgets every line that names this host; resolves to how many went. */
  async knownHostsRemove(host: string): Promise<number> {
    const resp = await this.request({ type: "known_hosts.remove", host } as RequestMessage);
    if (resp.type === "error") throw new HelperRequestError(resp.code, resp.message);
    if (resp.type !== "known_hosts.done") throw new Error("unexpected helper response: " + resp.type);
    return resp.count;
  }

  /** The owner's "Allow access": macOS may show its own dialog (the helper waits up to 60 s). Nothing comes back. */
  async credentialAllow(ref: string): Promise<void> {
    const resp = await this.request({ type: "credential.allow", ref } as RequestMessage, 75_000);
    if (resp.type === "error") throw new HelperRequestError(resp.code, resp.message);
    if (resp.type !== "credential.ok") throw new Error("unexpected helper response: " + resp.type);
  }

  async credentialStatus(ref: string): Promise<boolean> {
    const resp = await this.request({ type: "credential.status", ref } as RequestMessage);
    if (resp.type === "error") throw new HelperRequestError(resp.code, resp.message);
    if (resp.type !== "credential.state") throw new Error("unexpected helper response: " + resp.type);
    return resp.present;
  }

  async openRdp(params: {
    host: string;
    port: number;
    username: string;
    /** Exactly one of password (use once) and credentialRef (saved; the helper resolves it). */
    password?: string;
    credentialRef?: string;
    domain: string | null;
    width: number;
    height: number;
    expectedFingerprint: string | null;
    options?: RdpOptions;
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

  async rdpInput(handle: SessionHandle, events: RdpInputEvent[], owner?: string): Promise<void> {
    this.assertGeneration(handle);
    this.expectAck(await this.request({ type: "rdp.input", sessionId: handle.sessionId, events, ...(owner === undefined ? {} : { owner }) } as RequestMessage));
  }

  /**
   * A new driver for a session (terminal or desktop). The answer comes only after the helper has dropped what the previous
   * driver still had queued and released what it left down: the barrier before the next driver's input.
   */
  async sessionSetOwner(handle: SessionHandle, owner: string): Promise<{ dropped: number; released: number }> {
    this.assertGeneration(handle);
    const resp = await this.request({ type: "session.set_owner", sessionId: handle.sessionId, owner } as RequestMessage);
    if (resp.type === "error") throw new HelperRequestError(resp.code, resp.message);
    if (resp.type !== "session.owner_set") throw new HelperRequestError("protocol_error", "unexpected answer to session.set_owner");
    return { dropped: resp.dropped, released: resp.released };
  }

  /** Terminal text typed by the current driver (an agent: its owner tag). The helper refuses it if that driver was replaced. */
  async sessionInputFrom(handle: SessionHandle, data: string, owner: string): Promise<void> {
    this.assertGeneration(handle);
    const resp = await this.request({ type: "session.input", sessionId: handle.sessionId, data, owner } as RequestMessage);
    if (resp.type === "error") throw new HelperRequestError(resp.code, resp.message);
    if (resp.type !== "session.input_ack") throw new HelperRequestError("protocol_error", "unexpected answer to session.input");
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
