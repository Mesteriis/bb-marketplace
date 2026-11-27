import { CommanderError, CommanderErrorShape } from "../../core/errors.ts";
import {
  FrameDecoder, HelloMessage, PROTOCOL_VERSION, ProtocolError, encodeControl, encodeSecret, type Frame,
} from "../../core/wire/archive-protocol.ts";
import type { IntegrityResult } from "./archive-helper-integrity.ts";

/** What the client needs from a child process (a Node ChildProcessWithoutNullStreams fits). */
export interface HelperProcess {
  stdin: { write(chunk: Uint8Array): unknown; end(): unknown };
  stdout: { on(event: "data", listener: (chunk: Buffer) => void): unknown };
  stderr: { on(event: "data", listener: (chunk: Buffer) => void): unknown };
  pid?: number | undefined;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
}

export interface ArchiveHelperOptions {
  binPath: string;
  helperVersion: string;
  platform: string;
  arch: string;
  spawn(command: string, args: string[], options: { env: Record<string, string> }): HelperProcess;
  integrity(binPath: string): IntegrityResult;
  handshakeTimeoutMs?: number;
  /** A request fails when the helper sends no frame for this long. */
  requestTimeoutMs?: number;
  killGraceMs?: number;
  /** Resident memory watchdog; omitted = off. */
  rssLimitBytes?: number;
  readRss?: (pid: number) => Promise<number | null>;
  rssPollMs?: number;
}

export interface HelperResult {
  json: Record<string, unknown> & { t: string };
  data: Uint8Array[];
}

export interface RequestOptions {
  signal?: AbortSignal;
  /** Called when the helper asks for the owner's password; the returned bytes are cleared after sending. */
  password?: () => Promise<Uint8Array | null>;
}

type Pending = {
  req: number;
  body: Record<string, unknown>;
  options: RequestOptions;
  resolve(result: HelperResult): void;
  reject(error: unknown): void;
  data: Uint8Array[];
  timer: ReturnType<typeof setTimeout> | null;
  abortListener: (() => void) | null;
};

const STDERR_MAX = 64 * 1024;
const CHILD_ENV = { PATH: "/usr/bin:/bin" };

const unavailable = () =>
  new CommanderError("unsupported", "Archives are unavailable: no helper for this platform", false, "archives_unavailable");
const crashed = (message = "Archive helper stopped") =>
  new CommanderError("internal", message, true, "helper_crashed");
const protocolError = () => new CommanderError("internal", "Archive helper protocol error", true, "protocol_error");

export class ArchiveHelperClient {
  private proc: HelperProcess | null = null;
  private decoder = new FrameDecoder("from-helper");
  private helloWaiter: { resolve(h: HelloMessage): void; reject(e: unknown): void } | null = null;
  private current: Pending | null = null;
  private queue: Pending[] = [];
  private nextReq = 1;
  private dead: CommanderError | null = null;
  private stderr = "";
  private exited: Promise<void> | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly options: ArchiveHelperOptions) {}

  stderrTail(): string {
    return this.stderr;
  }

  async start(): Promise<{ rlimitAs: HelloMessage["rlimit_as"] }> {
    const { platform, arch, binPath } = this.options;
    if (platform !== "darwin" || arch !== "arm64") throw unavailable();
    const integrity = this.options.integrity(binPath);
    if (!integrity.ok) {
      throw new CommanderError("internal", "Archive helper failed its checksum check", false, "helper_checksum_failed");
    }
    const proc = this.options.spawn(binPath, [], { env: { ...CHILD_ENV } });
    this.proc = proc;
    this.exited = new Promise((resolve) => proc.on("exit", () => resolve()));
    proc.stdout.on("data", (chunk) => this.onData(chunk));
    proc.stderr.on("data", (chunk) => {
      this.stderr = (this.stderr + chunk.toString("utf8")).slice(-STDERR_MAX);
    });
    proc.on("exit", () => this.onExit());
    proc.on("error", () => this.onExit());
    const hello = new Promise<HelloMessage>((resolve, reject) => {
      this.helloWaiter = { resolve, reject };
    });
    const timer = setTimeout(() => this.fatal(crashed("Archive helper did not answer the handshake")),
      this.options.handshakeTimeoutMs ?? 5000);
    try {
      const message = await hello;
      if (message.protocol !== PROTOCOL_VERSION || message.helper !== this.options.helperVersion) {
        const error = new CommanderError("internal", "Archive helper version does not match", false, "helper_version_mismatch");
        this.fatal(error);
        throw error;
      }
      this.startWatchdog();
      return { rlimitAs: message.rlimit_as };
    } finally {
      clearTimeout(timer);
    }
  }

  request(body: Record<string, unknown> & { t: string }, options: RequestOptions = {}): Promise<HelperResult> {
    if (this.dead) return Promise.reject(this.dead);
    return new Promise((resolve, reject) => {
      const pending: Pending = {
        req: this.nextReq++, body, options, resolve, reject, data: [], timer: null, abortListener: null,
      };
      this.queue.push(pending);
      this.pump();
    });
  }

  async close(): Promise<void> {
    if (!this.proc || this.dead) return;
    this.dead = crashed("Archive helper is closed");
    this.stopWatchdog();
    this.failAll(this.dead);
    await this.terminate();
  }

  private pump(): void {
    if (this.current || this.queue.length === 0 || !this.proc || this.dead) return;
    const pending = this.queue.shift()!;
    this.current = pending;
    const { signal } = pending.options;
    if (signal) {
      if (signal.aborted) {
        this.current = null;
        pending.reject(signal.reason ?? new CommanderError("cancelled", "Cancelled"));
        this.pump();
        return;
      }
      pending.abortListener = () => this.send({ t: "cancel", req: this.nextReq++, target: pending.req });
      signal.addEventListener("abort", pending.abortListener, { once: true });
    }
    this.arm(pending);
    this.send({ ...pending.body, req: pending.req });
  }

  private arm(pending: Pending): void {
    if (pending.timer) clearTimeout(pending.timer);
    pending.timer = setTimeout(() => this.fatal(crashed("Archive helper timed out")), this.options.requestTimeoutMs ?? 30_000);
  }

  private finish(pending: Pending): void {
    if (pending.timer) clearTimeout(pending.timer);
    if (pending.abortListener) pending.options.signal?.removeEventListener("abort", pending.abortListener);
    if (this.current === pending) this.current = null;
  }

  private send(message: Record<string, unknown>): void {
    try {
      this.proc?.stdin.write(encodeControl(message));
    } catch {
      this.fatal(crashed());
    }
  }

  private onData(chunk: Buffer): void {
    let frames: Frame[];
    try {
      frames = this.decoder.push(chunk);
    } catch (error) {
      if (error instanceof ProtocolError) this.fatal(protocolError());
      else throw error;
      return;
    }
    for (const frame of frames) {
      if (this.dead) return;
      this.onFrame(frame);
    }
  }

  private onFrame(frame: Frame): void {
    if (frame.kind === "secret") return this.fatal(protocolError());
    if (this.helloWaiter) {
      const waiter = this.helloWaiter;
      this.helloWaiter = null;
      const parsed = frame.kind === "control" ? HelloMessage.safeParse(frame.json) : null;
      if (!parsed?.success) return this.fatal(protocolError());
      waiter.resolve(parsed.data);
      return;
    }
    const pending = this.current;
    if (frame.kind === "control" && frame.json.t === "hello") return this.fatal(protocolError());
    if (!pending) return this.fatal(protocolError());
    if (frame.kind === "data") {
      if (frame.reqId !== pending.req) return this.fatal(protocolError());
      pending.data.push(frame.bytes);
      this.arm(pending);
      return;
    }
    const json = frame.json as HelperResult["json"];
    if (typeof json.t !== "string" || json.req !== pending.req) return this.fatal(protocolError());
    this.arm(pending);
    if (json.t === "need_password") {
      void this.answerPassword(pending);
      return;
    }
    if (json.t === "ok") {
      this.finish(pending);
      pending.resolve({ json, data: pending.data });
      this.pump();
      return;
    }
    if (json.t === "err") {
      const shape = CommanderErrorShape.safeParse({
        code: json.code, message: json.message, retryable: false, ...(json.reason === undefined ? {} : { reason: json.reason }),
      });
      if (!shape.success) return this.fatal(protocolError());
      this.finish(pending);
      pending.reject(new CommanderError(shape.data.code, shape.data.message, false, shape.data.reason));
      this.pump();
      return;
    }
    this.fatal(protocolError());
  }

  private async answerPassword(pending: Pending): Promise<void> {
    const ask = pending.options.password;
    let password: Uint8Array | null = null;
    try {
      password = ask ? await ask() : null;
    } catch {
      password = null;
    }
    if (this.current !== pending || this.dead) {
      password?.fill(0);
      return;
    }
    if (!password || password.length === 0) {
      password?.fill(0);
      this.finish(pending);
      pending.reject(new CommanderError("auth_failed", "The archive is encrypted: a password is required", false, "password_required"));
      this.pump();
      return;
    }
    try {
      this.proc?.stdin.write(encodeSecret(pending.req, password));
    } catch {
      this.fatal(crashed());
    } finally {
      password.fill(0);
    }
  }

  /** Protocol breach, timeout, version mismatch: kill the helper, fail everything. */
  private fatal(error: CommanderError): void {
    if (this.dead) return;
    this.dead = error;
    this.stopWatchdog();
    this.helloWaiter?.reject(error);
    this.helloWaiter = null;
    this.failAll(error);
    this.proc?.kill("SIGKILL");
  }

  private onExit(): void {
    this.stopWatchdog();
    if (!this.dead) this.dead = crashed();
    this.helloWaiter?.reject(this.dead);
    this.helloWaiter = null;
    this.failAll(this.dead);
  }

  private failAll(error: CommanderError): void {
    const waiting = [...(this.current ? [this.current] : []), ...this.queue];
    this.queue = [];
    for (const pending of waiting) {
      this.finish(pending);
      pending.reject(error);
    }
  }

  private async terminate(): Promise<void> {
    const proc = this.proc;
    if (!proc) return;
    proc.kill("SIGTERM");
    const grace = new Promise<"grace">((resolve) => setTimeout(() => resolve("grace"), this.options.killGraceMs ?? 2000));
    if ((await Promise.race([this.exited!.then(() => "exited" as const), grace])) === "grace") proc.kill("SIGKILL");
    await this.exited;
  }

  private startWatchdog(): void {
    const { rssLimitBytes, readRss, rssPollMs } = this.options;
    const pid = this.proc?.pid;
    if (!rssLimitBytes || !readRss || pid === undefined) return;
    this.watchdog = setInterval(() => {
      void readRss(pid).then((rss) => {
        if (rss !== null && rss > rssLimitBytes && !this.dead) {
          this.dead = crashed("Archive helper exceeded its memory limit");
          this.stopWatchdog();
          this.failAll(this.dead);
          void this.terminate();
        }
      }).catch(() => undefined);
    }, rssPollMs ?? 1000);
    this.watchdog.unref?.();
  }

  private stopWatchdog(): void {
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
  }
}
