// The Remote Hub backend service: owns the cached HelperProcess, restarts it
// after a crash without replaying any input, and exposes the operations the
// RPC surface wraps. Host-free of the BB SDK (only the adapter), so it is
// unit-testable with an injected startHelper factory.
import { AttachTokens, ATTACH_TOKEN_TTL_MS, type Clock } from "../../core/attach.ts";
import { createCreditState, type CreditState } from "../../core/credit.ts";
import { buildSshSpawn, type SshTarget } from "../../core/ssh-args.ts";
import { HelperProcess, HelperStatus, HelperRuntimeError } from "./helper-process.ts";
import type { SessionHandle } from "../../core/rpc.ts";

export type SessionState = "connecting" | "running" | "closed";

export interface SessionInfo {
  generation: string;
  sessionId: number;
  kind: "echo" | "ssh";
  target?: SshTarget;
  state: SessionState;
  exitCode: number | null;
  signal: number | null;
  reason: string | null;
}

export interface RemoteHubServiceDeps {
  startHelper: () => Promise<HelperProcess>;
  env?: Record<string, string | undefined>;
  clock?: Clock;
  /** Test-only opener for a raw spawn spec (used by the integration suite against a test-hooks helper). */
  openSshRaw?: (helper: HelperProcess, cols: number, rows: number) => Promise<SessionHandle>;
}

export interface RemoteHubService {
  helperStatus(): Promise<HelperStatus>;
  echoOpen(cols: number, rows: number): Promise<SessionHandle>;
  echoInput(handle: SessionHandle, data: string): Promise<{ output: string; truncated: boolean }>;
  echoClose(handle: SessionHandle): Promise<{ closed: boolean }>;
  sshOpen(target: SshTarget, cols: number, rows: number): Promise<SessionHandle>;
  sshOpenTest(cols: number, rows: number): Promise<SessionHandle>;
  sessionList(): SessionInfo[];
  sessionClose(handle: SessionHandle): Promise<{ exitCode: number | null; signal: number | null; reason: string }>;
  sessionAttach(handle: SessionHandle): string;
  consumeAttachToken(token: string): { sessionId: number; generation: string } | null;
  sessionScrollback(handle: SessionHandle): Promise<Uint8Array>;
  attachStream(handle: SessionHandle): {
    snapshot: Uint8Array;
    subscribe: (cb: (data: Uint8Array) => void) => () => void;
    cancel: () => void;
  };
  creditAttach(handle: SessionHandle, attachId: string): number;
  creditDetach(handle: SessionHandle, attachId: string): number;
  creditLiveSent(handle: SessionHandle, attachId: string, bytes: number): void;
  creditAck(handle: SessionHandle, attachId: string, bytes: number): number;
  creditState(handle: SessionHandle): CreditState | undefined;
  subscribeSession(handle: SessionHandle, cb: (data: Uint8Array) => void): () => void;
  subscribeSessionEnd(
    handle: SessionHandle,
    cb: (info: { exitCode: number | null; signal: number | null; reason: string }) => void,
  ): () => void;
  sessionTerminalInput(handle: SessionHandle, data: Uint8Array): Promise<void>;
  sessionResize(handle: SessionHandle, cols: number, rows: number): Promise<void>;
  sessionCredit(handle: SessionHandle, bytes: number): Promise<void>;
  onHelperExit(cb: () => void): () => void;
  stop(): void;
}

function keyOf(handle: SessionHandle): string {
  return handle.generation + ":" + handle.sessionId;
}

export function createRemoteHubService(deps: RemoteHubServiceDeps): RemoteHubService {
  let helper: HelperProcess | null = null;
  let starting: Promise<HelperProcess> | null = null;
  const sessions = new Map<string, SessionInfo>();
  const listeners = new Map<string, Set<(data: Uint8Array) => void>>();
  const credits = new Map<string, CreditState>();
  const sessionEndListeners = new Map<string, Set<(info: { exitCode: number | null; signal: number | null; reason: string }) => void>>();
  const attachTokens = new AttachTokens(ATTACH_TOKEN_TTL_MS, deps.clock);
  const helperExitCallbacks = new Set<() => void>();
  const EVICT_CLOSED_AFTER_MS = 5 * 60 * 1000;

  const maybeEvictClosed = (key: string): void => {
    setTimeout(() => {
      const set = listeners.get(key);
      if (set !== undefined && set.size > 0) {
        // A view is still attached: retry later rather than leak or evict early.
        maybeEvictClosed(key);
        return;
      }
      sessions.delete(key);
      sessionEndListeners.delete(key);
      listeners.delete(key);
      credits.delete(key);
    }, EVICT_CLOSED_AFTER_MS);
  };

  const start = (): Promise<HelperProcess> => {
    if (helper !== null) return Promise.resolve(helper);
    if (starting === null) {
      starting = deps
        .startHelper()
        .then((started) => {
          helper = started;
          const generation = started.currentGeneration;
          started.onExit(() => {
            if (helper === started) {
              helper = null;
              for (const info of sessions.values()) {
                if (info.generation === generation && info.state !== "closed") {
                  info.state = "closed";
                  info.exitCode = null;
                  info.signal = null;
                  info.reason = "helper_exited";
                }
              }
              for (const key of Array.from(listeners.keys())) {
                if (key.startsWith(generation + ":")) listeners.delete(key);
              }
              for (const key of Array.from(credits.keys())) {
                if (key.startsWith(generation + ":")) credits.delete(key);
              }
              for (const key of Array.from(sessions.keys())) {
                if (key.startsWith(generation + ":")) maybeEvictClosed(key);
              }
              attachTokens.revokeGeneration(generation);
              for (const cb of helperExitCallbacks) cb();
            }
          });
          started.onSessionClosed((sessionId, info) => {
            const key = generation + ":" + sessionId;
            const existing = sessions.get(key);
            if (existing !== undefined) {
              existing.state = "closed";
              existing.exitCode = info.exitCode;
              existing.signal = info.signal;
              existing.reason = info.reason;
            }
            const ends = sessionEndListeners.get(key);
            if (ends !== undefined) {
              for (const cb of ends) {
                try {
                  cb(info);
                } catch {
                  // one listener's throw must not skip the others
                }
              }
            }
            maybeEvictClosed(key);
          });
          started.onSessionOutput((sessionId, data) => {
            credits.get(generation + ":" + sessionId)?.onConsumed(data.byteLength);
            const set = listeners.get(generation + ":" + sessionId);
            if (set !== undefined) {
              for (const cb of set) cb(data);
            }
          });
          return started;
        })
        .finally(() => {
          starting = null;
        });
    }
    return starting;
  };

  const requireGeneration = (handle: SessionHandle): void => {
    if (helper === null) throw new HelperRuntimeError("session_not_found", "no helper running");
    if (handle.generation !== helper.currentGeneration) {
      throw new HelperRuntimeError("session_not_found", "session handle belongs to a different helper generation");
    }
    if (!sessions.has(keyOf(handle))) {
      throw new HelperRuntimeError("session_not_found", "unknown session");
    }
  };

  return {
    async helperStatus() {
      const process = await start();
      const alive = await process.pingAlive();
      return { ...process.status!, alive };
    },
    async echoOpen(cols, rows) {
      const process = await start();
      const handle = await process.openEcho(cols, rows);
      sessions.set(keyOf(handle), {
        generation: handle.generation,
        sessionId: handle.sessionId,
        kind: "echo",
        state: "running",
        exitCode: null,
        signal: null,
        reason: null,
      });
      return handle;
    },
    async echoInput(handle, data) {
      const process = await start();
      return process.input(handle, data);
    },
    async echoClose(handle) {
      const process = await start();
      await process.close(handle);
      sessions.delete(keyOf(handle));
      return { closed: true };
    },
    async sshOpenTest(cols, rows) {
      if (deps.openSshRaw === undefined) throw new Error("sshOpenTest requires a test opener");
      const hp = await start();
      const handle = await deps.openSshRaw(hp, cols, rows);
      sessions.set(keyOf(handle), {
        generation: handle.generation,
        sessionId: handle.sessionId,
        kind: "ssh",
        state: "running",
        exitCode: null,
        signal: null,
        reason: null,
      });
      return handle;
    },
    async sshOpen(target, cols, rows) {
      const hp = await start();
      const spec = buildSshSpawn(target, deps.env ?? process.env);
      const handle = await hp.openSsh(spec, cols, rows);
      sessions.set(keyOf(handle), {
        generation: handle.generation,
        sessionId: handle.sessionId,
        kind: "ssh",
        target,
        state: "running",
        exitCode: null,
        signal: null,
        reason: null,
      });
      return handle;
    },
    sessionList() {
      return Array.from(sessions.values());
    },
    async sessionClose(handle) {
      requireGeneration(handle);
      const process = await start();
      const info = await process.close(handle);
      const key = keyOf(handle);
      const existing = sessions.get(key);
      if (existing !== undefined) {
        existing.state = "closed";
        existing.exitCode = info.exitCode;
        existing.signal = info.signal;
        existing.reason = info.reason;
      }
      const ends = sessionEndListeners.get(key);
      if (ends !== undefined) {
        for (const cb of ends) {
          try {
            cb(info);
          } catch {
            // one listener's throw must not skip the others
          }
        }
      }
      maybeEvictClosed(key);
      return info;
    },
    sessionAttach(handle) {
      requireGeneration(handle);
      return attachTokens.issue(handle.sessionId, handle.generation);
    },
    consumeAttachToken(token) {
      return attachTokens.consume(token);
    },
    async sessionScrollback(handle) {
      requireGeneration(handle);
      const process = await start();
      return process.scrollbackSnapshot(handle.sessionId);
    },
    attachStream(handle) {
      requireGeneration(handle);
      const process = helper!;
      // Snapshot and subscription are established synchronously (no await), so
      // no output can slip between the two: bytes are either in the snapshot or
      // buffered for the live tail, never both and never missing.
      const snapshot = process.scrollbackSnapshot(handle.sessionId);
      const key = keyOf(handle);
      let set = listeners.get(key);
      if (set === undefined) {
        set = new Set();
        listeners.set(key, set);
      }
      const buffer: Uint8Array[] = [];
      let live: ((data: Uint8Array) => void) | null = null;
      const buffered = (data: Uint8Array): void => {
        if (live !== null) live(data);
        else buffer.push(data);
      };
      set.add(buffered);
      const cancel = (): void => {
        set.delete(buffered);
        if (set.size === 0) listeners.delete(key);
      };
      return {
        snapshot,
        subscribe(cb) {
          live = cb;
          for (const data of buffer) cb(data);
          buffer.length = 0;
          return () => cancel();
        },
        cancel,
      };
    },
    creditState(handle) {
      return credits.get(keyOf(handle));
    },
    creditAttach(handle, attachId) {
      requireGeneration(handle);
      const key = keyOf(handle);
      let state = credits.get(key);
      if (state === undefined) {
        state = createCreditState();
        credits.set(key, state);
      }
      return state.attach(attachId);
    },
    creditDetach(handle, attachId) {
      const key = keyOf(handle);
      return credits.get(key)?.detach(attachId) ?? 0;
    },
    creditLiveSent(handle, attachId, bytes) {
      const key = keyOf(handle);
      credits.get(key)?.onLiveSent(attachId, bytes);
    },
    creditAck(handle, attachId, bytes) {
      const key = keyOf(handle);
      return credits.get(key)?.ack(attachId, bytes) ?? 0;
    },
    subscribeSession(handle, cb) {
      requireGeneration(handle);
      const key = keyOf(handle);
      let set = listeners.get(key);
      if (set === undefined) {
        set = new Set();
        listeners.set(key, set);
      }
      set.add(cb);
      return () => {
        set.delete(cb);
        if (set.size === 0) listeners.delete(key);
      };
    },
    subscribeSessionEnd(handle, cb) {
      requireGeneration(handle);
      const key = keyOf(handle);
      let set = sessionEndListeners.get(key);
      if (set === undefined) {
        set = new Set();
        sessionEndListeners.set(key, set);
      }
      set.add(cb);
      return () => {
        set.delete(cb);
        if (set.size === 0) sessionEndListeners.delete(key);
      };
    },
    async sessionTerminalInput(handle, data) {
      requireGeneration(handle);
      const process = await start();
      process.writeInput(handle.sessionId, data);
    },
    async sessionResize(handle, cols, rows) {
      requireGeneration(handle);
      const process = await start();
      await process.resize(handle, cols, rows);
    },
    async sessionCredit(handle, bytes) {
      requireGeneration(handle);
      const process = await start();
      await process.credit(handle, bytes);
    },
    onHelperExit(cb) {
      helperExitCallbacks.add(cb);
      return () => helperExitCallbacks.delete(cb);
    },
    stop() {
      if (helper !== null) helper.stop();
    },
  };
}
