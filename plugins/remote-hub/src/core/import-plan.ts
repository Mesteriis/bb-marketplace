// What an import would do, worked out without touching anything (stage 3c): the profile each source
// entry maps to, and, against what was imported before, whether re-importing creates, updates, leaves
// alone, or reports a conflict. Host-free and pure, so a second import of the same source is provably a no-op.
import { profileFieldsSchema, type ProfileFields } from "./profile.ts";
import type { ConfigEntry } from "./ssh-config.ts";
import type { HostCandidate } from "./hosts-file.ts";

/** The part of a profile an import owns. Everything else (name, group, tags, favourite, colour, credential) is the user's. */
export interface ImportedFields {
  host: string;
  port: number | null;
  username: string | null;
  authType: "agent" | "key";
  identityFile: string | null;
}

export interface Candidate {
  /** The entry in its source: the Host alias as written (case matters to ssh), or the host name (lower case). */
  key: string;
  /** What to call the profile. */
  name: string;
  imported: ImportedFields;
  /** False: the entry depends on configuration that text alone cannot resolve; the profile keeps using the user's ssh config. */
  resolved: boolean;
  /** Why it is not resolved (proxy, match, tokens, canonicalize, host-key-alias), or "multiple-identities" (informational). */
  flags: string[];
  /** The entry cannot become a profile at all. */
  skip: string | null;
}

const BLOCKING = new Set(["proxy", "match", "tokens", "canonicalize", "host-key-alias", "incomplete"]);

/** Why an entry cannot become a profile (null when it can). */
export function skipReason(f: ImportedFields, name: string): string | null {
  const parsed = profileFieldsSchema.safeParse({ ...toProfileFields(f, name, "Imported"), credentialRef: null });
  return parsed.success ? null : (parsed.error.issues[0]?.message ?? "not a valid profile");
}

export function toProfileFields(f: ImportedFields, name: string, group: string): ProfileFields {
  return {
    name,
    protocol: "ssh",
    group,
    tags: ["imported"],
    favorite: false,
    color: null,
    host: f.host,
    port: f.port,
    username: f.username,
    domain: null,
    authType: f.authType,
    identityFile: f.identityFile,
    credentialRef: null,
    rdpWidth: null,
    rdpHeight: null,
  };
}

/**
 * A resolved entry becomes an explicit destination (host, port, user, key), so a saved secret can be bound to it.
 * An unresolved one keeps its ALIAS as the host and carries no port, user or key: OpenSSH, reading the user's
 * own configuration, decides where it goes.
 */
export function candidateFromConfigEntry(entry: ConfigEntry): Candidate {
  const blocking = entry.flags.filter((f) => BLOCKING.has(f));
  const resolved = blocking.length === 0;
  const flags = [...entry.flags];
  let imported: ImportedFields;
  if (resolved) {
    const [first, ...more] = entry.identityFiles;
    if (more.length > 0) flags.push("multiple-identities");
    const identityFile = first !== undefined && first.startsWith("/") ? first : null;
    imported = {
      host: (entry.hostName ?? entry.alias).toLowerCase(),
      port: entry.port,
      username: entry.user,
      authType: identityFile !== null ? "key" : "agent",
      identityFile,
    };
  } else {
    imported = { host: entry.alias, port: null, username: null, authType: "agent", identityFile: null };
  }
  return { key: entry.alias, name: entry.alias, imported, resolved, flags: flags.sort(), skip: skipReason(imported, entry.alias) };
}

export function candidateFromHost(host: HostCandidate): Candidate {
  const imported: ImportedFields = { host: host.name.toLowerCase(), port: null, username: null, authType: "agent", identityFile: null };
  return { key: host.name.toLowerCase(), name: host.name, imported, resolved: true, flags: [], skip: skipReason(imported, host.name) };
}

/** What was imported before, per entry. */
export interface ImportLink {
  profileId: string;
  sourceId: string;
  key: string;
  /** The imported fields as they were when last applied. */
  imported: ImportedFields;
  resolved: boolean;
  flags: string[];
  stale: boolean;
}

export type ImportAction = "create" | "update" | "unchanged" | "conflict" | "deleted-locally" | "skip";

export interface PlannedItem {
  candidate: Candidate;
  action: ImportAction;
  /** The existing profile and link, when there are any. */
  profileId: string | null;
}

export const sameImported = (a: ImportedFields, b: ImportedFields): boolean =>
  a.host === b.host && a.port === b.port && a.username === b.username && a.authType === b.authType && a.identityFile === b.identityFile;

export function importedOf(p: { host: string; port: number | null; username: string | null; authType: string; identityFile: string | null }): ImportedFields {
  return { host: p.host, port: p.port, username: p.username, authType: p.authType === "key" ? "key" : "agent", identityFile: p.identityFile };
}

/**
 * Re-import rules. `current` returns the imported subset of a profile as it is NOW (null when the profile is gone).
 *   no link                         -> create
 *   profile gone                    -> deleted-locally (never resurrected by a plain re-import)
 *   source value == last applied    -> unchanged (whatever was edited here is left alone)
 *   source changed, not edited here -> update
 *   source changed, edited here     -> conflict (nothing is overwritten)
 */
export function planImport(candidates: Candidate[], links: ImportLink[], current: (profileId: string) => ImportedFields | null): { items: PlannedItem[]; stale: ImportLink[] } {
  const byKey = new Map(links.map((l) => [l.key, l]));
  const seen = new Set<string>();
  const items = candidates.map((candidate): PlannedItem => {
    seen.add(candidate.key);
    if (candidate.skip !== null) return { candidate, action: "skip", profileId: null };
    const link = byKey.get(candidate.key);
    if (link === undefined) return { candidate, action: "create", profileId: null };
    const now = current(link.profileId);
    if (now === null) return { candidate, action: "deleted-locally", profileId: link.profileId };
    if (sameImported(candidate.imported, link.imported) && candidate.resolved === link.resolved) return { candidate, action: "unchanged", profileId: link.profileId };
    if (!sameImported(now, link.imported)) return { candidate, action: "conflict", profileId: link.profileId };
    return { candidate, action: "update", profileId: link.profileId };
  });
  return { items, stale: links.filter((l) => !seen.has(l.key) && !l.stale) };
}
