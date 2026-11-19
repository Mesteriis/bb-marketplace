// The Remote Hub backend service: owns the cached HelperProcess, restarts it
// after a crash without replaying any input, and exposes the operations the
// RPC surface wraps. Host-free of the BB SDK (only the adapter), so it is
// unit-testable with an injected startHelper factory.
import type { ExecStateMessage } from "../../core/exec-protocol.ts";
import { AttachTokens, ATTACH_TOKEN_TTL_MS, type Clock } from "../../core/attach.ts";
import { createCreditState, type CreditState } from "../../core/credit.ts";
import { CredentialError, type CredentialBind, type CredentialVault } from "../../core/credential.ts";
import type { PveConnect, PveConsoleTarget, PveSteps } from "../../core/pve-protocol.ts";
import { consoleStateOf, endStateOf, reasonText, VncRelay, type PveConsoleInfo, type VncAttachRefusal } from "../../core/pve-console.ts";
import type { PveAnswer, PveProvisionAnswer } from "../../core/pve-targets.ts";
import type { SshAskpassEvent } from "../../core/ssh-askpass-protocol.ts";
import type { RdpOptions } from "../../core/rdp-options.ts";
import type { KnownHostsOverlay } from "../../core/import-book.ts";
import { buildSshExecSpawn, buildSshSpawn, type SshTarget } from "../../core/ssh-args.ts";
import { HelperProcess, type HelperStatus, HelperRuntimeError, HelperRequestError, PveRequestFailure, type PveSessionEvent, type RdpHelperEvent } from "./helper-process.ts";
import type { RdpInfo, RdpTarget, SessionHandle } from "../../core/rpc.ts";
import { parseUpdateChunk, RDP_STATES, type RdpInputEvent } from "../../core/rdp-protocol.ts";
import type { RdpDecision } from "../../core/rpc.ts";
import { createRdpTrustStore, fingerprintEqual, type RdpTrustStore, type TrustedRdpCert } from "../../core/rdp-trust.ts";
import { RdpViewMux, type ViewEffects } from "../../core/rdp-views.ts";
import type { ScreenshotResult } from "../../core/rdp-screenshot.ts";
import type { ScrollbackRead } from "../../core/scrollback.ts";

export type SessionState = "connecting" | "running" | "closed";

export interface SessionInfo {
  generation: string;
  sessionId: number;
  kind: "echo" | "ssh" | "rdp" | "pve" | "vnc";
  target?: SshTarget;
  rdp?: RdpInfo;
  /** A Proxmox console (a terminal `pve` or a graphical `vnc` one): what it is for, its state and why it failed. Never a secret. */
  pve?: PveConsoleInfo;
  /** The saved profile this session was opened from. */
  profileId?: string;
  state: SessionState;
  exitCode: number | null;
  signal: number | null;
  reason: string | null;
}

/** Who drives a session, as the view shows it. */
export interface ControlView {
  owner: "human" | "agent";
  /** When an agent's lease runs out (epoch ms); null while the human drives. */
  expiresAt: number | null;
}

/** Decides whether the human's input is forwarded (stage 4b-1): not while an agent holds the session's lease. */
export interface ControlGate {
  humanMayDrive(handle: SessionHandle): boolean;
  /** "human", or `agent:<leaseId>`: the tag the helper holds for the session's driver. */
  ownerTag(handle: SessionHandle): string;
  /** Called after the driver of any session changed. */
  onChange(cb: (handle: SessionHandle) => void): void;
  state(handle: SessionHandle): ControlView;
  /** Called after the owner of this session changes. */
  subscribe(handle: SessionHandle, cb: (view: ControlView) => void): () => void;
}

export interface RemoteHubServiceDeps {
  /** Who may drive; without it the human always may. */
  control?: ControlGate;
  startHelper: () => Promise<HelperProcess>;
  env?: Record<string, string | undefined>;
  clock?: Clock;
  /** Test-only opener for a raw spawn spec (used by the integration suite against a test-hooks helper). */
  openSshRaw?: (helper: HelperProcess, cols: number, rows: number) => Promise<SessionHandle>;
  /** Fill the scrollback with no view attached (default true). Tests of the attach-time credit await turn it off. */
  headlessDrain?: boolean;
  /** In-memory certificate trust; a fresh store per service when omitted. */
  trust?: RdpTrustStore;
  /** A Proxmox console nobody is looking at and no agent drives is closed after this long (default 5 minutes). */
  consoleIdleMs?: number;
  /** How many bytes a graphical console may hold for a view that has not attached yet (default 256 KiB). */
  vncBufferBytes?: number;
}

/** What the socket gives a graphical console's one view. */
export interface VncViewSocket {
  sendData(bytes: Uint8Array): void;
  sendPassword(password: string): void;
}

export interface VncAttachment {
  /** The view's keys and mouse, raw RFB. False when an agent holds the session. */
  input(bytes: Uint8Array): Promise<boolean>;
  detach(): void;
  /** The view cannot go on (too slow, failed to start): the console is closed with this reason. A stream is never thinned out. */
  fail(reason: "viewer_too_slow" | "viewer_failed"): void;
}

export interface PveConsoleEvent {
  state: PveConsoleInfo["state"];
  reason: PveConsoleInfo["reason"];
}

export interface PveOpenArgs {
  connect: PveConnect;
  target: PveConsoleTarget;
  cols: number;
  rows: number;
  profileId: string;
  connectionName: string;
  guestName: string | null;
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
  /** False when the events were dropped because an agent holds the session. */
  input(events: RdpInputEvent[]): Promise<boolean>;
  refresh(): void;
  detach(): void;
}

export interface RemoteHubService {
  helperStatus(): Promise<HelperStatus>;
  echoOpen(cols: number, rows: number): Promise<SessionHandle>;
  echoInput(handle: SessionHandle, data: string): Promise<{ output: string; truncated: boolean }>;
  echoClose(handle: SessionHandle): Promise<{ closed: boolean }>;
  sshOpen(target: SshTarget, cols: number, rows: number, profileId?: string, askpass?: { credentialRef: string }): Promise<SessionHandle>;
  /** Runs ONE remote command (ssh without a pty) with a saved credential. Returns the run's helper id. */
  execRun(target: SshTarget, command: string, credentialRef: string, timeoutMs: number, maxBytes: number): Promise<ExecHandle>;
  execRead(handle: ExecHandle, stdoutFrom: number, stderrFrom: number, max: number): Promise<ExecSnapshot>;
  execCancel(handle: ExecHandle): Promise<ExecSnapshot>;
  execForget(handle: ExecHandle): Promise<void>;
  /** A run ended (the helper says so unasked). */
  onExecFinished(cb: (event: { handle: ExecHandle; exitCode: number | null; signal: number | null; reason: string; refused: string | null }) => void): () => void;
  /** Askpass events of an SSH session: open prompts and what happened to a saved credential. Replays what is open. */
  subscribeSshAskpass(handle: SessionHandle, cb: (event: SshAskpassEvent) => void): () => void;
  /** The user's answer to a prompt (null = cancelled). Passed to the helper once and never kept here. */
  sshPromptAnswer(handle: SessionHandle, promptId: number, answer: string | null): Promise<void>;
  sshOpenTest(cols: number, rows: number): Promise<SessionHandle>;
  rdpOpen(target: RdpTarget, width: number, height: number, profileId?: string, options?: RdpOptions): Promise<SessionHandle>;
  rdpCertDecision(handle: SessionHandle, fingerprint: string, accept: RdpDecision): Promise<void>;
  /** Certificates trusted for good (stage 3c-2). */
  rdpTrustedList(): TrustedRdpCert[];
  rdpTrustedForget(host: string, port: number, fingerprint: string): boolean;
  rdpScreenshot(handle: SessionHandle): Promise<ScreenshotResult>;
  rdpAttach(handle: SessionHandle, viewId: string, sink: RdpViewSink): RdpAttachment;
  /** Test/inspection: the runtime view of one RDP session (never holds a password). */
  rdpInfo(handle: SessionHandle): RdpInfo | undefined;
  /** Opens a Proxmox console: a terminal session (node, LXC) or a graphical one (QEMU). The record carries no secret. */
  pveOpen(args: PveOpenArgs): Promise<{ handle: SessionHandle; kind: "pve" | "vnc" }>;
  /** State and failure reason of a Proxmox console, replayed on subscribe. */
  subscribePveConsole(handle: SessionHandle, cb: (event: PveConsoleEvent) => void): () => void;
  /** The one view of a graphical console. Refused for a second view and for any view after the first one left (an RFB stream cannot be resumed). */
  vncAttach(handle: SessionHandle, view: VncViewSocket): { ok: true; attachment: VncAttachment } | { ok: false; code: VncAttachRefusal };
  /** Proxmox VE: discovery and onboarding, through the helper. A refusal is an answer with a code, never a thrown secret. */
  pve: {
    targets(connect: PveConnect): Promise<PveAnswer>;
    provision(args: {
      connect: PveConnect;
      dryRun: boolean;
      aclPath: string;
      userId: string;
      replaceRole?: boolean;
      planDigest?: string;
      save?: Array<{ ref: string; bind: CredentialBind }>;
    }): Promise<PveProvisionAnswer>;
  };
  /** The Keychain, through the helper. A refusal is a CredentialError carrying the helper's code. */
  credentialVault: CredentialVault;
  /** The owner's "Allow access" for one saved credential (a macOS dialog may appear). A refusal is a CredentialError with the helper's code. */
  credentialAllow(ref: string): Promise<void>;
  /** The helper-owned known_hosts overlay (saved-secret SSH sessions trust what is in it). */
  knownHosts: KnownHostsOverlay;
  sessionList(): SessionInfo[];
  sessionClose(handle: SessionHandle): Promise<{ exitCode: number | null; signal: number | null; reason: string }>;
  sessionAttach(handle: SessionHandle): string;
  consumeAttachToken(token: string): { sessionId: number; generation: string } | null;
  sessionScrollback(handle: SessionHandle): Promise<Uint8Array>;
  /** Terminal output of a session from a read position (null = the newest bytes). Null when the helper is not running. */
  sessionRead(handle: SessionHandle, from: number | null, max: number): ScrollbackRead | null;
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
  /** The human's keys. False when they were dropped because an agent holds the session. */
  sessionTerminalInput(handle: SessionHandle, data: Uint8Array): Promise<boolean>;
  /** An agent holding the lease types; `owner` is its lease tag. Refused (lease_lost) once that lease is not the driver. */
  agentTerminalInput(handle: SessionHandle, data: Uint8Array, owner: string): Promise<void>;
  /** An agent holding the lease sends desktop input. */
  agentRdpInput(handle: SessionHandle, events: RdpInputEvent[], owner: string): Promise<void>;
  controlState(handle: SessionHandle): ControlView;
  subscribeControl(handle: SessionHandle, cb: (view: ControlView) => void): () => void;
  /** May an agent drive this session (Z1)? See AgentSessionView.control. */
  agentControl(handle: SessionHandle): "ready" | "pending" | "never";
  /** The kinds of question the owner has to answer on this session: no text, no fingerprint. */
  ownerQuestions(handle: SessionHandle): Array<"host_key" | "certificate" | "login_prompt">;
  /** The SSH questions waiting for the owner, with their text (for the owner's page only; never given to an agent). */
  sshPendingPrompts(handle: SessionHandle): Array<{ promptId: number; text: string; kind: string }>;
  sessionResize(handle: SessionHandle, cols: number, rows: number): Promise<void>;
  sessionCredit(handle: SessionHandle, bytes: number): Promise<void>;
  onHelperExit(cb: () => void): () => void;
  stop(): void;
}

/** A remote command run: the helper generation and the run's id (the same id space as sessions). */
export interface ExecHandle {
  generation: string;
  execId: number;
}

export interface ExecStream {
  start: number;
  end: number;
  data: Uint8Array;
  total: number;
  truncated: boolean;
}

export interface ExecSnapshot {
  running: boolean;
  exitCode: number | null;
  signal: number | null;
  reason: string | null;
  refused: string | null;
  elapsedMs: number;
  stdout: ExecStream;
  stderr: ExecStream;
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
  // Per SSH session: the prompts still waiting for the user, the last notice about a saved
  // credential, and the sockets listening. Holds prompt TEXT only, never an answer or a secret.
  interface AskpassState {
    prompts: Map<number, Extract<SshAskpassEvent, { type: "prompt" }>>;
    notice: Exclude<SshAskpassEvent, { type: "prompt" | "prompt_expired" | "credential_used" | "connected" }> | null;
    /** The helper handed the saved credential to ssh; the saved credential was then refused or could not be read. */
    used: boolean;
    /** OpenSSH ran LocalCommand: the server accepted the login. Only this makes a session ready for an agent. */
    connected: boolean;
    failed: boolean;
    listeners: Set<(event: SshAskpassEvent) => void>;
  }
  const askpassStates = new Map<string, AskpassState>();
  // SSH sessions opened through the saved-secret path (askpass forced): the only terminals where no question can appear.
  const brokered = new Set<string>();
  // The driver of a session (Z2). Every change is sent to the helper, which drops what the previous driver had queued and
  // releases what it left down; the answer is the barrier, and every write waits for it and then checks who drives NOW.
  const handoffs = new Map<string, Promise<unknown>>();
  /** The driver tag the helper has acknowledged; a write whose gate tag differs re-sends it first (A4). */
  const appliedOwner = new Map<string, string>();
  /** The last driver tag SCHEDULED for the helper: a change is queued with the tag it had when it happened. */
  const queuedOwner = new Map<string, string>();
  /**
   * The earliest change of driver the helper has NOT confirmed (fail closed). While one is outstanding no input is accepted
   * for the session, and no later change is sent as if it had been applied: the outstanding one is retried first.
   */
  const unconfirmedOwner = new Map<string, string>();
  /** True when the helper confirmed `want`; false when it could not be (kept as unconfirmed); true also when the session is gone. */
  const sendOwner = async (handle: SessionHandle, want: string): Promise<boolean> => {
    const key = keyOf(handle);
    for (let attempt = 0; attempt < 3; attempt++) {
      if ((appliedOwner.get(key) ?? "human") === want && unconfirmedOwner.get(key) !== want) return true;
      try {
        await (await start()).sessionSetOwner(handle, want);
        appliedOwner.set(key, want);
        return true;
      } catch (error) {
        const gone = error instanceof HelperRequestError && (error.code === "unknown_session" || error.code === "session_not_found");
        if (gone || helper === null || !sessions.has(key) || sessions.get(key)?.state === "closed") {
          unconfirmedOwner.delete(key);
          return true;
        }
        await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
      }
    }
    return false;
  };
  const syncOwner = async (handle: SessionHandle, want: string): Promise<void> => {
    const key = keyOf(handle);
    if (deps.control === undefined) return;
    const earlier = unconfirmedOwner.get(key);
    if (earlier !== undefined && earlier !== want) {
      if (!(await sendOwner(handle, earlier))) return; // still not confirmed: nothing later is sent as if it were
      unconfirmedOwner.delete(key);
    }
    if (await sendOwner(handle, want)) unconfirmedOwner.delete(key);
    else unconfirmedOwner.set(key, want);
  };
  /**
   * Schedules a change of driver for the helper. Changes are sent in the order they happened, each with the tag it had THEN
   * (never "whatever the tag is by the time the helper is free"): a watcher that leaves and returns before the helper has
   * answered must still make the helper see the suspension (which flushes what was queued and releases held keys) and then
   * the resume. `force` re-sends after a failure.
   */
  const queueSync = (handle: SessionHandle, force = false): void => {
    const key = keyOf(handle);
    const gate = deps.control;
    if (gate === undefined) return;
    const want = gate.ownerTag(handle);
    if (!force && (queuedOwner.get(key) ?? appliedOwner.get(key) ?? "human") === want) return;
    queuedOwner.set(key, want);
    const next = (handoffs.get(key) ?? Promise.resolve()).then(() => syncOwner(handle, want));
    handoffs.set(key, next);
    void next.finally(() => {
      if (handoffs.get(key) === next) handoffs.delete(key);
    });
  };
  const handoff = async (handle: SessionHandle): Promise<void> => {
    await handoffs.get(keyOf(handle));
    const key = keyOf(handle);
    if (deps.control !== undefined && ((appliedOwner.get(key) ?? "human") !== deps.control.ownerTag(handle) || unconfirmedOwner.has(key))) {
      queueSync(handle, true);
      await handoffs.get(key);
    }
  };
  /** Input is refused while a change of driver is unconfirmed (the helper may still be applying the previous driver). */
  const ownerUnconfirmed = (handle: SessionHandle): boolean => unconfirmedOwner.has(keyOf(handle));
  const lostLease = () => new HelperRequestError("lease_lost", "this input belongs to a lease that is no longer the session's driver");
  const askpassState = (key: string): AskpassState => {
    let state = askpassStates.get(key);
    if (state === undefined) {
      state = { prompts: new Map(), notice: null, used: false, connected: false, failed: false, listeners: new Set() };
      askpassStates.set(key, state);
    }
    return state;
  };
  const handleSshAskpass = (generation: string, sessionId: number, event: SshAskpassEvent): void => {
    const state = askpassState(generation + ":" + sessionId);
    if (event.type === "connected") {
      state.connected = true;
      return;
    }
    if (event.type === "credential_used") {
      // A fact for the service (agent control), not something the page shows.
      state.used = true;
      return;
    }
    if (event.type === "credential_rejected" || event.type === "credential_failed") state.failed = true;
    if (event.type === "prompt") state.prompts.set(event.promptId, event);
    else if (event.type === "prompt_expired") state.prompts.delete(event.promptId);
    else state.notice = event;
    for (const cb of state.listeners) {
      try {
        cb(event);
      } catch {
        // one socket's throw must not skip the others
      }
    }
  };
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
  // The first update chunks of a session the service has not registered yet. The
  // helper keeps ONE update in flight, so this is at most one frame (up to
  // 3840x2160 RGBA, about 33 MiB); the bound below allows that and no more.
  const earlyRdpUpdates = new Map<string, Array<{ seq: number; payload: Uint8Array }>>();
  const EARLY_UPDATE_BYTES_MAX = 48 * 1024 * 1024;
  const earlyUpdateBytes = new Map<string, number>();
  // A session that ended before its open call continued (any kind): applied when
  // the record is created, so an ended session is never shown as live.
  const earlyClosed = new Map<string, { exitCode: number | null; signal: number | null; reason: string }>();
  // Proxmox consoles: events and raw bytes that arrive before the open call registered the record are kept like the above.
  const earlyPveEvents = new Map<string, PveSessionEvent[]>();
  const earlyVncData = new Map<string, Uint8Array[]>();
  const EARLY_VNC_BYTES_MAX = 1024 * 1024;
  const earlyVncBytes = new Map<string, number>();
  const consoleListeners = new Map<string, Set<(event: PveConsoleEvent) => void>>();
  const vncRelays = new Map<string, VncRelay>();
  // Views attached to a Proxmox console, and the idle timers that close one nobody looks at (no view, no agent lease).
  const viewCounts = new Map<string, number>();
  const idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const CONSOLE_IDLE_MS = deps.consoleIdleMs ?? 5 * 60 * 1000;
  // Opens in flight. Everything that arrives for a session id with no record is
  // kept ONLY while an open is waiting (it can belong to it), never evicted while
  // that open is pending, and dropped when no open is pending any more. The number
  // of opens in flight is bounded at issuance instead of dropping an awaited close.
  const MAX_PENDING_OPENS = 64;
  let pendingOpens = 0;
  const beginOpen = (): void => {
    if (pendingOpens >= MAX_PENDING_OPENS) {
      throw new Error("too many sessions are being opened at once (" + MAX_PENDING_OPENS + "); try again in a moment");
    }
    pendingOpens += 1;
  };
  const endOpen = (): void => {
    pendingOpens -= 1;
    if (pendingOpens === 0) {
      earlyRdpEvents.clear();
      earlyRdpUpdates.clear();
      earlyUpdateBytes.clear();
      earlyClosed.clear();
      earlyPveEvents.clear();
      earlyVncData.clear();
      earlyVncBytes.clear();
    }
  };
  const execFinishedListeners = new Set<(event: { handle: ExecHandle; exitCode: number | null; signal: number | null; reason: string; refused: string | null }) => void>();
  const execHelper = async (handle: ExecHandle): Promise<HelperProcess> => {
    const hp = await start();
    if (handle.generation !== hp.currentGeneration) throw new HelperRuntimeError("session_not_found", "this command belongs to a different helper generation");
    return hp;
  };
  const toSnapshot = (m: ExecStateMessage): ExecSnapshot => {
    const stream = (c: ExecStateMessage["stdout"]): ExecStream => ({ start: c.start, end: c.end, data: Uint8Array.from(Buffer.from(c.data, "base64")), total: c.total, truncated: c.truncated });
    return { running: m.running, exitCode: m.exitCode, signal: m.signal, reason: m.reason, refused: m.refused, elapsedMs: m.elapsedMs, stdout: stream(m.stdout), stderr: stream(m.stderr) };
  };
  const tracked =
    <A extends unknown[], R>(open: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      beginOpen();
      try {
        return await open(...args);
      } finally {
        endOpen();
      }
    };
  /** Runs a Keychain request on the helper; the helper's error code becomes a CredentialError. */
  const viaVault = async <T>(run: (hp: HelperProcess) => Promise<T>): Promise<T> => {
    const hp = await start();
    try {
      return await run(hp);
    } catch (error) {
      if (error instanceof HelperRequestError) throw new CredentialError(error.code, error.code);
      throw error;
    }
  };
  /** A failed PVE request as an answer: the helper's closed code and the certificate it saw. Anything else is not ours to hide. */
  const pveFailure = (error: unknown): { ok: false; code: string; message: string; fingerprint: string | null; steps: PveSteps | null } => {
    if (error instanceof PveRequestFailure) return { ok: false, code: error.code, message: error.message, fingerprint: error.fingerprint, steps: error.steps };
    if (error instanceof HelperRequestError) return { ok: false, code: error.code, message: error.message, fingerprint: null, steps: null };
    throw error;
  };
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
      appliedOwner.delete(key);
      handoffs.delete(key);
      queuedOwner.delete(key);
      unconfirmedOwner.delete(key);
      consoleListeners.delete(key);
      vncRelays.delete(key);
      viewCounts.delete(key);
      clearIdle(key);
    }, EVICT_CLOSED_AFTER_MS);
  };

  /** Apply a close that was announced before the record existed. */
  const applyEarlyClosed = (key: string): void => {
    const info = earlyClosed.get(key);
    const record = sessions.get(key);
    if (info === undefined || record === undefined) return;
    earlyClosed.delete(key);
    record.state = "closed";
    record.exitCode = info.exitCode;
    record.signal = info.signal;
    record.reason = info.reason;
    if (record.rdp !== undefined) record.rdp.state = "closed";
    finishConsole(key, info.reason);
    maybeEvictClosed(key);
  };

  const rdpRecord = (key: string): SessionInfo | undefined => {
    const info = sessions.get(key);
    return info !== undefined && info.kind === "rdp" ? info : undefined;
  };

  const notifyConsole = (key: string): void => {
    const info = sessions.get(key);
    if (info?.pve === undefined) return;
    const event: PveConsoleEvent = { state: info.pve.state, reason: info.pve.reason };
    for (const cb of [...(consoleListeners.get(key) ?? [])]) {
      try {
        cb(event);
      } catch {
        // one listener's throw must not skip the others
      }
    }
  };

  /** A console ended (by the owner, by the other side, by the helper going away): its final state and reason, and nothing kept. */
  const finishConsole = (key: string, reason: string): void => {
    const info = sessions.get(key);
    if (info?.pve === undefined) return;
    clearIdle(key);
    vncRelays.get(key)?.dispose();
    vncRelays.delete(key);
    if (info.pve.state !== "error") {
      info.pve.state = endStateOf(reason);
      info.pve.reason = info.pve.state === "lost" || reason === "idle_timeout" || reason === "view_closed" ? { code: reason, text: reasonText(reason), fingerprint: null } : null;
    }
    notifyConsole(key);
  };

  const handlePveEvent = (generation: string, sessionId: number, event: PveSessionEvent): void => {
    const key = generation + ":" + sessionId;
    const info = sessions.get(key);
    if (info === undefined || info.pve === undefined) {
      if (pendingOpens > 0) {
        const list = earlyPveEvents.get(key) ?? [];
        list.push(event);
        earlyPveEvents.set(key, list);
      }
      return;
    }
    if (info.state === "closed") return;
    if (event.type === "state") {
      if (info.pve.state === "error") return;
      info.pve.state = consoleStateOf(event.state);
      if (event.state === "open") info.state = "running";
      notifyConsole(key);
    } else if (event.type === "error") {
      info.pve.state = "error";
      info.pve.reason = { code: event.code, text: reasonText(event.code), fingerprint: event.fingerprint };
      notifyConsole(key);
    } else {
      vncRelays.get(key)?.setPassword(event.password);
    }
  };

  const handleVncData = (generation: string, sessionId: number, data: Uint8Array): void => {
    const key = generation + ":" + sessionId;
    const relay = vncRelays.get(key);
    if (relay === undefined) {
      if (pendingOpens === 0) return;
      const bytes = (earlyVncBytes.get(key) ?? 0) + data.byteLength;
      if (bytes > EARLY_VNC_BYTES_MAX) return;
      earlyVncBytes.set(key, bytes);
      earlyVncData.set(key, [...(earlyVncData.get(key) ?? []), data]);
      return;
    }
    if (relay.push(data) === "overflow") {
      const info = sessions.get(key);
      if (info !== undefined) void closeSession({ generation: info.generation, sessionId: info.sessionId }, "vnc_buffer_overflow").catch(() => {});
    }
  };

  const consoleIdle = (key: string): boolean => {
    const info = sessions.get(key);
    if (info?.pve === undefined || info.state === "closed") return false;
    if ((viewCounts.get(key) ?? 0) > 0) return false;
    return deps.control?.state({ generation: info.generation, sessionId: info.sessionId }).owner !== "agent";
  };
  function clearIdle(key: string): void {
    const timer = idleTimers.get(key);
    if (timer !== undefined) clearTimeout(timer);
    idleTimers.delete(key);
  }
  /** (Re)evaluates whether a console is idle: starts the timer once it is, stops it as soon as a view or an agent has it. */
  const refreshIdle = (key: string): void => {
    if (!consoleIdle(key)) {
      clearIdle(key);
      return;
    }
    if (idleTimers.has(key)) return;
    const timer = setTimeout(() => {
      idleTimers.delete(key);
      const info = sessions.get(key);
      if (info === undefined || !consoleIdle(key)) return;
      void closeSession({ generation: info.generation, sessionId: info.sessionId }, "idle_timeout").catch(() => {});
    }, CONSOLE_IDLE_MS);
    timer.unref?.();
    idleTimers.set(key, timer);
  };
  const viewAttached = (key: string): void => {
    viewCounts.set(key, (viewCounts.get(key) ?? 0) + 1);
    refreshIdle(key);
  };
  const viewDetached = (key: string): void => {
    viewCounts.set(key, Math.max(0, (viewCounts.get(key) ?? 0) - 1));
    refreshIdle(key);
  };

  const closeSession = async (handle: SessionHandle, reasonOverride?: string): Promise<{ exitCode: number | null; signal: number | null; reason: string }> => {
    requireGeneration(handle);
    const process = await start();
    const helperInfo = await process.close(handle);
    const info = reasonOverride === undefined ? helperInfo : { ...helperInfo, reason: reasonOverride };
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
      finishConsole(key, info.reason);
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
    if (info !== undefined && info.state === "closed") return; // nothing follows the end
    if (info === undefined || info.rdp === undefined || runtime === undefined) {
      // rdpOpen has not registered the session yet: keep the event for it (only
      // while some open is waiting; otherwise nobody can claim it).
      if (pendingOpens === 0) return;
      const queued = earlyRdpEvents.get(key) ?? [];
      queued.push(event);
      earlyRdpEvents.set(key, queued);
      return;
    }
    const rdp = info.rdp;
    switch (event.type) {
      case "rdp.state": {
        if (event.state.startsWith("stats ")) {
          // Picture-completeness counters (numbers only): one line, replaced as it changes, so the trace stays short.
          const line = /^stats( [a-z_]+=\d{1,20}){9}$/.test(event.state) ? event.state : null;
          if (line !== null) {
            const at = rdp.trace.findIndex((t) => t.startsWith("stats "));
            if (at >= 0) rdp.trace[at] = line;
            else rdp.trace.push(line);
          }
          return;
        }
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
        // A first-use prompt is never answered for the user: accepting it pins a saved password to the certificate.
        if (event.firstUse !== true && trust.isTrusted(host, port, event.fingerprint)) {
          // A fingerprint the user trusted for this BB run: accept this handshake once.
          helper?.rdpCertDecision(runtime.handle, event.fingerprint, "once").catch(() => {});
          return;
        }
        // A different certificate on a host:port with a trusted one is never
        // auto-accepted and is reported as a CHANGED certificate.
        const reason = !trust.isTrusted(host, port, event.fingerprint) && trust.trustedFor(host, port).length > 0 ? "cert_changed" : event.reason;
        rdp.prompt = {
          host: event.host,
          port: event.port,
          fingerprint: event.fingerprint,
          subject: event.subject,
          issuer: event.issuer,
          notBefore: event.notBefore,
          notAfter: event.notAfter,
          reason,
          ...(event.firstUse === true ? { firstUse: true } : {}),
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
    if (runtime === undefined) {
      // Not registered yet (rdpOpen has not continued): keep the chunk, bounded,
      // so the helper is acked once the multiplexer sees it.
      if (sessions.has(key) || pendingOpens === 0) return; // known and ended, or nobody is opening
      const used = earlyUpdateBytes.get(key) ?? 0;
      if (used + payload.byteLength > EARLY_UPDATE_BYTES_MAX) return;
      earlyUpdateBytes.set(key, used + payload.byteLength);
      const queued = earlyRdpUpdates.get(key) ?? [];
      queued.push({ seq, payload });
      earlyRdpUpdates.set(key, queued);
      return;
    }
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

  // Agents read the scrollback with no view attached, so output must flow without one: grant the first window now.
  const startDrain = async (hp: HelperProcess, handle: SessionHandle): Promise<void> => {
    if (deps.headlessDrain === false) return;
    const key = keyOf(handle);
    let state = credits.get(key);
    if (state === undefined) {
      state = createCreditState();
      credits.set(key, state);
    }
    const grant = state.startDrain();
    if (grant > 0) await hp.credit(handle, grant).catch(() => {});
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
                  finishConsole(generation + ":" + info.sessionId, "helper_exited");
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
              finishConsole(key, info.reason);
            } else {
              // Closed before the open call that will create the record continued.
              if (pendingOpens > 0) earlyClosed.set(key, info);
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
            askpassStates.delete(key); // nothing can be answered for an ended session
            maybeEvictClosed(key);
          });
          started.onRdpEvent((sessionId, event) => handleRdpEvent(generation, sessionId, event));
          started.onPveEvent((sessionId, event) => handlePveEvent(generation, sessionId, event));
          started.onVncData((sessionId, data) => handleVncData(generation, sessionId, data));
          started.onSshAskpass((sessionId, event) => handleSshAskpass(generation, sessionId, event));
          started.onExecFinished((e) => {
            for (const cb of [...execFinishedListeners]) {
              try {
                cb({ handle: { generation, execId: e.execId }, exitCode: e.exitCode, signal: e.signal, reason: e.reason, refused: e.refused });
              } catch {
                // one listener's throw must not skip the others
              }
            }
          });
          started.onRdpUpdate((sessionId, seq, payload) => handleRdpUpdate(generation, sessionId, seq, payload));
          started.onSessionOutput((sessionId, data) => {
            const back = credits.get(generation + ":" + sessionId)?.onConsumed(data.byteLength) ?? 0;
            // No view attached: the scrollback is the only reader, so keep the helper's window full.
            if (back > 0) started.credit({ generation, sessionId } as SessionHandle, back).catch(() => {});
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

  if (deps.control !== undefined) {
    const gate = deps.control;
    gate.onChange((handle) => {
      refreshIdle(keyOf(handle));
      if (helper === null) return;
      queueSync(handle);
    });
  }

  return {
    async helperStatus() {
      const process = await start();
      const alive = await process.pingAlive();
      return { ...process.status!, alive };
    },
    echoOpen: tracked(async (cols, rows) => {
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
      applyEarlyClosed(keyOf(handle));
      return handle;
    }),
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
    sshOpenTest: tracked(async (cols, rows) => {
      if (deps.openSshRaw === undefined) throw new Error("sshOpenTest requires a test opener");
      const hp = await start();
      const handle = await deps.openSshRaw(hp, cols, rows);
      await startDrain(hp, handle);
      sessions.set(keyOf(handle), {
        generation: handle.generation,
        sessionId: handle.sessionId,
        kind: "ssh",
        state: "running",
        exitCode: null,
        signal: null,
        reason: null,
      });
      applyEarlyClosed(keyOf(handle));
      return handle;
    }),
    async execRun(target, command, credentialRef, timeoutMs, maxBytes) {
      const hp = await start();
      const spec = buildSshExecSpawn({ ...target }, command, deps.env ?? process.env);
      const execId = await hp.execRun(spec, { credentialRef }, timeoutMs, maxBytes);
      return { generation: hp.currentGeneration, execId };
    },
    async execRead(handle, stdoutFrom, stderrFrom, max) {
      const hp = await execHelper(handle);
      return toSnapshot(await hp.execRead(handle.execId, stdoutFrom, stderrFrom, max));
    },
    async execCancel(handle) {
      const hp = await execHelper(handle);
      return toSnapshot(await hp.execCancel(handle.execId));
    },
    async execForget(handle) {
      const hp = await execHelper(handle);
      await hp.execForget(handle.execId);
    },
    onExecFinished(cb) {
      execFinishedListeners.add(cb);
      return () => void execFinishedListeners.delete(cb);
    },
    sshOpen: tracked(async (target, cols, rows, profileId, askpass) => {
      const hp = await start();
      const spec = buildSshSpawn(target, deps.env ?? process.env);
      const handle = await hp.openSsh(spec, cols, rows, askpass);
      await startDrain(hp, handle);
      if (askpass !== undefined) brokered.add(keyOf(handle));
      sessions.set(keyOf(handle), {
        generation: handle.generation,
        sessionId: handle.sessionId,
        kind: "ssh",
        target,
        state: "running",
        exitCode: null,
        signal: null,
        reason: null,
        ...(profileId === undefined ? {} : { profileId }),
      });
      applyEarlyClosed(keyOf(handle));
      return handle;
    }),
    rdpOpen: tracked(async (target, width, height, profileId, options) => {
      const hp = await start();
      const handle = await hp.openRdp({
        host: target.host,
        port: target.port,
        username: target.username,
        ...(target.password !== undefined ? { password: target.password } : {}),
        ...(target.credentialRef !== undefined ? { credentialRef: target.credentialRef } : {}),
        domain: target.domain ?? null,
        width,
        height,
        expectedFingerprint: target.expectedFingerprint ?? null,
        ...(options === undefined ? {} : { options }),
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
        ...(profileId === undefined ? {} : { profileId }),
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
      const earlyUpdates = earlyRdpUpdates.get(key);
      earlyRdpUpdates.delete(key);
      earlyUpdateBytes.delete(key);
      for (const u of earlyUpdates ?? []) handleRdpUpdate(handle.generation, handle.sessionId, u.seq, u.payload);
      applyEarlyClosed(key);
      return handle;
    }),
    async rdpCertDecision(handle, fingerprint, accept) {
      requireGeneration(handle);
      const info = rdpRecord(keyOf(handle));
      const prompt = info?.rdp?.prompt ?? null;
      if (prompt === null) throw new HelperRequestError("no_pending_prompt", "no certificate decision is pending");
      // The decision must name the certificate that was presented.
      if (!fingerprintEqual(prompt.fingerprint, fingerprint)) {
        throw new HelperRequestError("fingerprint_mismatch", "the decision names a different certificate than the one presented");
      }
      // A changed certificate is never trusted for good, whatever the page offered: the old one has to be forgotten first.
      if (accept === "always_trust" && prompt.reason === "cert_changed") {
        throw new HelperRequestError("always_trust_refused", "a changed certificate cannot be trusted for good; forget the old one first");
      }
      const hp = await start();
      // The helper knows two ways to accept (this handshake only, or on); "for good" is the plugin's own record.
      await hp.rdpCertDecision(handle, prompt.fingerprint, accept === "always_trust" ? "session_trust" : accept);
      if (accept === "session_trust") trust.trust(prompt.host, prompt.port, prompt.fingerprint);
      if (accept === "always_trust") trust.trustAlways(prompt.host, prompt.port, prompt.fingerprint, new Date());
      if (info?.rdp !== undefined) info.rdp.prompt = null;
    },
    rdpTrustedList: () => trust.listAlways(),
    rdpTrustedForget: (host, port, fingerprint) => trust.forget(host, port, fingerprint),
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
      applyEffects(runtime, runtime.mux.attach(viewId));
      const rdp = info.rdp;
      return {
        initial: { type: "attached", state: rdp.state, prompt: rdp.prompt, desktop: rdp.desktop, target: rdp.target },
        ack(frameId) {
          applyEffects(runtime, runtime.mux.onViewAck(viewId, frameId));
        },
        async input(events) {
          if (info.rdp?.state !== "desktop_ready") throw new HelperRequestError("not_ready", "the desktop is not ready yet");
          if (deps.control !== undefined && !deps.control.humanMayDrive(handle)) return false;
          await handoff(handle);
          // Ownership is checked again at dispatch, after the barrier: a takeover or a lease may have come meanwhile.
          if (ownerUnconfirmed(handle) || (deps.control !== undefined && !deps.control.humanMayDrive(handle))) return false;
          const hp = await start();
          await hp.rdpInput(handle, events);
          return true;
        },
        refresh() {
          // Resynchronise this view only: it becomes needsFull and the next full update reaches it.
          applyEffects(runtime, runtime.mux.resync(viewId));
        },
        detach() {
          runtime.views.delete(viewId);
          applyEffects(runtime, runtime.mux.detach(viewId));
        },
      };
    },
    pveOpen: tracked(async (args) => {
      const hp = await start();
      const { handle, kind } = await hp.openPve(args.connect, args.target, args.cols, args.rows);
      const key = keyOf(handle);
      if (kind === "pve") await startDrain(hp, handle);
      sessions.set(key, {
        generation: handle.generation,
        sessionId: handle.sessionId,
        kind,
        state: "connecting",
        exitCode: null,
        signal: null,
        reason: null,
        profileId: args.profileId,
        // What the console is for; the connection's secret is not part of it.
        pve: {
          profileId: args.profileId,
          connectionName: args.connectionName,
          console: args.target.kind,
          node: args.target.node,
          vmid: args.target.kind === "node" ? null : args.target.vmid,
          guestName: args.guestName,
          state: "connecting",
          reason: null,
        },
      });
      if (kind === "vnc") vncRelays.set(key, new VncRelay(deps.vncBufferBytes ?? 256 * 1024));
      const earlyEvents = earlyPveEvents.get(key);
      earlyPveEvents.delete(key);
      for (const event of earlyEvents ?? []) handlePveEvent(handle.generation, handle.sessionId, event);
      const earlyBytes = earlyVncData.get(key);
      earlyVncData.delete(key);
      earlyVncBytes.delete(key);
      for (const bytes of earlyBytes ?? []) handleVncData(handle.generation, handle.sessionId, bytes);
      applyEarlyClosed(key);
      refreshIdle(key);
      return { handle, kind };
    }),
    subscribePveConsole(handle, cb) {
      requireGeneration(handle);
      const key = keyOf(handle);
      const info = sessions.get(key);
      if (info?.pve === undefined) throw new HelperRuntimeError("session_not_found", "not a Proxmox console");
      let set = consoleListeners.get(key);
      if (set === undefined) {
        set = new Set();
        consoleListeners.set(key, set);
      }
      set.add(cb);
      cb({ state: info.pve.state, reason: info.pve.reason });
      return () => {
        set.delete(cb);
      };
    },
    vncAttach(handle, view) {
      requireGeneration(handle);
      const key = keyOf(handle);
      const info = sessions.get(key);
      const relay = vncRelays.get(key);
      if (info?.kind !== "vnc" || relay === undefined) throw new HelperRuntimeError("session_not_found", "unknown graphical console");
      const attached = relay.attach({ data: (bytes) => view.sendData(bytes), password: (password) => view.sendPassword(password) });
      if (!attached.ok) return attached;
      viewAttached(key);
      let done = false;
      return {
        ok: true,
        attachment: {
          async input(bytes) {
            if (deps.control !== undefined && !deps.control.humanMayDrive(handle)) return false;
            await handoff(handle);
            if (ownerUnconfirmed(handle) || (deps.control !== undefined && !deps.control.humanMayDrive(handle))) return false;
            const hp = await start();
            await hp.pveVncInput(handle, bytes);
            return true;
          },
          fail(reason) {
            const info = sessions.get(key);
            if (info !== undefined && info.state !== "closed") void closeSession(handle, reason).catch(() => {});
          },
          detach() {
            if (done) return;
            done = true;
            relay.detach();
            viewDetached(key);
            // The stream cannot be resumed, so a console whose one view is gone has no use: it is closed now, not kept for a view
            // that can never come (and nothing, not even the password, outlives it).
            const info = sessions.get(key);
            if (info !== undefined && info.state !== "closed") void closeSession(handle, "view_closed").catch(() => {});
          },
        },
      };
    },
    subscribeSshAskpass(handle, cb) {
      requireGeneration(handle);
      const state = askpassState(keyOf(handle));
      state.listeners.add(cb);
      // Replay what is still open, so a view that attaches (or reattaches) late sees it.
      for (const prompt of state.prompts.values()) cb(prompt);
      if (state.notice !== null) cb(state.notice);
      return () => {
        state.listeners.delete(cb);
      };
    },
    async sshPromptAnswer(handle, promptId, answer) {
      requireGeneration(handle);
      const hp = await start();
      try {
        await hp.sshPromptAnswer(handle, promptId, answer);
      } finally {
        // Answered or refused as already gone: either way the prompt is no longer open.
        askpassStates.get(keyOf(handle))?.prompts.delete(promptId);
      }
    },
    knownHosts: {
      list: async () => (await start()).knownHostsList(),
      add: async (lines) => (await start()).knownHostsAdd(lines),
      remove: async (host) => (await start()).knownHostsRemove(host),
    },
    pve: {
      async targets(connect) {
        const hp = await start();
        try {
          return { ok: true, ...(await hp.pveTargets(connect)) };
        } catch (error) {
          return pveFailure(error);
        }
      },
      async provision(args) {
        const hp = await start();
        try {
          const r = await hp.pveProvision(args);
          return r.kind === "plan" ? { ok: true, kind: "plan", plan: r.plan } : { ok: true, kind: "applied", steps: r.steps };
        } catch (error) {
          return pveFailure(error);
        }
      },
    },
    credentialAllow: async (ref) => viaVault(async (hp) => hp.credentialAllow(ref)),
    credentialVault: {
      save: async (ref, secret, bind) => viaVault(async (hp) => hp.credentialSave(ref, secret, bind)),
      delete: async (ref) => viaVault(async (hp) => hp.credentialDelete(ref)),
      status: async (ref) => ((await viaVault(async (hp) => hp.credentialStatus(ref))) ? "present" : "missing"),
    },
    sessionList() {
      return Array.from(sessions.values());
    },
    sessionClose: (handle) => closeSession(handle),
    sessionAttach(handle) {
      requireGeneration(handle);
      return attachTokens.issue(handle.sessionId, handle.generation);
    },
    consumeAttachToken(token) {
      return attachTokens.consume(token);
    },
    sessionRead(handle, from, max) {
      requireGeneration(handle);
      return helper?.scrollbackRead(handle.sessionId, from, max) ?? null;
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
      const isConsole = sessions.get(key)?.pve !== undefined;
      if (isConsole) viewAttached(key);
      let cancelled = false;
      const cancel = (): void => {
        set.delete(buffered);
        if (set.size === 0) listeners.delete(key);
        if (isConsole && !cancelled) {
          cancelled = true;
          viewDetached(key);
        }
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
      if (deps.control !== undefined && !deps.control.humanMayDrive(handle)) return false;
      await handoff(handle);
      if (ownerUnconfirmed(handle) || (deps.control !== undefined && !deps.control.humanMayDrive(handle))) return false;
      const process = await start();
      process.writeInput(handle.sessionId, data);
      return true;
    },
    async agentTerminalInput(handle, data, owner) {
      requireGeneration(handle);
      await handoff(handle);
      if (ownerUnconfirmed(handle) || deps.control === undefined || deps.control.ownerTag(handle) !== owner) throw lostLease();
      const process = await start();
      try {
        await process.sessionInputFrom(handle, new TextDecoder().decode(data), owner);
      } catch (error) {
        if (error instanceof HelperRequestError && error.code === "stale_owner") throw lostLease();
        throw error;
      }
    },
    async agentRdpInput(handle, events, owner) {
      requireGeneration(handle);
      if (rdpRecord(keyOf(handle))?.rdp?.state !== "desktop_ready") throw new HelperRequestError("not_ready", "the desktop is not ready yet");
      await handoff(handle);
      if (ownerUnconfirmed(handle) || deps.control === undefined || deps.control.ownerTag(handle) !== owner) throw lostLease();
      const hp = await start();
      try {
        await hp.rdpInput(handle, events, owner);
      } catch (error) {
        if (error instanceof HelperRequestError && error.code === "stale_owner") throw lostLease();
        throw error;
      }
    },
    controlState(handle) {
      return deps.control?.state(handle) ?? { owner: "human", expiresAt: null };
    },
    subscribeControl(handle, cb) {
      return deps.control?.subscribe(handle, cb) ?? (() => undefined);
    },
    agentControl(handle) {
      const key = keyOf(handle);
      const info = sessions.get(key);
      if (info === undefined || info.state === "closed" || info.kind === "echo") return "never";
      if (info.kind === "rdp") return "ready";
      // A Proxmox terminal is driven like any terminal once it is open; graphics have no agent input in this version.
      if (info.kind === "vnc") return "never";
      if (info.kind === "pve") return info.pve?.state === "active" ? "ready" : info.pve?.state === "connecting" ? "pending" : "never";
      if (!brokered.has(key)) return "never";
      const ask = askpassStates.get(key);
      if (ask === undefined) return "pending"; // nothing from the helper yet
      if (ask.failed) return "never";
      if (!ask.connected || ask.prompts.size > 0) return "pending";
      return "ready";
    },
    sshPendingPrompts(handle) {
      const prompts = askpassStates.get(keyOf(handle))?.prompts;
      return prompts === undefined ? [] : [...prompts.values()].filter((p) => p.kind === "confirm" || p.kind === "secret").map((p) => ({ promptId: p.promptId, text: p.text, kind: p.kind }));
    },
    ownerQuestions(handle) {
      const key = keyOf(handle);
      const questions: Array<"host_key" | "certificate" | "login_prompt"> = [];
      if (rdpRecord(key)?.rdp?.prompt != null) questions.push("certificate");
      const prompts = askpassStates.get(key)?.prompts;
      if (prompts !== undefined) {
        const kinds = new Set([...prompts.values()].map((p) => p.kind));
        if (kinds.has("confirm")) questions.push("host_key");
        if (kinds.has("secret")) questions.push("login_prompt");
      }
      return questions;
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
