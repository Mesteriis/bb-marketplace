// The agent tools that DRIVE a session (stage 4b-1): take control, connect, type. Host-free; everything outside comes
// through ports. They pass the same gate as the read tools (budget -> audit row BEFORE the action -> access -> action
// -> outcome) and add three things:
//  - a lease: input is accepted only from the thread that holds the session's lease (core/control-lease.ts), and the
//    lease ends when the owner takes the session back, its time is up, the grant drops below `input`, or the call is
//    aborted. Work still queued under a lease that ended is dropped, not run;
//  - typed input only (named keys, plain text without control characters, typed RDP actions), never a byte stream;
//  - no password, key, host or approval anywhere: a connection is opened by its id and a SAVED credential, and every
//    host-key or certificate question goes to the owner (the agent only learns that the owner is being asked).
// The audit keeps the length of an input, never the input itself and no hash of it.
import { pointerOf, type AgentFeed } from "./agent-feed.ts";
import { z } from "zod";
import { MAX_RDP_EVENTS_PER_CALL, SerialQueue, rdpActionsSchema, toRdpEvents, type RdpAction } from "./agent-input.ts";
import { CANNOT, GRAPHICS_NO_INPUT, ToolError, connectionIdSchema, createGate, def, errorResult, json, sessionIdSchema, type AgentCallContext, type AgentSessionView, type AgentToolDef, type AgentToolDeps } from "./agent-tools.ts";
import { LEASE_DEFAULT_SECONDS, LEASE_MAX_SECONDS, LEASE_MIN_SECONDS, type ControlLeases, type LeaseEnd } from "./control-lease.ts";
import type { ConsoleRequest } from "./pve-console.ts";
import { RECONNECT_ATTEMPTS, STABLE_AFTER_MS } from "./pve-reconnect.ts";
import type { RdpInputEvent } from "./rdp-protocol.ts";

/** What the adapter does for the control tools. */
export interface AgentControlPorts {
  /**
   * `owner` is the lease the input belongs to (`agent:<leaseId>`). The adapter hands it to the helper, which refuses it once
   * that lease is no longer the session's driver (Z2): work already downstream is dropped there, not only in this process.
   */
  terminalWrite(sessionKey: string, data: Uint8Array, owner: string): Promise<void>;
  rdpWrite(sessionKey: string, events: RdpInputEvent[], owner: string): Promise<void>;
  /** Opens a saved connection with its saved credential. Never asks the agent for a secret. */
  connect(profileId: string, console?: ConsoleRequest): Promise<{ sessionKey: string }>;
  disconnect(sessionKey: string): Promise<void>;
  /** The kinds of question the owner has to answer on this session (no text, no fingerprints). */
  waitingForOwner(sessionKey: string): Array<"host_key" | "certificate" | "login_prompt">;
  /** Whether a human has this session's live view open and visible right now (agents are never hidden). */
  watching(sessionKey: string): boolean;
  /** The owner's setting: agents act only while the session is watched (default true). Read on every call. */
  watchingRequired(): boolean;
  /** Told when a session gains or loses its watcher (already settled: a report that merely expired is noticed by the sweep). */
  onWatchChange(cb: (sessionKey: string, watching: boolean) => void): () => void;
  /** Told when the owner switches the watching rule. */
  onRuleChange(cb: () => void): () => void;
}

/** Which thread opened which session through remote_connect (memory only; empty after a restart, like leases). */
export class AgentSessionRegistry {
  private readonly opened = new Map<string, string>();
  mark(sessionKey: string, threadId: string): void {
    this.opened.set(sessionKey, threadId);
    for (const cb of this.markListeners) cb(sessionKey);
  }
  /** Told when an agent's session is registered (the owner's pages learn about it). */
  onMark(cb: (sessionKey: string) => void): void {
    this.markListeners.push(cb);
  }
  private readonly markListeners: Array<(sessionKey: string) => void> = [];
  threadOf(sessionKey: string): string | undefined {
    return this.opened.get(sessionKey);
  }
  forget(sessionKey: string): void {
    this.opened.delete(sessionKey);
    this.closing.delete(sessionKey);
    this.lineage.delete(sessionKey);
  }
  /** How many times in a row this console was reopened by remote_reconnect, and when this session was opened (memory only). */
  private readonly lineage = new Map<string, { reconnects: number; openedAt: number }>();
  setLineage(sessionKey: string, reconnects: number, openedAt: number): void {
    this.lineage.set(sessionKey, { reconnects, openedAt });
  }
  reconnectsOf(sessionKey: string): number {
    return this.lineage.get(sessionKey)?.reconnects ?? 0;
  }
  openedAtOf(sessionKey: string): number | undefined {
    return this.lineage.get(sessionKey)?.openedAt;
  }
  /** A session whose close could not be confirmed: it stays registered (and counted) until it is. */
  markClosing(sessionKey: string): void {
    this.closing.add(sessionKey);
  }
  closingKeys(): string[] {
    return [...this.closing];
  }
  private readonly closing = new Set<string>();
  keys(): string[] {
    return [...this.opened.keys()];
  }
  keysOf(threadId: string): string[] {
    return [...this.opened].filter(([, t]) => t === threadId).map(([k]) => k);
  }
  /** The thread was archived: its sessions stay open but the owner sees whose they were. */
  markArchived(threadId: string): void {
    this.archived.add(threadId);
  }
  /** The thread was deleted: it never comes back. */
  markDeleted(threadId: string): void {
    this.deleted.add(threadId);
  }
  /** The thread came back from the archive. */
  unarchive(threadId: string): void {
    this.archived.delete(threadId);
  }
  isDeleted(threadId: string): boolean {
    return this.deleted.has(threadId);
  }
  isArchived(threadId: string): boolean {
    return this.archived.has(threadId);
  }
  /** An archived or deleted thread may not start anything new (a delayed call from it is refused). */
  isRetired(threadId: string): boolean {
    return this.archived.has(threadId) || this.deleted.has(threadId);
  }
  private readonly archived = new Set<string>();
  private readonly deleted = new Set<string>();
}

export interface AgentControlDeps extends AgentToolDeps {
  leases: ControlLeases;
  control: AgentControlPorts;
  /** Shared with the owner's page, which lists what agents opened. */
  registry?: AgentSessionRegistry;
  /** What agents do, announced to the owner's open views. */
  feed?: AgentFeed;
}

export const MAX_SESSIONS_PER_THREAD = 4;
export const TERMINAL_INPUT_MAX_BYTES = 4096;

const KEY_BYTES = {
  Enter: "\r",
  Tab: "\t",
  Escape: "\u001b",
  Backspace: "\u007f",
  Up: "\u001b[A",
  Down: "\u001b[B",
  Right: "\u001b[C",
  Left: "\u001b[D",
  Home: "\u001b[H",
  End: "\u001b[F",
  "Ctrl-C": "\u0003",
  "Ctrl-D": "\u0004",
  "Ctrl-Z": "\u001a",
  "Ctrl-L": "\u000c",
} as const;
type KeyName = keyof typeof KEY_BYTES;
const KEY_NAMES = Object.keys(KEY_BYTES) as [KeyName, ...KeyName[]];

/** Text an agent types has no control characters: no escape sequence, no hidden Enter or Tab (those are named keys). */
const plainText = z
  .string()
  .min(1)
  .max(TERMINAL_INPUT_MAX_BYTES)
  .refine((t) => !/[\u0000-\u001f\u007f-\u009f]/.test(t), { message: "text cannot contain control characters; use a named key for Enter, Tab, Escape and so on" });

const terminalActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: plainText }).strict(),
  z.object({ type: z.literal("key"), key: z.enum(KEY_NAMES) }).strict(),
]);
type TerminalAction = z.infer<typeof terminalActionSchema>;

const leaseIdSchema = z.string().min(1).max(64);
const observedSchema = z.object({ frameId: z.number().int().min(0), width: z.number().int().min(1), height: z.number().int().min(1) }).strict();
const textEncoder = new TextEncoder();
/** The owner tag the helper holds for a session while this lease drives it. */
export const ownerTag = (leaseId: string): string => `agent:${leaseId}`;

function terminalBytes(actions: TerminalAction[]): Uint8Array {
  return textEncoder.encode(actions.map((a) => (a.type === "text" ? a.text : KEY_BYTES[a.key])).join(""));
}

/** More fields for a session's row in the read tools: who is driving it and whether the owner is being asked something. */
export function controlSessionExtras(leases: ControlLeases, control: Pick<AgentControlPorts, "waitingForOwner" | "watching" | "watchingRequired">, registry?: AgentSessionRegistry) {
  return (s: AgentSessionView): Record<string, unknown> => {
    const owner = leases.owner(s.key);
    const waiting = control.waitingForOwner(s.key);
    return {
      controlledBy: owner.kind === "human" ? "human" : "an agent",
      ...(owner.kind === "agent" ? { leaseExpiresAt: new Date(owner.expiresAt).toISOString() } : {}),
      ...(waiting.length > 0 ? { waitingForOwner: waiting } : {}),
      watchedByOwner: control.watching(s.key),
      watchingRequired: control.watchingRequired(),
      // A Proxmox console: how many times in a row it was reopened with remote_reconnect (each time a NEW session id).
      ...(s.pve !== undefined && registry !== undefined ? { reconnects: registry.reconnectsOf(s.key), maxReconnects: RECONNECT_ATTEMPTS } : {}),
    };
  };
}

const CLOSE_CONFIRM_MS = 5000;
/** End reasons a repeated open cannot change and may make worse (a refused login can lock an account): the owner fixes the connection. */
const NO_AGENT_RETRY: ReadonlySet<string> = new Set(["login_failed", "tls_untrusted", "cert_changed", "tfa_required", "no_credential"]);

/** The line the agent copies into its reply so BB shows the live session inline (a message directive this plugin renders). */
export const liveViewLine = (sessionKey: string): string => `::remote-session{id="${sessionKey}"}`;
export const LIVE_VIEW_INSTRUCTION =
  "Put the liveView line on its own line in your reply so the owner sees this session live. Nothing you type or run is accepted while nobody has the live view open and visible.";
export const NOT_WATCHING = new ToolError(
  "owner_not_watching",
  "Nobody has this session's live view open and visible, so nothing was sent. Put the liveView line in your reply (the owner sees the session there, or on the Remote Hub page) and try again once the owner is watching."
);

/** The console a remote_connect asks for: required for a Proxmox connection, and for no other kind. */
function consoleRequestOf(protocol: string, p: { console?: "node" | "lxc" | "qemu" | undefined; node?: string | undefined; vmid?: number | undefined }): ConsoleRequest | undefined {
  if (protocol !== "pve") {
    if (p.console !== undefined || p.node !== undefined || p.vmid !== undefined) throw new ToolError("not_a_proxmox_connection", "console, node and vmid are only for Proxmox connections");
    return undefined;
  }
  if (p.console === undefined) throw new ToolError("console_required", 'a Proxmox connection needs `console`: "node" with `node`, "lxc" or "qemu" with `vmid`');
  // A node shell is a shell on the hypervisor: PVE logs the console's user straight in (root@pam gets a root shell with no prompt)
  // or shows a login prompt the owner answers by hand. Neither is for an agent, whoever asks and whatever the grant.
  if (p.console === "node") throw new ToolError("node_shell_owner_only", "a shell on a Proxmox node is only for the owner: agents cannot open one, read one or type into one");
  if (p.vmid === undefined || p.node !== undefined) throw new ToolError("invalid_target", "a guest console names its vmid and no node (the node is looked up)");
  return { console: p.console, vmid: p.vmid };
}

export function createControlTools(deps: AgentControlDeps): AgentToolDef[] {
  const { access, leases, control, ports } = deps;
  const { guarded, noSession } = createGate(deps);
  const queue = new SerialQueue();
  /** Which thread opened which session (memory only): a thread may disconnect what it opened, and no more than four at a time. */
  const openedBy = deps.registry ?? new AgentSessionRegistry();
  /** Opens in flight per thread: they count against the per-thread cap before they finish. */
  const opening = new Map<string, number>();

  const sessionOf = (key: string): AgentSessionView | undefined => ports.sessions.list().find((s) => s.key === key);
  /** For the owner's audit only: which connection a session belongs to, whatever the grant says. */
  const profileOf = (key: string): string | null => sessionOf(key)?.profileId ?? null;

  /** The session and its profile when the owner allows driving it (input or above); the same error for missing and not allowed. */
  function controllable(key: string, opts: { graphics?: "allow" } = {}): { session: AgentSessionView; profileId: string } {
    const session = sessionOf(key);
    if (session === undefined || session.profileId === undefined || !access.check(session.profileId, "input").ok) throw noSession();
    // A virtual machine's graphics: an agent may open it, see its state and disconnect it, nothing else in this version.
    if (session.kind === "vnc") {
      if (opts.graphics !== "allow") throw GRAPHICS_NO_INPUT;
      if (session.state === "closed") throw new ToolError("session_closed", "this session has ended");
      return { session, profileId: session.profileId };
    }
    // A terminal session that is not an askpass session shows its questions in the terminal: it answers exactly like a
    // missing one, so nothing is learnt about sessions the owner opened by hand.
    if (session.control === "never") throw noSession();
    if (session.state === "closed") throw new ToolError("session_closed", "this session has ended");
    if (session.control === "pending") throw new ToolError("session_not_ready", "the session is not authenticated yet, or the owner has a question to answer: try again shortly");
    return { session, profileId: session.profileId };
  }

  /** The lease check as an error; also tells the caller when the lease is gone for any reason. */
  const refuseRetired = (ctx: AgentCallContext): void => {
    if (openedBy.isRetired(ctx.threadId)) throw new ToolError("thread_retired", "this thread has been archived or deleted");
  };

  function leaseGeneration(key: string, ctx: AgentCallContext, leaseId: string): number {
    const check = leases.check(key, ctx.threadId, leaseId);
    if (!check.ok) throw new ToolError(check.code, check.code === "lease_expired" ? "the lease ran out; take control again" : check.code === "no_lease" ? "no lease is held on this session: use remote_control_acquire" : "this lease is not yours");
    return check.generation;
  }

  // What an agent left pressed, and what it still had queued, is released and dropped by the HELPER when the driver changes
  // (session.set_owner), against the desktop as it is then; this process only drops the work still waiting in its own queue.
  // A grant lowered below `input` ends the leases that depended on it.
  access.onChange(() => {
    leases.endWhere((key) => {
      const profileId = sessionOf(key)?.profileId;
      return profileId === undefined || !access.check(profileId, "input").ok;
    }, "revoked");
  });

  /** Whether an agent may act on this session now: always when the owner switched the gate off, else only while it is watched. */
  const mayAct = (key: string): boolean => !control.watchingRequired() || control.watching(key);

  /** Runs `write` in the session's queue if, when its turn comes, the same lease still holds, the grant is intact and the call was not aborted. */
  async function driven(key: string, ctx: AgentCallContext, leaseId: string, profileId: string, write: () => Promise<void>): Promise<void> {
    const generation = leaseGeneration(key, ctx, leaseId);
    // Only the lease THIS call was given: a late abort of an old call must not end the lease that replaced it.
    const onAbort = () => void leases.endLease(key, ctx.threadId, leaseId, "thread_gone");
    ctx.signal?.addEventListener("abort", onAbort, { once: true });
    if (!mayAct(key)) throw NOT_WATCHING;
    try {
      const stillValid = () =>
        ctx.signal?.aborted !== true && mayAct(key) && access.check(profileId, "input").ok && sessionOf(key)?.control === "ready" && leases.check(key, ctx.threadId, leaseId).ok && leases.owner(key).generation === generation;
      const outcome = await queue.run(key, stillValid, write);
      if (!outcome.ran && !mayAct(key)) throw NOT_WATCHING;
      if (!outcome.ran) throw new ToolError("lease_lost", "the owner took the session back, or the lease ended, before this input was sent; nothing was sent");
    } finally {
      ctx.signal?.removeEventListener("abort", onAbort);
    }
  }

  /**
   * Opens a connection for a thread and registers the session at once. The slot is taken BEFORE the open is awaited, and given
   * back on every way out: parallel calls cannot all see room. If the grant, the thread or the call ended while it opened,
   * the session is closed, not handed over.
   */
  async function openRegistered(ctx: AgentCallContext, profileId: string, consoleRequest: ConsoleRequest | undefined, reconnects = 0): Promise<string> {
    const live = ports.sessions.list().filter((s) => s.state !== "closed" && openedBy.threadOf(s.key) === ctx.threadId).length;
    if (live + (opening.get(ctx.threadId) ?? 0) >= MAX_SESSIONS_PER_THREAD) throw new ToolError("too_many_sessions", `this thread already has ${MAX_SESSIONS_PER_THREAD} open sessions: disconnect one first`);
    opening.set(ctx.threadId, (opening.get(ctx.threadId) ?? 0) + 1);
    let sessionKey: string;
    try {
      ({ sessionKey } = await control.connect(profileId, consoleRequest));
      // Registered at once: whatever happens next, the session is accounted for until it is confirmed closed.
      openedBy.mark(sessionKey, ctx.threadId);
      openedBy.setLineage(sessionKey, reconnects, Date.now());
      if (!access.check(profileId, "connect").ok || openedBy.isRetired(ctx.threadId) || ctx.signal?.aborted === true) {
        try {
          await Promise.race([control.disconnect(sessionKey), new Promise((_, reject) => setTimeout(() => reject(new Error("close timed out")), CLOSE_CONFIRM_MS).unref?.())]);
        } catch {
          openedBy.markClosing(sessionKey);
          throw new ToolError("connect_cancelled", "the permission to connect ended while the connection was opening; the session could not be confirmed closed, it stays listed and Remote Hub keeps trying to close it");
        }
        openedBy.forget(sessionKey);
        throw new ToolError("connect_cancelled", "the permission to connect ended while the connection was opening; it was closed");
      }
    } finally {
      const left = (opening.get(ctx.threadId) ?? 1) - 1;
      if (left > 0) opening.set(ctx.threadId, left);
      else opening.delete(ctx.threadId);
    }
    return sessionKey;
  }

  const tools: AgentToolDef[] = [
    def({
      name: "remote_control_acquire",
      description:
        CANNOT +
        `Takes control of one open session for a while so that remote_terminal_input or remote_rdp_input is accepted (default ${LEASE_DEFAULT_SECONDS} s, ${LEASE_MIN_SECONDS}-${LEASE_MAX_SECONDS} s). ` +
        "Needs the owner's input level on that connection. The owner sees that an agent drives the session and can take it back at once; asking again while you hold it extends it. Cannot take a session another agent holds.",
      parameters: z.object({ sessionId: sessionIdSchema, seconds: z.number().int().min(LEASE_MIN_SECONDS).max(LEASE_MAX_SECONDS).optional() }).strict(),
      execute: (params, ctx) =>
        guarded("remote_control_acquire", ctx, { sessionKey: params.sessionId, profileId: profileOf(params.sessionId) }, async () => {
          refuseRetired(ctx);
          const { session } = controllable(params.sessionId);
          let result = leases.acquire(params.sessionId, ctx.threadId, params.seconds);
          if (!result.ok && result.code === "already_held_by_you") {
            const owner = leases.owner(params.sessionId);
            if (owner.kind === "agent") result = leases.renew(params.sessionId, ctx.threadId, owner.leaseId, params.seconds);
          }
          if (!result.ok) {
            const message = { held_by_another_thread: "another agent holds this session", owner_took_over: "the owner took this session back; it stays with them for a few minutes or until they allow agents again", already_held_by_you: "this lease is not yours", not_the_owner: "this lease is not yours" }[result.code];
            throw new ToolError(result.code, message);
          }
          return {
            content: [
              json({
                sessionId: session.key,
                leaseId: result.leaseId,
                expiresAt: new Date(result.expiresAt).toISOString(),
                ttlSeconds: Math.min(LEASE_MAX_SECONDS, Math.max(LEASE_MIN_SECONDS, params.seconds ?? LEASE_DEFAULT_SECONDS)),
                watching: control.watching(session.key),
                watchingRequired: control.watchingRequired(),
                liveView: liveViewLine(session.key),
                instruction: LIVE_VIEW_INSTRUCTION,
              }),
            ],
          };
        }),
    }),
    def({
      name: "remote_control_release",
      description: CANNOT + "Gives a session back to its owner. Cannot release a lease that is not yours.",
      parameters: z.object({ sessionId: sessionIdSchema, leaseId: leaseIdSchema }).strict(),
      execute: (params, ctx) =>
        guarded("remote_control_release", ctx, { sessionKey: params.sessionId, profileId: profileOf(params.sessionId) }, async () => {
          controllable(params.sessionId);
          const released = leases.release(params.sessionId, ctx.threadId, params.leaseId);
          if (!released.ok) throw new ToolError(released.code, released.code === "no_lease" ? "no lease is held on this session" : "this lease is not yours");
          return { content: [json({ sessionId: params.sessionId, released: true })] };
        }),
    }),
    def({
      name: "remote_connect",
      description:
        CANNOT +
        "Opens a saved connection the owner allowed at the input level or above, using its SAVED credential; connections without one are refused. There is no password, host or approval parameter. " +
        "A Proxmox connection also needs `console`: \"lxc\" with `vmid` (a container's terminal) or \"qemu\" with `vmid` (a virtual machine's graphics). A shell on a Proxmox NODE is never available to agents (node_shell_owner_only). The guest's node is looked up again; a stopped guest or a template is refused and is never started. " +
        "A container console is a terminal: read it with remote_terminal_read and type with remote_terminal_input. It is whatever the container's console is logged in as (not the Proxmox API user). Only a container console YOU opened here is available to you; one the owner opened by hand is not (the owner may have typed a password into it). A virtual machine's graphics you can open, see the state of and disconnect, but you get NO screenshot and NO input for it in this version; the owner sees it. " +
        "A new host key, a changed key or a certificate is decided by the owner on the Remote Hub page: the result then says waitingForOwner and the session stays connecting until the owner answers. " +
        `At most ${MAX_SESSIONS_PER_THREAD} open sessions per thread. ` +
        "On a desktop: no launching programs through Start/Run/Win+R unless the owner asked in this conversation; on a security/EDR block stop all input and report (see the skill).",
      parameters: z
        .object({
          connectionId: connectionIdSchema,
          console: z.enum(["node", "lxc", "qemu"]).optional(),
          node: z.string().min(1).max(63).optional(),
          vmid: z.number().int().min(100).max(999_999_999).optional(),
        })
        .strict(),
      execute: (params, ctx) =>
        guarded("remote_connect", ctx, { profileId: params.connectionId }, async () => {
          refuseRetired(ctx);
          const profile = ports.profiles.get(params.connectionId);
          if (profile === null || !access.check(params.connectionId, "connect").ok) throw new ToolError("agent_access_denied", "the owner has not allowed agents to use this connection");
          if (profile.credentialRef === null) throw new ToolError("needs_saved_credential", "this connection has no saved credential; the owner must save one on the Remote Hub page first");
          const consoleRequest = consoleRequestOf(profile.protocol, params);
          const sessionKey = await openRegistered(ctx, profile.id, consoleRequest);
          const waiting = control.waitingForOwner(sessionKey);
          return { content: [json({ sessionId: sessionKey, connectionId: profile.id, state: sessionOf(sessionKey)?.state ?? "connecting", ...(waiting.length > 0 ? { waitingForOwner: waiting } : {}), watching: control.watching(sessionKey), watchingRequired: control.watchingRequired(), liveView: liveViewLine(sessionKey), instruction: LIVE_VIEW_INSTRUCTION })] };
        }),
    }),
    def({
      name: "remote_reconnect",
      description:
        CANNOT +
        "Opens a Proxmox container or virtual machine console again after one YOU opened with remote_connect was lost or ended. It is always a NEW console with a NEW session id (returned as sessionId; the old id is gone), opened with a fresh login and the guest's current node; nothing typed before is sent again, and the old terminal text is not carried over. " +
        "The same checks as remote_connect apply (the owner's connect level, the saved credential, four sessions per thread). The new console has no lease: take control again with remote_control_acquire. " +
        `It is refused while the console is still connected, after a login, certificate or second-factor refusal (the owner must fix the connection), and after ${RECONNECT_ATTEMPTS} reopenings in a row that did not hold for ${STABLE_AFTER_MS / 1000} seconds. ` +
        "A shell on a Proxmox node is never available to agents. remote_session_status shows the console state, the reason and how many times it was reopened.",
      parameters: z.object({ sessionId: sessionIdSchema }).strict(),
      execute: (params, ctx) =>
        guarded("remote_reconnect", ctx, { sessionKey: params.sessionId, profileId: profileOf(params.sessionId) }, async () => {
          refuseRetired(ctx);
          const old = sessionOf(params.sessionId);
          if (old === undefined || old.profileId === undefined || old.pve === undefined || (old.kind !== "pve" && old.kind !== "vnc")) throw noSession();
          if (openedBy.threadOf(old.key) !== ctx.threadId) throw new ToolError("not_opened_by_you", "this thread did not open this session");
          if (old.pve.console === "node") throw new ToolError("node_shell_owner_only", "a shell on a Proxmox node is only for the owner");
          const profile = ports.profiles.get(old.profileId);
          if (profile === null || !access.check(old.profileId, "connect").ok) throw new ToolError("agent_access_denied", "the owner has not allowed agents to use this connection");
          if (profile.credentialRef === null) throw new ToolError("needs_saved_credential", "this connection has no saved credential; the owner must save one on the Remote Hub page first");
          if (old.state !== "closed") throw new ToolError("still_connected", "this console is still connected: use it, or remote_disconnect it first");
          const code = old.pve.reasonCode ?? null;
          if (code !== null && NO_AGENT_RETRY.has(code)) throw new ToolError("reconnect_refused", `the console ended with ${code}: ${old.pve.reason ?? "the owner has to fix the connection"} Reconnecting would only repeat it.`);
          // A reopening that held for a while starts the count again; quick repeated losses count up to the cap.
          const openedAt = openedBy.openedAtOf(old.key);
          const held = openedAt !== undefined && Date.now() - openedAt >= STABLE_AFTER_MS;
          const reconnects = held ? 1 : openedBy.reconnectsOf(old.key) + 1;
          if (reconnects > RECONNECT_ATTEMPTS) throw new ToolError("reconnect_limit", `this console was reopened ${RECONNECT_ATTEMPTS} times in a row without holding; ask the owner to look at it`);
          const request: ConsoleRequest = { console: old.pve.console, vmid: old.pve.vmid ?? 0 };
          const sessionKey = await openRegistered(ctx, profile.id, request, reconnects);
          // The old session is gone for this thread: its lease ended and its id no longer answers.
          leases.endSession(old.key, "session_closed");
          openedBy.forget(old.key);
          const waiting = control.waitingForOwner(sessionKey);
          return {
            content: [
              json({
                sessionId: sessionKey,
                previousSessionId: old.key,
                connectionId: profile.id,
                reconnects,
                maxReconnects: RECONNECT_ATTEMPTS,
                state: sessionOf(sessionKey)?.state ?? "connecting",
                ...(waiting.length > 0 ? { waitingForOwner: waiting } : {}),
                watching: control.watching(sessionKey),
                watchingRequired: control.watchingRequired(),
                liveView: liveViewLine(sessionKey),
                instruction: LIVE_VIEW_INSTRUCTION,
                note: "A NEW console with a new session id: nothing typed before is sent again and the old text is not carried over. Take control again before typing.",
              }),
            ],
          };
        }),
    }),
    def({
      name: "remote_disconnect",
      description: CANNOT + "Closes a session this thread opened with remote_connect. Cannot close sessions the owner or another thread opened.",
      parameters: z.object({ sessionId: sessionIdSchema }).strict(),
      execute: (params, ctx) =>
        guarded("remote_disconnect", ctx, { sessionKey: params.sessionId, profileId: profileOf(params.sessionId) }, async () => {
          controllable(params.sessionId, { graphics: "allow" });
          if (openedBy.threadOf(params.sessionId) !== ctx.threadId) throw new ToolError("not_opened_by_you", "this thread did not open this session");
          await control.disconnect(params.sessionId);
          leases.endSession(params.sessionId, "session_closed");
          openedBy.forget(params.sessionId);
          return { content: [json({ sessionId: params.sessionId, disconnected: true })] };
        }),
    }),
    def({
      name: "remote_terminal_input",
      description:
        CANNOT +
        "Types into a terminal session (SSH, or a Proxmox node or container terminal) you hold the lease on: plain text (no control characters) and named keys (Enter, Tab, Escape, Backspace, arrows, Home, End, Ctrl-C/D/Z/L), in order. " +
        `At most ${TERMINAL_INPUT_MAX_BYTES} bytes per call. Cannot send raw bytes or escape sequences, and cannot type into a desktop session or a Proxmox virtual machine's graphics. The audit keeps the length of what you send, not the text.`,
      parameters: z.object({ sessionId: sessionIdSchema, leaseId: leaseIdSchema, actions: z.array(terminalActionSchema).min(1).max(40) }).strict(),
      execute: async (params, ctx) => {
        const bytes = terminalBytes(params.actions);
        if (bytes.length > TERMINAL_INPUT_MAX_BYTES) return errorResult("input_too_large", `more than ${TERMINAL_INPUT_MAX_BYTES} bytes in one call`);
        const detail = `len ${bytes.length}`;
        return guarded("remote_terminal_input", ctx, { sessionKey: params.sessionId, profileId: profileOf(params.sessionId), detailMode: "length", detail }, async () => {
          const { session, profileId } = controllable(params.sessionId);
          if (session.kind === "rdp") throw new ToolError("not_a_terminal", "this is a desktop session: use remote_rdp_input");
          await driven(params.sessionId, ctx, params.leaseId, profileId, () => control.terminalWrite(params.sessionId, bytes, ownerTag(params.leaseId)));
          deps.feed?.emit(params.sessionId, { kind: "typed", length: bytes.length });
          return { content: [json({ sessionId: params.sessionId, queuedBytes: bytes.length })] };
        });
      },
    }),
    def({
      name: "remote_rdp_input",
      description:
        CANNOT +
        "Sends typed actions to a desktop (RDP) session you hold the lease on: mouse_move, click, mouse_button, wheel, key (a KeyboardEvent.code such as Enter or KeyA), text and ctrl_alt_del. " +
        "Positions are desktop pixels. Any action with a position needs `observed` (frameId, width, height from remote_rdp_screenshot): a changed desktop size, or a frame number the desktop has not reached, is refused as stale_geometry (a frame older than the current one is fine while the size is the same). " +
        `At most ${MAX_RDP_EVENTS_PER_CALL} events per call; text has no control characters. The answer says the events were queued, which is not proof that the desktop acted on them. ` +
        "Keys and buttons left down are released when your control ends. Cannot send raw events or type into a terminal session. " +
        "Do NOT launch shells or programs through Start/Run/Win+R or launch shortcuts unless the owner asked for that in this conversation; say what you will type first. On any security/EDR block, access-denied launch error or antivirus notice: stop all input, dismiss nothing, try no other route, report what was shown. Endpoint protection may flag automated input.",
      parameters: z.object({ sessionId: sessionIdSchema, leaseId: leaseIdSchema, observed: observedSchema.optional(), actions: rdpActionsSchema }).strict(),
      execute: async (params, ctx) => {
        const actions = params.actions as RdpAction[];
        const detail = `len ${JSON.stringify(actions).length}`;
        return guarded("remote_rdp_input", ctx, { sessionKey: params.sessionId, profileId: profileOf(params.sessionId), detailMode: "length", detail }, async () => {
          const { session, profileId } = controllable(params.sessionId);
          if (session.kind !== "rdp") throw new ToolError("not_a_desktop", "this is a terminal session: use remote_terminal_input");
          const desktop = session.rdp?.desktop ?? null;
          if (session.rdp?.state !== "desktop_ready" || desktop === null) throw new ToolError("desktop_not_ready", "the desktop is not shown yet");
          const positional = actions.some((a) => "x" in a);
          if (positional) {
            const o = params.observed;
            if (o === undefined) throw new ToolError("observed_required", "actions with a position need `observed` from the screenshot you based them on");
            if (o.width !== desktop.width || o.height !== desktop.height || o.frameId > desktop.frameId) throw new ToolError("stale_geometry", `the desktop is ${desktop.width}x${desktop.height} now; take a new screenshot`);
          }
          const events = toRdpEvents(actions, desktop);
          if (!events.ok) throw new ToolError("out_of_bounds", `action ${events.index + 1} is outside the ${desktop.width}x${desktop.height} desktop`);
          // A text event becomes a press and a release per character in the engine: it weighs twice its length.
          const weight = events.events.reduce((n, e) => n + (e.kind === "unicode" ? 2 * e.text.length : 1), 0);
          if (weight > MAX_RDP_EVENTS_PER_CALL) throw new ToolError("too_many_events", `these actions come to ${weight} key and pointer events; at most ${MAX_RDP_EVENTS_PER_CALL} per call`);
          await driven(params.sessionId, ctx, params.leaseId, profileId, async () => {
            // The size is checked again when this write's turn comes: a resize while it waited is a stale geometry, not a click somewhere else.
            const now = sessionOf(params.sessionId)?.rdp?.desktop ?? null;
            if (positional && (now === null || now.width !== desktop.width || now.height !== desktop.height)) throw new ToolError("stale_geometry", "the desktop changed size while this input waited; take a new screenshot");
            await control.rdpWrite(params.sessionId, events.events, ownerTag(params.leaseId));
          });
          const shown = pointerOf(events.events);
          if (shown !== null) deps.feed?.emit(params.sessionId, shown);
          // "queued" says what is known: the helper accepted the events. The desktop can still refuse a position (rdp.input_rejected).
          return { content: [json({ sessionId: params.sessionId, queuedEvents: events.events.length })] };
        });
      },
    }),
  ];
  return tools;
}
