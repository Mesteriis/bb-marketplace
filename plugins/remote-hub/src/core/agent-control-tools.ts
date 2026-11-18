// The agent tools that DRIVE a session (stage 4b-1): take control, connect, type. Host-free; everything outside comes
// through ports. They pass the same gate as the read tools (budget -> audit row BEFORE the action -> access -> action
// -> outcome) and add three things:
//  - a lease: input is accepted only from the thread that holds the session's lease (core/control-lease.ts), and the
//    lease ends when the owner takes the session back, its time is up, the grant drops below `input`, or the call is
//    aborted. Work still queued under a lease that ended is dropped, not run;
//  - typed input only (named keys, plain text without control characters, typed RDP actions), never a byte stream;
//  - no password, key, host or approval anywhere: a connection is opened by its id and a SAVED credential, and every
//    host-key or certificate question goes to the owner (the agent only learns that the owner is being asked).
// The audit keeps the length and a short hash of an input, never the input itself.
import { z } from "zod";
import { HeldInput, SerialQueue, rdpActionsSchema, shortHash, toRdpEvents, type RdpAction } from "./agent-input.ts";
import { CANNOT, ToolError, connectionIdSchema, createGate, def, errorResult, json, sessionIdSchema, type AgentCallContext, type AgentSessionView, type AgentToolDef, type AgentToolDeps } from "./agent-tools.ts";
import { LEASE_DEFAULT_SECONDS, LEASE_MAX_SECONDS, LEASE_MIN_SECONDS, type ControlLeases, type LeaseEnd } from "./control-lease.ts";
import type { RdpInputEvent } from "./rdp-protocol.ts";

/** What the adapter does for the control tools. */
export interface AgentControlPorts {
  terminalWrite(sessionKey: string, data: Uint8Array): Promise<void>;
  rdpWrite(sessionKey: string, events: RdpInputEvent[]): Promise<void>;
  /** Opens a saved connection with its saved credential. Never asks the agent for a secret. */
  connect(profileId: string): Promise<{ sessionKey: string }>;
  disconnect(sessionKey: string): Promise<void>;
  /** The kinds of question the owner has to answer on this session (no text, no fingerprints). */
  waitingForOwner(sessionKey: string): Array<"host_key" | "certificate" | "login_prompt">;
}

/** Which thread opened which session through remote_connect (memory only; empty after a restart, like leases). */
export class AgentSessionRegistry {
  private readonly opened = new Map<string, string>();
  mark(sessionKey: string, threadId: string): void {
    this.opened.set(sessionKey, threadId);
  }
  threadOf(sessionKey: string): string | undefined {
    return this.opened.get(sessionKey);
  }
  forget(sessionKey: string): void {
    this.opened.delete(sessionKey);
  }
  keys(): string[] {
    return [...this.opened.keys()];
  }
}

export interface AgentControlDeps extends AgentToolDeps {
  leases: ControlLeases;
  control: AgentControlPorts;
  /** Shared with the owner's page, which lists what agents opened. */
  registry?: AgentSessionRegistry;
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

function terminalBytes(actions: TerminalAction[]): Uint8Array {
  return textEncoder.encode(actions.map((a) => (a.type === "text" ? a.text : KEY_BYTES[a.key])).join(""));
}

/** More fields for a session's row in the read tools: who is driving it and whether the owner is being asked something. */
export function controlSessionExtras(leases: ControlLeases, control: Pick<AgentControlPorts, "waitingForOwner">) {
  return (s: AgentSessionView): Record<string, unknown> => {
    const owner = leases.owner(s.key);
    const waiting = control.waitingForOwner(s.key);
    return {
      controlledBy: owner.kind === "human" ? "human" : "an agent",
      ...(owner.kind === "agent" ? { leaseExpiresAt: new Date(owner.expiresAt).toISOString() } : {}),
      ...(waiting.length > 0 ? { waitingForOwner: waiting } : {}),
    };
  };
}

export function createControlTools(deps: AgentControlDeps): AgentToolDef[] {
  const { access, leases, control, ports } = deps;
  const { guarded, noSession } = createGate(deps);
  const queue = new SerialQueue();
  const held = new Map<string, HeldInput>();
  /** Which thread opened which session (memory only): a thread may disconnect what it opened, and no more than four at a time. */
  const openedBy = deps.registry ?? new AgentSessionRegistry();

  const sessionOf = (key: string): AgentSessionView | undefined => ports.sessions.list().find((s) => s.key === key);
  /** For the owner's audit only: which connection a session belongs to, whatever the grant says. */
  const profileOf = (key: string): string | null => sessionOf(key)?.profileId ?? null;

  /** The session and its profile when the owner allows driving it (input or above); the same error for missing and not allowed. */
  function controllable(key: string): { session: AgentSessionView; profileId: string } {
    const session = sessionOf(key);
    if (session === undefined || session.profileId === undefined || !access.check(session.profileId, "input").ok) throw noSession();
    if (session.state === "closed") throw new ToolError("session_closed", "this session has ended");
    return { session, profileId: session.profileId };
  }

  /** The lease check as an error; also tells the caller when the lease is gone for any reason. */
  function leaseGeneration(key: string, ctx: AgentCallContext, leaseId: string): number {
    const check = leases.check(key, ctx.threadId, leaseId);
    if (!check.ok) throw new ToolError(check.code, check.code === "lease_expired" ? "the lease ran out; take control again" : check.code === "no_lease" ? "no lease is held on this session: use remote_control_acquire" : "this lease is not yours");
    return check.generation;
  }

  // When a lease ends: whatever the agent left pressed is released (after the write in flight, never before), and the
  // ops still waiting find their lease gone and drop themselves.
  leases.onEnd((end: LeaseEnd) => {
    const input = held.get(end.sessionKey);
    const events = input === undefined ? [] : input.releaseEvents();
    held.delete(end.sessionKey);
    if (events.length > 0) void queue.run(end.sessionKey, () => true, () => control.rdpWrite(end.sessionKey, events)).catch(() => undefined);
  });
  // A grant lowered below `input` ends the leases that depended on it.
  access.onChange(() => {
    leases.endWhere((key) => {
      const profileId = sessionOf(key)?.profileId;
      return profileId === undefined || !access.check(profileId, "input").ok;
    }, "revoked");
  });

  /** Runs `write` in the session's queue if, when its turn comes, the same lease still holds, the grant is intact and the call was not aborted. */
  async function driven(key: string, ctx: AgentCallContext, leaseId: string, profileId: string, write: () => Promise<void>): Promise<void> {
    const generation = leaseGeneration(key, ctx, leaseId);
    const onAbort = () => void leases.endSession(key, "thread_gone");
    ctx.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const stillValid = () => ctx.signal?.aborted !== true && access.check(profileId, "input").ok && leases.check(key, ctx.threadId, leaseId).ok && leases.owner(key).generation === generation;
      const outcome = await queue.run(key, stillValid, write);
      if (!outcome.ran) throw new ToolError("lease_lost", "the owner took the session back, or the lease ended, before this input was sent; nothing was sent");
    } finally {
      ctx.signal?.removeEventListener("abort", onAbort);
    }
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
          const { session } = controllable(params.sessionId);
          let result = leases.acquire(params.sessionId, ctx.threadId, params.seconds);
          if (!result.ok && result.code === "already_held_by_you") {
            const owner = leases.owner(params.sessionId);
            if (owner.kind === "agent") result = leases.renew(params.sessionId, ctx.threadId, owner.leaseId, params.seconds);
          }
          if (!result.ok) throw new ToolError(result.code, result.code === "held_by_another_thread" ? "another agent holds this session" : "this lease is not yours");
          return {
            content: [
              json({
                sessionId: session.key,
                leaseId: result.leaseId,
                expiresAt: new Date(result.expiresAt).toISOString(),
                ttlSeconds: Math.min(LEASE_MAX_SECONDS, Math.max(LEASE_MIN_SECONDS, params.seconds ?? LEASE_DEFAULT_SECONDS)),
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
        "A new host key, a changed key or a certificate is decided by the owner on the Remote Hub page: the result then says waitingForOwner and the session stays connecting until the owner answers. " +
        `At most ${MAX_SESSIONS_PER_THREAD} open sessions per thread.`,
      parameters: z.object({ connectionId: connectionIdSchema }).strict(),
      execute: (params, ctx) =>
        guarded("remote_connect", ctx, { profileId: params.connectionId }, async () => {
          const profile = ports.profiles.get(params.connectionId);
          if (profile === null || !access.check(params.connectionId, "connect").ok) throw new ToolError("agent_access_denied", "the owner has not allowed agents to use this connection");
          if (profile.credentialRef === null) throw new ToolError("needs_saved_credential", "this connection has no saved credential; the owner must save one on the Remote Hub page first");
          const live = ports.sessions.list().filter((s) => s.state !== "closed" && openedBy.threadOf(s.key) === ctx.threadId).length;
          if (live >= MAX_SESSIONS_PER_THREAD) throw new ToolError("too_many_sessions", `this thread already has ${MAX_SESSIONS_PER_THREAD} open sessions: disconnect one first`);
          const { sessionKey } = await control.connect(profile.id);
          openedBy.mark(sessionKey, ctx.threadId);
          const waiting = control.waitingForOwner(sessionKey);
          return { content: [json({ sessionId: sessionKey, connectionId: profile.id, state: sessionOf(sessionKey)?.state ?? "connecting", ...(waiting.length > 0 ? { waitingForOwner: waiting } : {}) })] };
        }),
    }),
    def({
      name: "remote_disconnect",
      description: CANNOT + "Closes a session this thread opened with remote_connect. Cannot close sessions the owner or another thread opened.",
      parameters: z.object({ sessionId: sessionIdSchema }).strict(),
      execute: (params, ctx) =>
        guarded("remote_disconnect", ctx, { sessionKey: params.sessionId, profileId: profileOf(params.sessionId) }, async () => {
          controllable(params.sessionId);
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
        "Types into a terminal session you hold the lease on: plain text (no control characters) and named keys (Enter, Tab, Escape, Backspace, arrows, Home, End, Ctrl-C/D/Z/L), in order. " +
        `At most ${TERMINAL_INPUT_MAX_BYTES} bytes per call. Cannot send raw bytes or escape sequences, and cannot type into a desktop session. The audit keeps the length and a short hash of what you send, not the text.`,
      parameters: z.object({ sessionId: sessionIdSchema, leaseId: leaseIdSchema, actions: z.array(terminalActionSchema).min(1).max(40) }).strict(),
      execute: async (params, ctx) => {
        const bytes = terminalBytes(params.actions);
        if (bytes.length > TERMINAL_INPUT_MAX_BYTES) return errorResult("input_too_large", `more than ${TERMINAL_INPUT_MAX_BYTES} bytes in one call`);
        const detail = `len ${bytes.length} sha ${await shortHash(JSON.stringify(params.actions))}`;
        return guarded("remote_terminal_input", ctx, { sessionKey: params.sessionId, profileId: profileOf(params.sessionId), detailMode: "hash", detail }, async () => {
          const { session, profileId } = controllable(params.sessionId);
          if (session.kind === "rdp") throw new ToolError("not_a_terminal", "this is a desktop session: use remote_rdp_input");
          await driven(params.sessionId, ctx, params.leaseId, profileId, () => control.terminalWrite(params.sessionId, bytes));
          return { content: [json({ sessionId: params.sessionId, sentBytes: bytes.length })] };
        });
      },
    }),
    def({
      name: "remote_rdp_input",
      description:
        CANNOT +
        "Sends typed actions to a desktop (RDP) session you hold the lease on: mouse_move, click, mouse_button, wheel, key (a KeyboardEvent.code such as Enter or KeyA), text and ctrl_alt_del. " +
        "Positions are desktop pixels. Any action with a position needs `observed` (frameId, width, height from remote_rdp_screenshot): a changed desktop size or a frame newer than you saw is refused as stale_geometry. " +
        "Keys and buttons left down are released when your control ends. Cannot send raw events or type into a terminal session.",
      parameters: z.object({ sessionId: sessionIdSchema, leaseId: leaseIdSchema, observed: observedSchema.optional(), actions: rdpActionsSchema }).strict(),
      execute: async (params, ctx) => {
        const actions = params.actions as RdpAction[];
        const detail = `len ${JSON.stringify(actions).length} sha ${await shortHash(JSON.stringify(actions))}`;
        return guarded("remote_rdp_input", ctx, { sessionKey: params.sessionId, profileId: profileOf(params.sessionId), detailMode: "hash", detail }, async () => {
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
          await driven(params.sessionId, ctx, params.leaseId, profileId, async () => {
            let input = held.get(params.sessionId);
            if (input === undefined) {
              input = new HeldInput();
              held.set(params.sessionId, input);
            }
            input.apply(events.events);
            await control.rdpWrite(params.sessionId, events.events);
          });
          return { content: [json({ sessionId: params.sessionId, sentEvents: events.events.length })] };
        });
      },
    }),
  ];
  return tools;
}
