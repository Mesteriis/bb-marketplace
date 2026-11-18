// Connects the exec tools (core/agent-exec-tools.ts) to the service (stage 4b-2): turns a connection into an ssh target
// with its saved credential, and keeps the owner's live view fed while a command runs. Thin on purpose: the rules live
// in the core.
import { ToolError } from "../../core/agent-tools.ts";
import type { AgentExecPorts, ExecSnapshotView } from "../../core/agent-exec-tools.ts";
import { profileToSshTarget } from "../../core/catalogue.ts";
import { CredentialError } from "../../core/credential.ts";
import type { AgentFeed } from "../../core/agent-feed.ts";
import type { Profile } from "../../core/profile.ts";
import { sanitizeTerminalBytes } from "../../core/terminal-text.ts";
import type { ExecHandle, RemoteHubService } from "./service.ts";

/** Bytes the helper keeps per stream of a run (the head). */
export const EXEC_KEEP_BYTES = 1024 * 1024;
const LIVE_CHUNK_BYTES = 4096;
/** Pieces shown per look: a command that floods cannot keep the poll busy for ever. */
const LIVE_ROUNDS = 16;

export interface AgentExecPortDeps {
  service: Pick<RemoteHubService, "execRun" | "execRead" | "execCancel" | "execForget" | "onExecFinished">;
  profiles: { get(id: string): Profile | null };
  credentials: { authorizeSsh(ref: string, endpoint: { protocol: "ssh"; host: string; port: number; user: string | null; domain: null }, identityFile: string | undefined): "password" | "publickey" };
  /** What the command prints, shown live in the session's open views (memory only). */
  feed?: AgentFeed;
  /** How often a running command is looked at for the live view. */
  pollMs?: number;
}

function handleOf(runKey: string): ExecHandle {
  const m = /^([0-9a-f]{32})\.(\d{1,10})$/.exec(runKey);
  if (m === null) throw new Error("bad run key");
  return { generation: m[1] as string, execId: Number(m[2]) };
}
const keyOf = (h: ExecHandle): string => `${h.generation}.${h.execId}`;

export function agentExecPorts({ service, profiles, credentials, feed, pollMs = 300 }: AgentExecPortDeps): AgentExecPorts {
  const finishedListeners = new Set<(runKey: string) => void>();
  const polls = new Map<string, ReturnType<typeof setInterval>>();
  const stopPoll = (runKey: string): void => {
    const timer = polls.get(runKey);
    if (timer !== undefined) clearInterval(timer);
    polls.delete(runKey);
  };
  /** Tells the tools a run is over. The live poll is left running: it still has to show the last output and the end. */
  const announceFinished = (runKey: string): void => {
    for (const cb of [...finishedListeners]) {
      try {
        cb(runKey);
      } catch {
        // one listener's throw must not skip the others
      }
    }
  };
  service.onExecFinished((e) => announceFinished(keyOf(e.handle)));

  /** Reads what is new on both streams and shows it; stops once the run is over. */
  function livePoll(runKey: string, sessionKey: string): void {
    const sent = { stdout: 0, stderr: 0 };
    let busy = false;
    const timer = setInterval(() => {
      if (busy) return;
      busy = true;
      void (async () => {
        try {
          let snap = await service.execRead(handleOf(runKey), sent.stdout, sent.stderr, LIVE_CHUNK_BYTES);
          // Everything that is there, in bounded pieces: a read that came back full has more behind it.
          for (let round = 0; round < LIVE_ROUNDS; round++) {
            let full = false;
            for (const stream of ["stdout", "stderr"] as const) {
              const c = snap[stream];
              if (c.data.length > 0) {
                feed?.emit(sessionKey, { kind: "exec", commandId: runKey, phase: "output", stream, text: sanitizeTerminalBytes(c.data) });
                sent[stream] = c.end;
                if (c.data.length >= LIVE_CHUNK_BYTES) full = true;
              }
            }
            if (!full) break;
            snap = await service.execRead(handleOf(runKey), sent.stdout, sent.stderr, LIVE_CHUNK_BYTES);
          }
          if (!snap.running) {
            feed?.emit(sessionKey, { kind: "exec", commandId: runKey, phase: "finished", text: "", exitCode: snap.exitCode, ...(snap.reason === null ? {} : { reason: snap.reason }) });
            stopPoll(runKey);
            announceFinished(runKey);
          }
        } catch {
          // the run is gone or the helper restarted: nothing more to show
          stopPoll(runKey);
          announceFinished(runKey);
        } finally {
          busy = false;
        }
      })();
    }, pollMs);
    timer.unref?.();
    polls.set(runKey, timer);
  }

  return {
    async start({ sessionKey, profileId, command, timeoutMs }) {
      const profile = profiles.get(profileId);
      if (profile === null || profile.protocol !== "ssh" || profile.credentialRef === null) throw new ToolError("needs_saved_credential", "this connection has no saved credential");
      const target = profileToSshTarget(profile);
      let authMethod: "password" | "publickey";
      try {
        authMethod = credentials.authorizeSsh(profile.credentialRef, { protocol: "ssh", host: profile.host.toLowerCase(), port: profile.port ?? 22, user: profile.username, domain: null }, target.identityFile);
      } catch (error) {
        if (error instanceof CredentialError) throw Object.assign(new Error(error.code), { code: error.code });
        throw error;
      }
      const handle = await service.execRun({ ...target, authMethod }, command, profile.credentialRef, timeoutMs, EXEC_KEEP_BYTES);
      const runKey = keyOf(handle);
      livePoll(runKey, sessionKey);
      return { runKey };
    },
    read: async (runKey, stdoutFrom, stderrFrom, max): Promise<ExecSnapshotView> => service.execRead(handleOf(runKey), stdoutFrom, stderrFrom, max),
    cancel: async (runKey): Promise<ExecSnapshotView> => service.execCancel(handleOf(runKey)),
    forget: async (runKey) => service.execForget(handleOf(runKey)),
    onFinished(cb) {
      finishedListeners.add(cb);
      return () => void finishedListeners.delete(cb);
    },
  };
}
