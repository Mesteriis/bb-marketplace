// The desk: which remote sessions are open, which one or two of them are on screen, and which one the owner is working in.
// Pure state and transitions; the page and BB's sidebar both draw from it. It knows nothing about how a session is connected.

export type DeskSessionKind = "ssh" | "rdp" | "pve-terminal" | "pve-graphics";

export type DeskSessionState = "connecting" | "waiting" | "active" | "lost" | "reconnecting" | "disconnected" | "not_connected" | "error";

/** What a session is a session OF. Two sessions with the same target key are the same thing to the owner. */
export type DeskTarget =
  | { type: "profile"; profileId: string }
  | { type: "pve"; profileId: string; console: "node"; node: string }
  | { type: "pve"; profileId: string; console: "lxc" | "qemu"; vmid: number }
  | { type: "quick"; kind: "ssh" | "rdp"; nonce: number };

export interface DeskSession {
  /** Local id of this entry on the desk (not a helper session id: a reconnect keeps it). */
  id: string;
  kind: DeskSessionKind;
  title: string;
  /** One short line under or beside the title: "LXC 165", "user@host". */
  detail: string;
  target: DeskTarget;
  state: DeskSessionState;
  owner: "human" | "agent";
  /** The automatic reconnect attempt being made (0 when none). */
  attempt: number;
  /** Why it is lost, disconnected or in error; a fixed local text, never server output. */
  reason: string | null;
}

export type DeskLayout = "one" | "two";

export interface DeskState {
  /** In the order they were opened. */
  sessions: readonly DeskSession[];
  /** The ids on screen: at most one in the "one" layout, at most two in "two". */
  shown: readonly string[];
  focus: string | null;
  layout: DeskLayout;
}

export function emptyDesk(): DeskState {
  return { sessions: [], shown: [], focus: null, layout: "one" };
}

export function targetKey(target: DeskTarget): string {
  switch (target.type) {
    case "profile":
      return `profile:${target.profileId}`;
    case "quick":
      return `quick:${target.kind}:${target.nonce}`;
    case "pve":
      return target.console === "node" ? `pve:${target.profileId}:node:${target.node}` : `pve:${target.profileId}:${target.console}:${target.vmid}`;
  }
}

/** Puts `id` on screen and makes it the one being worked in. In two panes a hidden session takes the pane that is not focused. */
export function focusSession(state: DeskState, id: string): DeskState {
  if (!state.sessions.some((s) => s.id === id)) return state;
  if (state.shown.includes(id)) return state.focus === id ? state : { ...state, focus: id };
  if (state.layout === "one" || state.shown.length === 0) return { ...state, shown: [id], focus: id };
  if (state.shown.length === 1) return { ...state, shown: [...state.shown, id], focus: id };
  const keep = state.focus !== null && state.shown.includes(state.focus) ? state.focus : state.shown[0]!;
  return { ...state, shown: [keep, id], focus: id };
}

/** Adds a session and shows it; a target that is already open is focused instead. */
export function openSession(state: DeskState, session: DeskSession): DeskState {
  const key = targetKey(session.target);
  const existing = state.sessions.find((s) => targetKey(s.target) === key);
  if (existing !== undefined) return focusSession(state, existing.id);
  return focusSession({ ...state, sessions: [...state.sessions, session] }, session.id);
}

/** The most recently opened sessions that are not on screen, newest first. */
function hidden(state: DeskState): string[] {
  return state.sessions.map((s) => s.id).filter((id) => !state.shown.includes(id)).reverse();
}

export function setLayout(state: DeskState, layout: DeskLayout): DeskState {
  if (layout === state.layout) return state;
  if (layout === "one") {
    const keep = state.focus ?? state.shown[0] ?? null;
    return { ...state, layout, shown: keep === null ? [] : [keep] };
  }
  const first = state.focus ?? state.shown[0] ?? null;
  if (first === null) return { ...state, layout };
  const second = state.shown.find((id) => id !== first) ?? hidden({ ...state, shown: [first] })[0];
  return { ...state, layout, shown: second === undefined ? [first] : [first, second] };
}

/** Takes a session off the desk. A freed pane is filled by the most recently opened hidden session. */
export function closeSession(state: DeskState, id: string): DeskState {
  if (!state.sessions.some((s) => s.id === id)) return state;
  const sessions = state.sessions.filter((s) => s.id !== id);
  const wasShown = state.shown.includes(id);
  let shown = state.shown.filter((s) => s !== id);
  if (wasShown) {
    const next = hidden({ ...state, sessions, shown })[0];
    if (next !== undefined) shown = [...shown, next];
  }
  const focus = state.focus !== null && state.focus !== id && shown.includes(state.focus) ? state.focus : (shown[0] ?? null);
  return { ...state, sessions, shown, focus };
}

export function patchSession(state: DeskState, id: string, patch: Partial<Pick<DeskSession, "state" | "owner" | "attempt" | "reason" | "title" | "detail" | "kind">>): DeskState {
  if (!state.sessions.some((s) => s.id === id)) return state;
  return { ...state, sessions: state.sessions.map((s) => (s.id === id ? { ...s, ...patch } : s)) };
}

const sameSession = (a: DeskSession, b: DeskSession): boolean =>
  a.kind === b.kind && a.title === b.title && a.detail === b.detail && a.state === b.state && a.owner === b.owner && a.attempt === b.attempt && a.reason === b.reason && targetKey(a.target) === targetKey(b.target);

/**
 * Makes the desk agree with a component that owns some sessions itself (the Proxmox consoles and their tabs): `next` is the
 * whole current list of that group. Kept sessions are updated in place, missing ones are closed, new ones are opened in order.
 */
export function syncGroup(state: DeskState, belongs: (session: DeskSession) => boolean, next: readonly DeskSession[]): DeskState {
  const byId = new Map(next.map((s) => [s.id, s]));
  let result = state;
  for (const s of state.sessions) if (belongs(s) && !byId.has(s.id)) result = closeSession(result, s.id);
  const known = new Set(result.sessions.map((s) => s.id));
  let changed = false;
  const updated = result.sessions.map((s) => {
    const fresh = byId.get(s.id);
    if (fresh === undefined || sameSession(s, fresh)) return s;
    changed = true;
    return fresh;
  });
  if (changed) result = { ...result, sessions: updated };
  for (const s of next) {
    if (known.has(s.id)) continue;
    result = focusSession({ ...result, sessions: [...result.sessions, s] }, s.id);
  }
  return result;
}
