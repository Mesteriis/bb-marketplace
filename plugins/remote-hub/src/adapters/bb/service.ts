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
  stop(): void;
}

export function createRemoteHubService(deps: RemoteHubServiceDeps): RemoteHubService {
  let helper: HelperProcess | null = null;
  let starting: Promise<HelperProcess> | null = null;
  const sessions = new Map<number, SessionInfo>();
  const attachTokens = new AttachTokens(ATTACH_TOKEN_TTL_MS, deps.clock);

  const start = (): Promise<HelperProcess> => {
    if (helper !== null) return Promise.resolve(helper);
    if (starting === null) {
      starting = deps
        .startHelper()
        .then((started) => {
          helper = started;
          started.onExit(() => {
            if (helper === started) helper = null;
          });
          started.onSessionClosed((sessionId, info) => {
            const existing = sessions.get(sessionId);
            if (existing !== undefined) {
              existing.state = "closed";
              existing.exitCode = info.exitCode;
              existing.signal = info.signal;
              existing.reason = info.reason;
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
    if (!sessions.has(handle.sessionId)) {
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
      sessions.set(handle.sessionId, {
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
      sessions.delete(handle.sessionId);
      return { closed: true };
    },
    async sshOpen(target, cols, rows) {
      const hp = await start();
      const spec = buildSshSpawn(target, deps.env ?? process.env);
      const handle = await hp.openSsh(spec, cols, rows);
      sessions.set(handle.sessionId, {
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
      const existing = sessions.get(handle.sessionId);
      if (existing !== undefined) {
        existing.state = "closed";
        existing.exitCode = info.exitCode;
        existing.signal = info.signal;
        existing.reason = info.reason;
      }
      return info;
    },
    sessionAttach(handle) {
      requireGeneration(handle);
      return attachTokens.issue(handle.sessionId, handle.generation);
    },
    consumeAttachToken(token) {
      return attachTokens.consume(token);
    },
    stop() {
      if (helper !== null) helper.stop();
    },
  };
}
