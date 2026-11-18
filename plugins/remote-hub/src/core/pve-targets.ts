// Discovery of Proxmox guests (host-free): turns what the helper answered, or how it failed, into what the page and
// the agent tool show. One connection failing never hides the others, an outcome is always one of a closed set, and
// the last good list is served (with its age) only when the failure says nothing about the account itself.
import { type PveGuest, type PveNode, type PvePlan, type PveSteps } from "./pve-protocol.ts";

export const PVE_OUTCOMES = ["ok", "empty", "no_permission", "login_failed", "unreachable", "tls_untrusted", "cert_changed", "tfa_required", "no_credential", "error"] as const;
export type PveOutcome = (typeof PVE_OUTCOMES)[number];

/** What a discovery request produced: the lists, or a failure code (the helper's closed set) with the certificate it saw. */
export type PveAnswer =
  | { ok: true; version: string | null; nodes: PveNode[]; guests: PveGuest[] }
  | { ok: false; code: string; message: string; fingerprint: string | null };

/** What mode 1 answered: the plan (dry run) or the applied steps, or the failure with the certificate it saw and what each step did. */
export type PveProvisionAnswer =
  | { ok: true; kind: "plan"; plan: PvePlan }
  | { ok: true; kind: "applied"; steps: PveSteps }
  | { ok: false; code: string; message: string; fingerprint: string | null; steps: PveSteps | null };

export interface PveGuestView {
  /** Identity of a guest: the PVE profile and the VMID. The node is a location, kept apart, and is looked up again before opening. */
  key: string;
  profileId: string;
  vmid: number;
  name: string;
  kind: "qemu" | "lxc";
  node: string;
  status: string;
  template: boolean;
  console: { available: boolean; reason: string | null };
  /** The SSH/RDP profile the owner linked to this guest, if any. Never guessed from an address. */
  linkedProfileId: string | null;
}

export interface PveConnectionView {
  profileId: string;
  profileName: string;
  outcome: PveOutcome;
  /** What to tell the owner, with the action to take; null when the outcome is ok. */
  message: string | null;
  /** The certificate the server presented, for tls_untrusted and cert_changed. */
  fingerprint: string | null;
  version: string | null;
  nodes: PveNode[];
  guests: PveGuestView[];
  /** When the lists were read (ISO). */
  fetchedAt: string | null;
  /** Set when the lists are the last good ones and the live read failed. */
  stale: { ageSeconds: number } | null;
}

export const guestKey = (profileId: string, vmid: number): string => `${profileId}/${vmid}`;

/** Why a guest's console can or cannot be opened right now. */
export function consoleAvailability(g: { kind: "qemu" | "lxc"; status: string; template: boolean }): { available: boolean; reason: string | null } {
  if (g.template) return { available: false, reason: "a template has no console" };
  if (g.status !== "running") return { available: false, reason: `the guest is ${g.status}; start it in Proxmox first (Remote Hub never starts guests)` };
  return { available: true, reason: null };
}

const FAILURE_OUTCOME: Record<string, PveOutcome> = {
  login_failed: "login_failed",
  no_permission: "no_permission",
  unreachable: "unreachable",
  timeout: "unreachable",
  tls_untrusted: "tls_untrusted",
  cert_changed: "cert_changed",
  tfa_required: "tfa_required",
  no_credential: "no_credential",
};

export function outcomeOfFailure(code: string): PveOutcome {
  return FAILURE_OUTCOME[code] ?? "error";
}

const ADVICE: Record<Exclude<PveOutcome, "ok" | "empty">, string> = {
  no_permission: "The account may not list guests. Give it VM.Audit (and VM.Console to open consoles) in Proxmox, or run the restricted-user setup again.",
  login_failed: "Proxmox refused the login. Check the user and password (or token) in this connection; Remote Hub does not retry a refused login.",
  unreachable: "The Proxmox endpoint did not answer. Check the address, the port and your network.",
  tls_untrusted: "The server certificate is not trusted. Compare the fingerprint with the one Proxmox shows, then confirm it to trust this server.",
  cert_changed: "The server certificate is not the one you confirmed before. If you did not replace it, do not continue.",
  tfa_required: "This account asks for a second factor, which Remote Hub does not support. Use the restricted-user setup or an account without one.",
  no_credential: "This connection has no saved password or token yet. Add one in the connection's settings.",
  error: "Proxmox could not be read.",
};

/** The action text for an outcome. `detail` is the helper's fixed local message (never an upstream body) and is shown only for `error`. */
export function adviceFor(outcome: PveOutcome, detail: string | null): string | null {
  if (outcome === "ok" || outcome === "empty") return null;
  const base = ADVICE[outcome];
  return detail !== null && detail !== "" && outcome === "error" ? `${base} (${detail})` : base;
}

export interface PveCacheEntry {
  at: Date;
  version: string | null;
  nodes: PveNode[];
  guests: PveGuest[];
}

/** Failures that say nothing about the account or the certificate: the last good list may still be shown, marked stale. */
const STALE_OK: ReadonlySet<PveOutcome> = new Set<PveOutcome>(["unreachable", "error"]);

export function viewOf(args: {
  profile: { id: string; name: string };
  answer: PveAnswer;
  cached: PveCacheEntry | null;
  links: ReadonlyMap<number, string>;
  now: Date;
}): { view: PveConnectionView; cache: PveCacheEntry | null } {
  const { profile, answer, cached, links, now } = args;
  const guestViews = (guests: PveGuest[]): PveGuestView[] =>
    guests.map((g) => ({
      key: guestKey(profile.id, g.vmid),
      profileId: profile.id,
      vmid: g.vmid,
      name: g.name,
      kind: g.kind,
      node: g.node,
      status: g.status,
      template: g.template,
      console: consoleAvailability(g),
      linkedProfileId: links.get(g.vmid) ?? null,
    }));
  if (answer.ok) {
    const entry: PveCacheEntry = { at: now, version: answer.version, nodes: answer.nodes, guests: answer.guests };
    return {
      cache: entry,
      view: {
        profileId: profile.id,
        profileName: profile.name,
        outcome: answer.guests.length === 0 ? "empty" : "ok",
        message: null,
        fingerprint: null,
        version: answer.version,
        nodes: answer.nodes,
        guests: guestViews(answer.guests),
        fetchedAt: now.toISOString(),
        stale: null,
      },
    };
  }
  const outcome = outcomeOfFailure(answer.code);
  const serveStale = cached !== null && STALE_OK.has(outcome);
  return {
    cache: cached,
    view: {
      profileId: profile.id,
      profileName: profile.name,
      outcome,
      message: adviceFor(outcome, answer.message),
      fingerprint: answer.fingerprint,
      version: serveStale ? cached.version : null,
      nodes: serveStale ? cached.nodes : [],
      guests: serveStale ? guestViews(cached.guests) : [],
      fetchedAt: serveStale ? cached.at.toISOString() : null,
      stale: serveStale ? { ageSeconds: Math.max(0, Math.round((now.getTime() - cached.at.getTime()) / 1000)) } : null,
    },
  };
}

/** Case-insensitive match on name, node and kind, and on the VMID as a prefix. An empty query keeps everything. */
export function searchGuests<T extends { name: string; vmid: number; node: string; kind: string }>(guests: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (q === "") return guests;
  return guests.filter((g) => g.name.toLowerCase().includes(q) || String(g.vmid).startsWith(q) || g.node.toLowerCase().includes(q) || g.kind === q);
}

export interface PveDiscoveryDeps {
  /**
   * The pve profiles that can be asked: all saved profiles of that protocol. `endpoint` and `revision` identify what an answer
   * was read for: an answer for an endpoint or revision that has since changed is dropped, never shown or pinned.
   */
  profiles: () => Array<{ id: string; name: string; credentialRef: string | null; endpoint: string; revision: string }>;
  /** Asks one connection. May throw; a throw becomes outcome `error` for that connection only. */
  fetch: (profileId: string) => Promise<PveAnswer>;
  links: (profileId: string) => ReadonlyMap<number, string>;
  now: () => Date;
  /** How long a good answer is served without asking again (ms). */
  ttlMs?: number;
}

export class PveDiscovery {
  private readonly cache = new Map<string, PveCacheEntry>();
  private readonly views = new Map<string, PveConnectionView>();
  private readonly inflight = new Map<string, Promise<PveConnectionView>>();
  /** The certificate each connection last presented in a refusal, with what it was read for: a pin is accepted only for that one. */
  private readonly presented = new Map<string, { fingerprint: string; endpoint: string; revision: string }>();
  /** Bumped by `forget`: an answer that was already on its way when the connection was forgotten is dropped. */
  private readonly generation = new Map<string, number>();

  constructor(private readonly deps: PveDiscoveryDeps) {}

  /** The certificate the last refusal of this connection showed, only while the connection is still what it was read as. */
  lastPresented(profileId: string): string | null {
    const entry = this.presented.get(profileId);
    const current = this.deps.profiles().find((p) => p.id === profileId);
    if (entry === undefined || current === undefined || current.endpoint !== entry.endpoint || current.revision !== entry.revision) return null;
    return entry.fingerprint;
  }

  forget(profileId: string): void {
    this.cache.delete(profileId);
    this.views.delete(profileId);
    this.presented.delete(profileId);
    this.generation.set(profileId, (this.generation.get(profileId) ?? 0) + 1);
  }

  /** Every PVE connection (or the named ones), asked together; each view stands alone. */
  async targets(opts: { profileIds?: string[]; refresh?: boolean } = {}): Promise<PveConnectionView[]> {
    const all = this.deps.profiles();
    const wanted = opts.profileIds === undefined ? all : all.filter((p) => opts.profileIds?.includes(p.id));
    return await Promise.all(wanted.map((p) => this.one(p, opts.refresh === true)));
  }

  private one(profile: { id: string; name: string; credentialRef: string | null; endpoint: string; revision: string }, refresh: boolean): Promise<PveConnectionView> {
    const existing = this.inflight.get(profile.id);
    if (existing !== undefined) return existing;
    const ttl = this.deps.ttlMs ?? 30_000;
    const prior = this.views.get(profile.id);
    const cached = this.cache.get(profile.id) ?? null;
    if (!refresh && prior !== undefined && prior.stale === null && prior.fetchedAt !== null && this.deps.now().getTime() - Date.parse(prior.fetchedAt) < ttl && (prior.outcome === "ok" || prior.outcome === "empty")) {
      return Promise.resolve(prior);
    }
    const generation0 = this.generation.get(profile.id) ?? 0;
    const run = (async (): Promise<PveConnectionView> => {
      let answer: PveAnswer;
      if (profile.credentialRef === null) {
        answer = { ok: false, code: "no_credential", message: "", fingerprint: null };
      } else {
        try {
          answer = await this.deps.fetch(profile.id);
        } catch (error) {
          answer = { ok: false, code: "error", message: error instanceof Error ? error.message.slice(0, 120) : "unknown failure", fingerprint: null };
        }
      }
      // The connection may have been edited or forgotten while Proxmox was being read: such an answer is for something that
      // no longer exists, so nothing of it is kept, shown as current or offered for a pin.
      const now = this.deps.profiles().find((p) => p.id === profile.id);
      if (now === undefined || now.endpoint !== profile.endpoint || now.revision !== profile.revision || (this.generation.get(profile.id) ?? 0) !== generation0) {
        return {
          profileId: profile.id,
          profileName: now?.name ?? profile.name,
          outcome: "error",
          message: "The connection changed while it was being read. Refresh to read it again.",
          fingerprint: null,
          version: null,
          nodes: [],
          guests: [],
          fetchedAt: null,
          stale: null,
        };
      }
      const { view, cache } = viewOf({ profile, answer, cached, links: this.deps.links(profile.id), now: this.deps.now() });
      if (cache !== null) this.cache.set(profile.id, cache);
      this.views.set(profile.id, view);
      if (view.fingerprint !== null) this.presented.set(profile.id, { fingerprint: view.fingerprint, endpoint: profile.endpoint, revision: profile.revision });
      return view;
    })().finally(() => this.inflight.delete(profile.id));
    this.inflight.set(profile.id, run);
    return run;
  }
}
