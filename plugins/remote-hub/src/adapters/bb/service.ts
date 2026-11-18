// The Remote Hub backend service: owns the cached HelperProcess, restarts it
// after a crash without replaying any input, and exposes the operations the
// RPC surface wraps. Host-free of the BB SDK (only the adapter), so it is
// unit-testable with an injected startHelper factory.
import { AttachTokens, ATTACH_TOKEN_TTL_MS, type Clock } from "../../core/attach.ts";
import { createCreditState, type CreditState } from "../../core/credit.ts";
import { buildSshSpawn, type SshTarget } from "../../core/ssh-args.ts";
import { HelperProcess, type HelperStatus, HelperRuntimeError, HelperRequestError, type RdpHelperEvent } from "./helper-process.ts";
import type { RdpInfo, RdpTarget, SessionHandle } from "../../core/rpc.ts";
import { parseUpdateChunk, RDP_STATES, type RdpInputEvent } from "../../core/rdp-protocol.ts";
import { createRdpTrustStore, fingerprintEqual, type RdpTrustStore } from "../../core/rdp-trust.ts";
import { RdpViewMux, type ViewEffects } from "../../core/rdp-views.ts";
import type { ScreenshotResult } from "../../core/rdp-screenshot.ts";

export type SessionState = "connecting" | "running" | "closed";

export interface SessionInfo {
  generation: string;
  sessionId: number;
  kind: "echo" | "ssh" | "rdp";
  target?: SshTarget;
  rdp?: RdpInfo;
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
  /** In-memory certificate trust; a fresh store per service when omitted. */
  trust?: RdpTrustStore;
}

/** What a view receives from the service: binary update payloads and JSON events. */
export interface RdpViewSink {
  sendUpdate(payload: Uint8Array): void;
  sendEvent(event: Record<string, unknown>): void;
}

export interface RdpAttachment {
  /** The state to show before any live event: sent first by the socket. */
  initial: Record<string, unknown>;
  ack(frameId: number): void;
  input(events: RdpInputEvent[]): Promise<void>;
  refresh(): void;
  detach(): void;
}

export interface RemoteHubService {
  helperStatus(): Promise<HelperStatus>;
  echoOpen(cols: number, rows: number): Promise<SessionHandle>;
  echoInput(handle: SessionHandle, data: string): Promise<{ output: string; truncated: boolean }>;
  echoClose(handle: SessionHandle): Promise<{ closed: boolean }>;
  sshOpen(target: SshTarget, cols: number, rows: number): Promise<SessionHandle>;
  sshOpenTest(cols: number, rows: number): Promise<SessionHandle>;
  rdpOpen(target: RdpTarget, width: number, height: number): Promise<SessionHandle>;
  rdpCertDecision(handle: SessionHandle, fingerprint: string, accept: "once" | "session_trust" | "reject"): Promise<void>;
  rdpScreenshot(handle: SessionHandle): Promise<ScreenshotResult>;
  rdpAttach(handle: SessionHandle, viewId: string, sink: RdpViewSink): RdpAttachment;
  /** Test/inspection: the runtime view of one RDP session (never holds a password). */
  rdpInfo(handle: SessionHandle): RdpInfo | undefined;
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
  const trust = deps.trust ?? createRdpTrustStore();
  interface RdpRuntime {
    handle: SessionHandle;
    mux: RdpViewMux;
    views: Map<string, RdpViewSink>;
  }
  const rdpRuntimes = new Map<string, RdpRuntime>();
  // Events the helper sends right after `session.opened`, before rdpOpen has
  // registered the session (both are processed in one stdout chunk).
  const earlyRdpEvents = new Map<string, RdpHelperEvent[]>();
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
      rdpRuntimes.delete(key);
      earlyRdpEvents.delete(key);
      sessionEndListeners.delete(key);
      listeners.delete(key);
      credits.delete(key);
    }, EVICT_CLOSED_AFTER_MS);
  };

  const rdpRecord = (key: string): SessionInfo | undefined => {
    const info = sessions.get(key);
    return info !== undefined && info.kind === "rdp" ? info : undefined;
  };

  const broadcast = (runtime: RdpRuntime, event: Record<string, unknown>): void => {
    for (const sink of runtime.views.values()) {
      try {
        sink.sendEvent(event);
      } catch {
        // one view's failure must not skip the others
      }
    }
  };

  /** Apply what the multiplexer asks of the helper (ack, refresh). Best effort:
   *  a failure here means the session is ending and the end path reports it. */
  const applyEffects = (runtime: RdpRuntime, effects: ViewEffects): void => {
    const h = helper;
    if (h === null || h.currentGeneration !== runtime.handle.generation) return;
    if (effects.ackHelper !== null) h.rdpUpdateAck(runtime.handle, effects.ackHelper).catch(() => {});
    if (effects.refresh) {
      const info = rdpRecord(keyOf(runtime.handle));
      // Before the first update the engine paints the whole desktop anyway, and
      // the helper refuses a refresh before desktop_ready.
      if (info?.rdp?.state === "desktop_ready") h.rdpRefresh(runtime.handle).catch(() => {});
    }
  };

  const handleRdpEvent = (generation: string, sessionId: number, event: RdpHelperEvent): void => {
    const key = generation + ":" + sessionId;
    const info = rdpRecord(key);
    const runtime = rdpRuntimes.get(key);
    if (info === undefined || info.rdp === undefined || runtime === undefined) {
      // rdpOpen has not registered the session yet: keep the event for it.
      const queued = earlyRdpEvents.get(key) ?? [];
      queued.push(event);
      earlyRdpEvents.set(key, queued);
      return;
    }
    const rdp = info.rdp;
    switch (event.type) {
      case "rdp.state": {
        if (!(RDP_STATES as readonly string[]).includes(event.state)) return; // e.g. a test engine's paint counter
        if (rdp.state === "closed") return;
        rdp.state = event.state as RdpInfo["state"];
        rdp.trace.push(event.state);
        if (event.state !== "cert_prompt") rdp.prompt = null;
        broadcast(runtime, { type: "state", state: event.state });
        return;
      }
      case "rdp.cert_prompt": {
        const { host, port } = rdp.target;
        if (trust.isTrusted(host, port, event.fingerprint)) {
          // A fingerprint the user trusted for this BB run: accept this handshake once.
          helper?.rdpCertDecision(runtime.handle, event.fingerprint, "once").catch(() => {});
          return;
        }
        // A different certificate on a host:port with a trusted one is never
        // auto-accepted and is reported as a CHANGED certificate.
        const reason = trust.trustedFor(host, port).length > 0 ? "cert_changed" : event.reason;
        rdp.prompt = {
          host: event.host,
          port: event.port,
          fingerprint: event.fingerprint,
          subject: event.subject,
          issuer: event.issuer,
          notBefore: event.notBefore,
          notAfter: event.notAfter,
          reason,
        };
        broadcast(runtime, { type: "cert_prompt", prompt: rdp.prompt });
        return;
      }
      case "rdp.desktop": {
        rdp.desktop = { frameId: event.frameId, width: event.width, height: event.height };
        if (rdp.state !== "closed") {
          rdp.state = "desktop_ready";
          rdp.trace.push("desktop_ready");
          rdp.prompt = null;
        }
        broadcast(runtime, { type: "desktop", frameId: event.frameId, width: event.width, height: event.height });
        broadcast(runtime, { type: "state", state: "desktop_ready" });
        return;
      }
      case "rdp.input_rejected":
        broadcast(runtime, { type: "input_rejected", applied: event.applied, rejected: event.rejected });
        return;
      case "rdp.certificate":
        return; // the pin check happens in the helper; nothing to keep here
    }
  };

  const handleRdpUpdate = (generation: string, sessionId: number, seq: number, payload: Uint8Array): void => {
    const key = generation + ":" + sessionId;
    const runtime = rdpRuntimes.get(key);
    if (runtime === undefined) return;
    const chunk = parseUpdateChunk(payload);
    if (chunk === null) return; // the helper validates every frame already
    const outcome = runtime.mux.onChunk(seq, chunk);
    if (outcome.violation !== undefined) return; // out of step: nothing is delivered, nothing is acked
    for (const viewId of outcome.deliver) {
      try {
        runtime.views.get(viewId)?.sendUpdate(payload);
      } catch {
        // a dead view is removed by its socket's close handler
      }
    }
    applyEffects(runtime, { ackHelper: outcome.ackHelper, refresh: outcome.refresh });
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
              for (const [key, info] of sessions) {
                if (key.startsWith(generation + ":") && info.rdp !== undefined) info.rdp.state = "closed";
              }
              for (const key of Array.from(rdpRuntimes.keys())) {
                if (key.startsWith(generation + ":")) rdpRuntimes.delete(key);
              }
              for (const key of Array.from(earlyRdpEvents.keys())) {
                if (key.startsWith(generation + ":")) earlyRdpEvents.delete(key);
              }
              for (const key of Array.from(sessions.keys())) {
                if (key.startsWith(generation + ":")) maybeEvictClosed(key);
              }
              attachTokens.revokeGeneration(generation);
              for (const cb of helperExitCallbacks) {
                try {
                  cb();
                } catch {
                  // one socket's throw must not skip the others
                }
              }
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
              if (existing.rdp !== undefined) existing.rdp.state = "closed";
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
          started.onRdpEvent((sessionId, event) => handleRdpEvent(generation, sessionId, event));
          started.onRdpUpdate((sessionId, seq, payload) => handleRdpUpdate(generation, sessionId, seq, payload));
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
    async rdpOpen(target, width, height) {
      const hp = await start();
      const handle = await hp.openRdp({
        host: target.host,
        port: target.port,
        username: target.username,
        password: target.password,
        domain: target.domain ?? null,
        width,
        height,
        expectedFingerprint: target.expectedFingerprint ?? null,
      });
      const key = keyOf(handle);
      // The record keeps the endpoint, never the password.
      sessions.set(key, {
        generation: handle.generation,
        sessionId: handle.sessionId,
        kind: "rdp",
        state: "connecting",
        exitCode: null,
        signal: null,
        reason: null,
        rdp: {
          target: { host: target.host, port: target.port, username: target.username, domain: target.domain ?? null },
          state: "connecting",
          prompt: null,
          desktop: null,
          trace: [],
        },
      });
      rdpRuntimes.set(key, { handle, mux: new RdpViewMux(), views: new Map() });
      const early = earlyRdpEvents.get(key);
      earlyRdpEvents.delete(key);
      for (const event of early ?? []) handleRdpEvent(handle.generation, handle.sessionId, event);
      return handle;
    },
    async rdpCertDecision(handle, fingerprint, accept) {
      requireGeneration(handle);
      const info = rdpRecord(keyOf(handle));
      const prompt = info?.rdp?.prompt ?? null;
      if (prompt === null) throw new HelperRequestError("no_pending_prompt", "no certificate decision is pending");
      // The decision must name the certificate that was presented.
      if (!fingerprintEqual(prompt.fingerprint, fingerprint)) {
        throw new HelperRequestError("fingerprint_mismatch", "the decision names a different certificate than the one presented");
      }
      const hp = await start();
      await hp.rdpCertDecision(handle, prompt.fingerprint, accept);
      if (accept === "session_trust") trust.trust(prompt.host, prompt.port, prompt.fingerprint);
      if (info?.rdp !== undefined) info.rdp.prompt = null;
    },
    async rdpScreenshot(handle) {
      requireGeneration(handle);
      const hp = await start();
      return hp.rdpScreenshot(handle);
    },
    rdpInfo(handle) {
      return rdpRecord(keyOf(handle))?.rdp;
    },
    rdpAttach(handle, viewId, sink) {
      requireGeneration(handle);
      const key = keyOf(handle);
      const runtime = rdpRuntimes.get(key);
      const info = rdpRecord(key);
      if (runtime === undefined || info?.rdp === undefined) throw new HelperRuntimeError("session_not_found", "unknown rdp session");
      runtime.views.set(viewId, sink);
      applyEffects(runtime, { ackHelper: null, refresh: runtime.mux.attach(viewId).refresh });
      const rdp = info.rdp;
      return {
        initial: { type: "attached", state: rdp.state, prompt: rdp.prompt, desktop: rdp.desktop, target: rdp.target },
        ack(frameId) {
          applyEffects(runtime, runtime.mux.onViewAck(viewId, frameId));
        },
        async input(events) {
          if (info.rdp?.state !== "desktop_ready") throw new HelperRequestError("not_ready", "the desktop is not ready yet");
          const hp = await start();
          await hp.rdpInput(handle, events);
        },
        refresh() {
          // Resynchronise this view only: it becomes needsFull and the next full update reaches it.
          applyEffects(runtime, { ackHelper: null, refresh: runtime.mux.resync(viewId).refresh });
        },
        detach() {
          runtime.views.delete(viewId);
          applyEffects(runtime, runtime.mux.detach(viewId));
        },
      };
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
      // An explicit close of a session that had already ended (the helper still
      // answers it) must not announce the end a second time.
      const alreadyEnded = existing?.state === "closed";
      if (existing !== undefined && !alreadyEnded) {
        existing.state = "closed";
        existing.exitCode = info.exitCode;
        existing.signal = info.signal;
        existing.reason = info.reason;
        if (existing.rdp !== undefined) existing.rdp.state = "closed";
      }
      const ends = alreadyEnded ? undefined : sessionEndListeners.get(key);
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
