// Catalogue logic over saved profiles (stage 3a): search, filter, grouping,
// the status derived from live sessions, and the open parameters. Pure.
import type { Profile } from "./profile.ts";
import type { SessionInfo, SshTarget } from "./rpc.ts";

export interface CatalogueFilter {
  query: string;
  protocol: "all" | "ssh" | "rdp";
  favoritesOnly: boolean;
}

export function filterProfiles(profiles: Profile[], filter: CatalogueFilter): Profile[] {
  const needle = filter.query.trim().toLowerCase();
  return profiles.filter((p) => {
    if (filter.protocol !== "all" && p.protocol !== filter.protocol) return false;
    if (filter.favoritesOnly && !p.favorite) return false;
    if (needle === "") return true;
    const haystack = [p.name, p.host, p.username ?? "", p.group ?? "", ...p.tags];
    return haystack.some((value) => value.toLowerCase().includes(needle));
  });
}

export interface ProfileGroup {
  /** null = ungrouped. */
  group: string | null;
  profiles: Profile[];
}

const byName = (a: string, b: string) => a.localeCompare(b, "en", { sensitivity: "base" });

/** Groups by name (ungrouped last); inside a group favourites first, then by name. */
export function groupProfiles(profiles: Profile[]): ProfileGroup[] {
  const groups = new Map<string | null, Profile[]>();
  for (const p of profiles) {
    const list = groups.get(p.group) ?? [];
    list.push(p);
    groups.set(p.group, list);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a === null ? 1 : b === null ? -1 : byName(a, b)))
    .map(([group, list]) => ({
      group,
      profiles: [...list].sort((a, b) => Number(b.favorite) - Number(a.favorite) || byName(a.name, b.name)),
    }));
}

export interface ProfileStatus {
  state: "idle" | "connecting" | "open";
  sessions: number;
}

/** Derived from the live sessions; never stored. */
export function profileStatus(profileId: string, sessions: Array<SessionInfo & { profileId?: string }>): ProfileStatus {
  const mine = sessions.filter((s) => s.profileId === profileId && s.state !== "closed");
  if (mine.length === 0) return { state: "idle", sessions: 0 };
  const open = mine.some((s) => (s.kind === "rdp" ? s.rdp?.state === "desktop_ready" : s.state === "running"));
  return { state: open ? "open" : "connecting", sessions: mine.length };
}

export const DEFAULT_RDP_PORT = 3389;
/** The PVE API port. */
export const DEFAULT_PVE_PORT = 8006;

/** The port a profile means when it names none. */
export function defaultPortOf(protocol: "ssh" | "rdp" | "pve"): number {
  return protocol === "rdp" ? DEFAULT_RDP_PORT : protocol === "pve" ? DEFAULT_PVE_PORT : 22;
}

/** The fields of an SSH open for a profile. Authentication stays with OpenSSH. */
export function profileToSshTarget(p: Profile): SshTarget {
  const target: SshTarget = { host: p.host, extraOptions: [] };
  if (p.username !== null) target.user = p.username;
  if (p.port !== null) target.port = p.port;
  if (p.authType === "key" && p.identityFile !== null) target.identityFile = p.identityFile;
  return target;
}

export interface RdpFormValues {
  host: string;
  port: number;
  username: string;
  domain: string | null;
  width: number | null;
  height: number | null;
  /** The profile's saved credential; the password itself is never here. */
  credentialRef: string | null;
}

/** The RDP form values for a profile; the password is typed at connect time. */
export function profileToRdpForm(p: Profile): RdpFormValues {
  return {
    host: p.host,
    port: p.port ?? DEFAULT_RDP_PORT,
    username: p.username ?? "",
    domain: p.domain,
    width: p.rdpWidth,
    height: p.rdpHeight,
    credentialRef: p.credentialRef,
  };
}
