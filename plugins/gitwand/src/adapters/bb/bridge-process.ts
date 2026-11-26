// gitwand-bridge as a child process of the plugin server, spoken to over
// stdio (src/core/bridge-protocol.ts). There is no port and no token: the
// pipe is the only way in, and the bridge exits when its stdin closes.
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { encodeBridgeRequest, parseBridgeLine } from "../../core/bridge-protocol.ts";

/** Line protocol version this plugin speaks (bridge-src `PROTOCOL`). */
export const BRIDGE_PROTOCOL = 1;

export type SpawnBridge = (bin: string, args: readonly string[], options: { env: NodeJS.ProcessEnv }) => ChildProcessWithoutNullStreams;

export interface BridgeHello {
  protocol: number;
  version: string;
  runtime: string;
  commit: string;
  generated: number;
  adapted: string[];
}

export type BridgeResult = { ok: true; value: unknown } | { ok: false; error: unknown };

const STDERR_TAIL = 2000;

function describeExit(code: number | null, signal: string | null): string {
  return signal !== null ? `signal ${signal}` : `code ${code}`;
}

export class BridgeProcess {
  hello!: BridgeHello;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (r: BridgeResult) => void; reject: (e: Error) => void }>();
  private readonly channelListeners: ((channel: number, message: unknown) => void)[] = [];
  private readonly invalidListeners: ((line: string) => void)[] = [];
  private readonly exitListeners: ((reason: string) => void)[] = [];
  private stderrTail = "";
  private exitReason: string | null = null;
  private readonly exited: Promise<void>;

  private constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stderr.on("data", (chunk: Buffer | string) => {
      this.stderrTail = (this.stderrTail + String(chunk)).slice(-STDERR_TAIL);
    });
    createInterface({ input: child.stdout }).on("line", (line) => this.onLine(line));
    this.exited = new Promise((resolve) => {
      child.on("exit", (code: number | null, signal: string | null) => {
        this.exitReason = `gitwand-bridge exited (${describeExit(code, signal)})`;
        const error = new Error(this.exitReason);
        for (const p of this.pending.values()) p.reject(error);
        this.pending.clear();
        for (const l of this.exitListeners) l(this.exitReason);
        resolve();
      });
    });
    // A write after the process died must not crash the plugin server.
    child.stdin.on("error", () => {});
  }

  /** Spawns the bridge and waits for its __hello answer. */
  static async start(options: { bin: string; env: NodeJS.ProcessEnv; spawn: SpawnBridge; helloTimeoutMs?: number }): Promise<BridgeProcess> {
    const timeoutMs = options.helloTimeoutMs ?? 5000;
    const bridge = new BridgeProcess(options.spawn(options.bin, [], { env: options.env }));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`gitwand-bridge did not answer __hello within ${timeoutMs} ms`)), timeoutMs);
    });
    try {
      const r = await Promise.race([bridge.call("__hello", {}), timeout]);
      if (!r.ok) throw new Error(`gitwand-bridge refused __hello: ${JSON.stringify(r.error)}`);
      const hello = r.value as BridgeHello;
      if (hello?.protocol !== BRIDGE_PROTOCOL) throw new Error(`gitwand-bridge speaks protocol ${hello?.protocol}, the plugin speaks ${BRIDGE_PROTOCOL}`);
      bridge.hello = hello;
      return bridge;
    } catch (error) {
      bridge.child.kill("SIGKILL");
      const message = (error as Error).message;
      if (message.startsWith("gitwand-bridge exited")) {
        throw new Error(`${message} before answering __hello: ${bridge.stderrTail.trim()}`.trim());
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  get alive(): boolean {
    return this.exitReason === null;
  }

  call(cmd: string, args: Record<string, unknown>, conn?: string): Promise<BridgeResult> {
    if (this.exitReason !== null) return Promise.reject(new Error(this.exitReason));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(encodeBridgeRequest(id, cmd, args, conn));
    });
  }

  onChannel(listener: (channel: number, message: unknown) => void): void {
    this.channelListeners.push(listener);
  }

  onInvalidLine(listener: (line: string) => void): void {
    this.invalidListeners.push(listener);
  }

  onExit(listener: (reason: string) => void): void {
    this.exitListeners.push(listener);
  }

  /** Closes stdin; then SIGTERM after `graceMs`, SIGKILL after another `graceMs`. */
  async stop(graceMs = 3000): Promise<void> {
    if (this.exitReason !== null) return;
    this.child.stdin.end();
    for (const signal of ["SIGTERM", "SIGKILL"] as const) {
      if (await this.waitExit(graceMs)) return;
      this.child.kill(signal);
    }
    await this.waitExit(graceMs);
  }

  private async waitExit(ms: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = await Promise.race([this.exited.then(() => true), new Promise<boolean>((r) => (timer = setTimeout(() => r(false), ms)))]);
    clearTimeout(timer);
    return done;
  }

  private onLine(line: string): void {
    const m = parseBridgeLine(line);
    if (m.kind === "channel") {
      for (const l of this.channelListeners) l(m.channel, m.message);
    } else if (m.kind === "result") {
      const p = this.pending.get(m.id);
      this.pending.delete(m.id);
      p?.resolve(m.ok ? { ok: true, value: m.value } : { ok: false, error: m.error });
    } else {
      for (const l of this.invalidListeners) l(line);
    }
  }
}

export interface BridgeRuntime {
  bin: string;
  env: NodeJS.ProcessEnv;
}

export type BridgeStatus =
  | { state: "no-runtime" }
  | { state: "stopped" }
  | { state: "starting" }
  | { state: "running"; runtime: string; commit: string; generated: number }
  | { state: "failed"; error: string };

/**
 * Keeps at most one bridge running: starts it on first use, reports when it
 * is lost, starts a new one on the next call, and gives up after three
 * unexpected exits within `crashWindowMs` until `restart()`.
 */
export class BridgeSupervisor {
  private current: BridgeProcess | null = null;
  private starting: Promise<BridgeProcess> | null = null;
  private state: BridgeStatus = { state: "stopped" };
  private crashes: number[] = [];
  private stopping = false;
  private readonly lostListeners: ((reason: string) => void)[] = [];
  private readonly channelListeners: ((channel: number, message: unknown) => void)[] = [];

  constructor(
    private readonly options: {
      resolve: () => Promise<BridgeRuntime | null>;
      spawn: SpawnBridge;
      crashWindowMs?: number;
      onInvalidLine?: (line: string) => void;
    },
  ) {}

  onLost(listener: (reason: string) => void): void {
    this.lostListeners.push(listener);
  }

  onChannel(listener: (channel: number, message: unknown) => void): void {
    this.channelListeners.push(listener);
  }

  status(): BridgeStatus {
    return this.state;
  }

  /** The live bridge, without starting one. */
  running(): BridgeProcess | null {
    return this.current?.alive ? this.current : null;
  }

  async get(): Promise<BridgeProcess> {
    if (this.current?.alive) return this.current;
    if (this.state.state === "failed") throw new Error(this.state.error);
    this.starting ??= this.launch().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  /** Stops the running bridge and clears a failed state, then starts again. */
  async restart(): Promise<BridgeProcess> {
    await this.stop();
    this.crashes = [];
    this.state = { state: "stopped" };
    return this.get();
  }

  async stop(): Promise<void> {
    const bridge = this.current;
    this.current = null;
    if (bridge === null) return;
    this.stopping = true;
    try {
      await bridge.stop();
    } finally {
      this.stopping = false;
      if (this.state.state !== "failed") this.state = { state: "stopped" };
    }
  }

  private async launch(): Promise<BridgeProcess> {
    const runtime = await this.options.resolve();
    if (runtime === null) {
      this.state = { state: "no-runtime" };
      throw new Error("The GitWand runtime is not installed");
    }
    this.state = { state: "starting" };
    let bridge: BridgeProcess;
    try {
      bridge = await BridgeProcess.start({ bin: runtime.bin, env: runtime.env, spawn: this.options.spawn });
    } catch (error) {
      this.state = { state: "failed", error: (error as Error).message };
      throw error;
    }
    bridge.onChannel((c, m) => {
      for (const l of this.channelListeners) l(c, m);
    });
    if (this.options.onInvalidLine) bridge.onInvalidLine(this.options.onInvalidLine);
    bridge.onExit((reason) => this.onBridgeExit(bridge, reason));
    this.current = bridge;
    this.state = { state: "running", runtime: bridge.hello.runtime, commit: bridge.hello.commit, generated: bridge.hello.generated };
    return bridge;
  }

  private onBridgeExit(bridge: BridgeProcess, reason: string): void {
    if (this.current === bridge) this.current = null;
    for (const l of this.lostListeners) l(reason);
    if (this.stopping) return;
    const now = Date.now();
    const window = this.options.crashWindowMs ?? 60_000;
    this.crashes = [...this.crashes.filter((t) => now - t < window), now];
    this.state =
      this.crashes.length >= 3
        ? { state: "failed", error: `gitwand-bridge exited ${this.crashes.length} times in a row; press Restart in the plugin settings` }
        : { state: "stopped" };
  }
}

const DROPPED = ["NODE_OPTIONS", "ELECTRON_RUN_AS_NODE", "NODE_ENV"];

/**
 * The bridge's environment: the host's, with the user's login shell when SHELL
 * is missing and without Node/Electron switches that would leak into the
 * integrated terminal. HOME is required: the Keychain is found through it.
 */
export function bridgeEnv(base: NodeJS.ProcessEnv, loginShell: string): NodeJS.ProcessEnv {
  if (!base.HOME) throw new Error("HOME is not set; gitwand-bridge needs it for the Keychain");
  const env: NodeJS.ProcessEnv = { ...base };
  for (const key of DROPPED) delete env[key];
  if (!env.SHELL) env.SHELL = loginShell;
  return env;
}
