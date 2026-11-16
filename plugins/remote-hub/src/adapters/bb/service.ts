// The Remote Hub backend service: owns the cached HelperProcess, restarts it
// after a crash without replaying any input, and exposes the operations the
// RPC surface wraps. Host-free of the BB SDK (only the adapter), so it is
// unit-testable with an injected startHelper factory.
import { AttachTokens, ATTACH_TOKEN_TTL_MS, type Clock } from "../../core/attach.ts";
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
}

export interface RemoteHubService {
  helperStatus(): Promise<HelperStatus>;
  echoOpen(cols: number, rows: number): Promise<SessionHandle>;
  echoInput(handle: SessionHandle, data: string): Promise<{ output: string; truncated: boolean }>;
  echoClose(handle: SessionHandle): Promise<{ closed: boolean }>;
  sshOpen(target: SshTarget, cols: number, rows: number): Promise<SessionHandle>;
  sessionList(): SessionInfo[];
  sessionClose(handle: SessionHandle): Promise<{ exitCode: number | null; signal: number | null; reason: string }>;
  sessionAttach(handle: SessionHandle): string;
  consumeAttachToken(token: string): { sessionId: number; generation: string } | null;
  sessionScrollback(handle: SessionHandle): Promise<Uint8Array>;
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
  const sessionEndListeners = new Map<string, Set<(info: { exitCode: number | null; signal: number | null; reason: string }) => void>>();
  const attachTokens = new AttachTokens(ATTACH_TOKEN_TTL_MS, deps.clock);
  const helperExitCallbacks = new Set<() => void>();
  const EVICT_CLOSED_AFTER_MS = 5 * 60 * 1000;

  const maybeEvictClosed = (key: string): void => {
    setTimeout(() => {
      const set = listeners.get(key);
      if (set === undefined || set.size === 0) {
        sessions.delete(key);
        sessionEndListeners.delete(key);
        listeners.delete(key);
      }
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
              for (const cb of ends) cb(info);
            }
            maybeEvictClosed(key);
          });
          started.onSessionOutput((sessionId, data) => {
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
        for (const cb of ends) cb(info);
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
