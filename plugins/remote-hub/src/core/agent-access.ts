// Per-profile agent access (stage 4a). The owner sets a level on the human page; every agent tool call asks
// `check` again, so there is no cached capability. Levels are ordered none < observe < input < exec, and
// "connect" is allowed from `input` up. A grant applies to agents in ANY thread of this BB.

export const AGENT_LEVELS = ["none", "observe", "input", "exec"] as const;
export type AgentLevel = (typeof AGENT_LEVELS)[number];
export type AgentAction = "observe" | "connect" | "input" | "exec";

/** The lowest level that allows each action. */
const NEEDED: Record<AgentAction, AgentLevel> = { observe: "observe", connect: "input", input: "input", exec: "exec" };

export interface AgentGrant {
  profileId: string;
  level: AgentLevel;
  /** Store the text of exec commands in the audit (default off). Only meaningful at `exec`. */
  recordCommands: boolean;
  updatedAt: string;
}

export interface AgentGrantStore {
  all(): AgentGrant[];
  get(profileId: string): AgentGrant | null;
  put(grant: AgentGrant): void;
  remove(profileId: string): boolean;
  /** Remove every grant; the number removed. */
  clear(): number;
}

export type AgentCheck = { ok: true; grant: AgentGrant } | { ok: false; code: "agent_access_denied" };

export interface AgentAccessChange {
  /** null = every profile (revoke all). */
  profileId: string | null;
  level: AgentLevel;
}

export class AgentAccessError extends Error {
  constructor(
    readonly code: "profile_not_found" | "invalid_level",
    message: string,
  ) {
    super(code + ": " + message);
  }
}

export interface AgentAccessDeps {
  store: AgentGrantStore;
  profiles: { has(id: string): boolean };
  now: () => Date;
}

export class AgentAccessBook {
  private readonly listeners: Array<(change: AgentAccessChange) => void> = [];
  constructor(private readonly deps: AgentAccessDeps) {}

  /** Called after a grant was lowered or removed: whatever depends on it (a lease) must end. */
  onChange(cb: (change: AgentAccessChange) => void): void {
    this.listeners.push(cb);
  }

  /** Grants of profiles that still exist. */
  list(): AgentGrant[] {
    return this.deps.store.all().filter((g) => this.deps.profiles.has(g.profileId));
  }

  get(profileId: string): AgentGrant {
    const row = this.deps.store.get(profileId);
    return row !== null && this.deps.profiles.has(profileId) ? row : { profileId, level: "none", recordCommands: false, updatedAt: "" };
  }

  /** The same answer for "no such profile" and "not granted": a caller learns nothing about the catalogue. */
  check(profileId: string, action: AgentAction): AgentCheck {
    const grant = this.get(profileId);
    return AGENT_LEVELS.indexOf(grant.level) >= AGENT_LEVELS.indexOf(NEEDED[action]) && grant.level !== "none"
      ? { ok: true, grant }
      : { ok: false, code: "agent_access_denied" };
  }

  set(profileId: string, level: AgentLevel, recordCommands: boolean): AgentGrant {
    if (!(AGENT_LEVELS as readonly string[]).includes(level)) throw new AgentAccessError("invalid_level", "not an access level");
    if (!this.deps.profiles.has(profileId)) throw new AgentAccessError("profile_not_found", "no such profile");
    const before = this.get(profileId).level;
    const grant: AgentGrant = { profileId, level, recordCommands: level === "exec" && recordCommands, updatedAt: this.deps.now().toISOString() };
    if (level === "none") this.deps.store.remove(profileId);
    else this.deps.store.put(grant);
    if (AGENT_LEVELS.indexOf(level) < AGENT_LEVELS.indexOf(before)) this.notify({ profileId, level });
    return grant;
  }

  /** Switch every grant off at once; the number of grants removed. */
  revokeAll(): number {
    const removed = this.deps.store.clear();
    this.notify({ profileId: null, level: "none" });
    return removed;
  }

  private notify(change: AgentAccessChange): void {
    for (const cb of this.listeners) cb(change);
  }
}
