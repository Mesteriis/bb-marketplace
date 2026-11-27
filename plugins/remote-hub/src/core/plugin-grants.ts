// What the owner allowed OTHER plugins to do with a saved SSH connection over SFTP (see sftp-contract.ts). A grant is
// (plugin id, profile id, level) and lasts until the owner revokes it; only the owner's page grants, declines and revokes.
// A plugin can only ASK. Every operation asks `check` again: there is no cached capability. Pure; the store is injected.
import { levelAllows, type SftpLevel } from "./sftp-contract.ts";

export interface PluginGrantRow {
  pluginId: string;
  profileId: string;
  /** The level in force; null when nothing is granted. */
  level: SftpLevel | null;
  grantedAt: string | null;
  /** The id a plugin gets back when it asks for what it already holds; set with the grant. */
  grantId: string | null;
  /** Set when the owner took a grant away; cleared by the next request or grant. */
  revokedAt: string | null;
  /** What the plugin is asking for and the owner has not answered yet. */
  request: { requestId: string; level: SftpLevel; reason: string | null; requestedAt: string } | null;
}

export interface PluginGrantStore {
  all(): PluginGrantRow[];
  get(pluginId: string, profileId: string): PluginGrantRow | null;
  put(row: PluginGrantRow): void;
  remove(pluginId: string, profileId: string): boolean;
}

export type Consent = "none" | "pending" | "granted" | "revoked";
export type PluginCheck = { ok: true; level: SftpLevel } | { ok: false; code: "consent_required" | "consent_revoked" };

export class PluginGrantError extends Error {
  constructor(
    readonly code: "profile_not_found",
    detail: string,
  ) {
    super(`${code}: ${detail}`);
  }
}

export interface PluginGrantDeps {
  store: PluginGrantStore;
  now: () => Date;
  newId: () => string;
  profileExists: (profileId: string) => boolean;
  /** Told after every change, with identifiers only: channels are closed on "revoked", the page and the plugin are notified. */
  onChange?: (change: { pluginId: string; profileId: string; state: Consent }) => void;
}

export class PluginGrantBook {
  constructor(private readonly deps: PluginGrantDeps) {}

  private row(pluginId: string, profileId: string): PluginGrantRow {
    return this.deps.store.get(pluginId, profileId) ?? { pluginId, profileId, level: null, grantedAt: null, grantId: null, revokedAt: null, request: null };
  }

  private save(row: PluginGrantRow): void {
    if (row.level === null && row.revokedAt === null && row.request === null) this.deps.store.remove(row.pluginId, row.profileId);
    else this.deps.store.put(row);
    this.deps.onChange?.({ pluginId: row.pluginId, profileId: row.profileId, state: consentOfRow(row).consent });
  }

  consentOf(pluginId: string, profileId: string): { consent: Consent; level: SftpLevel | null } {
    return consentOfRow(this.row(pluginId, profileId));
  }

  /** Asked before every open and every operation. */
  check(pluginId: string, profileId: string, needed: SftpLevel): PluginCheck {
    const row = this.row(pluginId, profileId);
    if (row.level !== null && levelAllows(row.level, needed)) return { ok: true, level: row.level };
    return { ok: false, code: row.level === null && row.revokedAt !== null && row.request === null ? "consent_revoked" : "consent_required" };
  }

  /** A plugin asks. Nothing is granted here. */
  request(pluginId: string, profileId: string, level: SftpLevel, reason?: string): { requestId: string; state: "pending" | "granted" } {
    if (!this.deps.profileExists(profileId)) throw new PluginGrantError("profile_not_found", "no such connection");
    const row = this.row(pluginId, profileId);
    if (row.level !== null && levelAllows(row.level, level)) return { requestId: row.grantId ?? this.deps.newId(), state: "granted" };
    if (row.request !== null && row.request.level === level) return { requestId: row.request.requestId, state: "pending" };
    const request = { requestId: this.deps.newId(), level, reason: reason === undefined || reason === "" ? null : reason, requestedAt: this.deps.now().toISOString() };
    this.save({ ...row, revokedAt: null, request });
    return { requestId: request.requestId, state: "pending" };
  }

  /** The owner grants (answering a request or on their own). */
  grant(pluginId: string, profileId: string, level: SftpLevel): void {
    if (!this.deps.profileExists(profileId)) throw new PluginGrantError("profile_not_found", "no such connection");
    const answered = this.row(pluginId, profileId).request;
    this.save({ pluginId, profileId, level, grantedAt: this.deps.now().toISOString(), grantId: answered?.requestId ?? this.deps.newId(), revokedAt: null, request: null });
  }

  /** The owner says no to a request. What was granted before stays. */
  decline(requestId: string): boolean {
    const row = this.deps.store.all().find((r) => r.request?.requestId === requestId);
    if (row === undefined) return false;
    this.save({ ...row, request: null });
    return true;
  }

  /** The owner takes a grant away. False when there was none. */
  revoke(pluginId: string, profileId: string): boolean {
    const row = this.deps.store.get(pluginId, profileId);
    if (row === null || row.level === null) return false;
    this.save({ ...row, level: null, grantedAt: null, grantId: null, revokedAt: this.deps.now().toISOString(), request: null });
    return true;
  }

  /** Ends every grant and drops every pending request; the number of grants ended. */
  revokeAll(): number {
    let ended = 0;
    for (const row of this.deps.store.all()) {
      if (row.level !== null) {
        ended += 1;
        this.save({ ...row, level: null, grantedAt: null, grantId: null, revokedAt: this.deps.now().toISOString(), request: null });
      } else if (row.request !== null) this.save({ ...row, request: null });
    }
    return ended;
  }

  forgetProfile(profileId: string): void {
    for (const row of this.deps.store.all()) if (row.profileId === profileId) this.deps.store.remove(row.pluginId, row.profileId);
  }

  /** What one plugin holds or was refused, for `hub_sftp_grants`. */
  list(pluginId: string): Array<{ profileId: string; level: SftpLevel; state: "pending" | "granted" | "revoked"; grantedAt: string | null }> {
    const out: Array<{ profileId: string; level: SftpLevel; state: "pending" | "granted" | "revoked"; grantedAt: string | null }> = [];
    for (const row of this.deps.store.all()) {
      if (row.pluginId !== pluginId) continue;
      if (row.level !== null) out.push({ profileId: row.profileId, level: row.level, state: "granted", grantedAt: row.grantedAt });
      else if (row.request !== null) out.push({ profileId: row.profileId, level: row.request.level, state: "pending", grantedAt: null });
      else if (row.revokedAt !== null) out.push({ profileId: row.profileId, level: "read", state: "revoked", grantedAt: null });
    }
    return out;
  }

  /** Every grant in force, for the Remote Hub page. */
  granted(): Array<{ pluginId: string; profileId: string; level: SftpLevel; grantedAt: string | null }> {
    const out: Array<{ pluginId: string; profileId: string; level: SftpLevel; grantedAt: string | null }> = [];
    for (const r of this.deps.store.all()) if (r.level !== null) out.push({ pluginId: r.pluginId, profileId: r.profileId, level: r.level, grantedAt: r.grantedAt });
    return out;
  }

  /** The requests waiting for the owner, for the Remote Hub page. */
  pending(): Array<{ requestId: string; pluginId: string; profileId: string; level: SftpLevel; reason: string | null; requestedAt: string }> {
    return this.deps.store
      .all()
      .filter((r) => r.request !== null)
      .map((r) => ({ requestId: r.request!.requestId, pluginId: r.pluginId, profileId: r.profileId, level: r.request!.level, reason: r.request!.reason, requestedAt: r.request!.requestedAt }));
  }
}

function consentOfRow(row: PluginGrantRow): { consent: Consent; level: SftpLevel | null } {
  if (row.level !== null) return { consent: "granted", level: row.level };
  if (row.request !== null) return { consent: "pending", level: null };
  if (row.revokedAt !== null) return { consent: "revoked", level: null };
  return { consent: "none", level: null };
}
