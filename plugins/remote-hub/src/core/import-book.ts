// The import book (stage 3c): sources the user has switched on, a scan that shows what each holds, and an
// import that turns chosen entries into profiles. Nothing is read from a source until the user has switched
// that source on; `ssh -G` is a further per-source switch, off by default. Host-free: files, the agent and
// ssh itself arrive through the `SourceReader` port.
import {
  candidateFromConfigEntry,
  candidateFromHost,
  importedOf,
  planImport,
  toProfileFields,
  type Candidate,
  type ImportAction,
  type ImportLink,
  type ImportedFields,
} from "./import-plan.ts";
import { parseHostsFile } from "./hosts-file.ts";
import type { CredentialBook } from "./credential.ts";
import { profileFieldsOf, type Profile, type Provenance } from "./profile.ts";
import type { ProfileBook } from "./profile-book.ts";
import { PRIVATE_KEY_HEAD_BYTES, classifyPrivateKeyHead, parseAgentList, publicKeyInfo, type AgentKey } from "./ssh-keys.ts";
import { parseSshConfig, type IncludedFile } from "./ssh-config.ts";

export type SourceKind = "ssh-config" | "hosts" | "keys-dir" | "agent";

export interface ImportSource {
  id: string;
  kind: SourceKind;
  /** A file or directory; null for the agent. */
  path: string | null;
  label: string;
  /** Nothing is read from a disabled source. */
  enabled: boolean;
  /** ssh-config only: let `ssh -G` resolve entries (it evaluates the whole config, including Match exec). Off by default. */
  useSshG: boolean;
}

export interface ImportStore {
  sources(): ImportSource[];
  putSource(source: ImportSource): void;
  removeSource(id: string): boolean;
  links(sourceId?: string): ImportLink[];
  putLink(link: ImportLink): void;
  removeLinksOfSource(sourceId: string): void;
}

export interface DirEntry {
  name: string;
  kind: "file" | "dir" | "other";
}

/** The outside world, bounded: every read has a size limit and every path is one the caller chose. */
export interface SourceReader {
  home(): string;
  readText(path: string, maxBytes: number): string | null;
  /** The first `bytes` bytes of a file (private keys are looked at through this and nothing more). */
  readHead(path: string, bytes: number): Uint8Array | null;
  listDir(path: string): DirEntry[] | null;
  /** The files an Include names, refused unless they stay inside the config's own directory. */
  include(configPath: string, pattern: string): IncludedFile[];
  /** `ssh-add -l` output, or null when there is no agent. */
  agentList(): Promise<string | null>;
  /** `ssh -G -F <configPath> -- <alias>` output, or null. */
  sshG(configPath: string, alias: string): Promise<string | null>;
}

export class ImportError extends Error {
  readonly code: string;
  constructor(code: string, message?: string) {
    super(message ?? code);
    this.name = "ImportError";
    this.code = code;
  }
}

export interface ScanItem {
  key: string;
  name: string;
  action: ImportAction;
  resolved: boolean;
  flags: string[];
  /** What the profile would be: host, port, user, key file. */
  host: string;
  port: number | null;
  username: string | null;
  identityFile: string | null;
  skip: string | null;
}

export interface KeyInfo {
  path: string;
  kind: "public" | "private";
  type: string | null;
  comment: string | null;
  fingerprint: string | null;
  /** private only: the format and whether a passphrase protects it. */
  format: string | null;
  encrypted: boolean | null;
}

export type ScanResult =
  | { kind: "ssh-config" | "hosts"; items: ScanItem[]; stale: string[]; issues: string[] }
  | { kind: "keys-dir"; keys: KeyInfo[]; issues: string[] }
  | { kind: "agent"; keys: AgentKey[]; issues: string[] };

export interface ImportOutcome {
  created: number;
  updated: number;
  unchanged: number;
  conflicts: string[];
  deletedLocally: string[];
  skipped: string[];
  markedStale: number;
}

export interface ImportBookDeps {
  store: ImportStore;
  reader: SourceReader;
  profiles: ProfileBook;
  credentials: CredentialBook;
  newId: () => string;
}

const MAX_CONFIG_BYTES = 256 * 1024;
const MAX_HOSTS_BYTES = 512 * 1024;
const MAX_KEY_FILES = 200;
const MAX_PUBLIC_BYTES = 8 * 1024;
const SOURCE_PATH = /^\/[^\0\n\r]*$/;

export class ImportBook {
  constructor(private readonly deps: ImportBookDeps) {}

  sources(): ImportSource[] {
    return this.deps.store.sources();
  }

  /** Registers a source. It is OFF: reading it needs a separate, deliberate switch. */
  addSource(input: { kind: SourceKind; path: string | null; label: string }): ImportSource {
    if (input.kind === "agent") {
      if (input.path !== null) throw new ImportError("invalid_source", "the agent has no path");
    } else if (input.path === null || !SOURCE_PATH.test(input.path) || input.path.split("/").some((s) => s === "..")) {
      throw new ImportError("invalid_source", "a source is an absolute path without .. segments");
    }
    const label = input.label.trim().slice(0, 100) || (input.path ?? "agent");
    const source: ImportSource = { id: this.deps.newId(), kind: input.kind, path: input.path, label, enabled: false, useSshG: false };
    this.deps.store.putSource(source);
    return source;
  }

  private source(id: string): ImportSource {
    const found = this.deps.store.sources().find((s) => s.id === id);
    if (found === undefined) throw new ImportError("source_unknown", "no such source");
    return found;
  }

  setEnabled(id: string, enabled: boolean): ImportSource {
    const next = { ...this.source(id), enabled };
    // Switching a source off also switches ssh -G off: it is never left on behind a disabled source.
    this.deps.store.putSource(enabled ? next : { ...next, useSshG: false });
    return this.source(id);
  }

  setSshG(id: string, on: boolean): ImportSource {
    const source = this.source(id);
    if (source.kind !== "ssh-config") throw new ImportError("invalid_source", "only an ssh config can use ssh -G");
    if (on && !source.enabled) throw new ImportError("source_disabled", "switch the source on first");
    this.deps.store.putSource({ ...source, useSshG: on });
    return this.source(id);
  }

  removeSource(id: string): boolean {
    this.deps.store.removeLinksOfSource(id);
    return this.deps.store.removeSource(id);
  }

  /** Whether a saved secret may NOT be used for this profile: it depends on configuration this plugin cannot resolve. */
  needsConfig(profileId: string): boolean {
    return this.deps.store.links().some((l) => l.profileId === profileId && !l.resolved);
  }

  /** Imported profiles with where they came from; other profiles unchanged. */
  decorate(profiles: Profile[]): Profile[] {
    const sources = new Map(this.deps.store.sources().map((s) => [s.id, s]));
    const links = new Map(this.deps.store.links().map((l) => [l.profileId, l]));
    return profiles.map((p) => {
      const link = links.get(p.id);
      const source = link === undefined ? undefined : sources.get(link.sourceId);
      if (link === undefined || source === undefined || (source.kind !== "ssh-config" && source.kind !== "hosts")) return p;
      const provenance: Provenance = {
        sourceId: source.id,
        sourceKind: source.kind,
        sourceKey: link.key,
        resolved: link.resolved,
        stale: link.stale,
        flags: link.flags,
        editedLocally: !sameNow(importedOf(p), link.imported),
      };
      return { ...p, provenance };
    });
  }

  private enabledSource(id: string): ImportSource {
    const source = this.source(id);
    if (!source.enabled) throw new ImportError("source_disabled", "this source is switched off");
    return source;
  }

  private async candidates(source: ImportSource): Promise<{ candidates: Candidate[]; issues: string[] }> {
    const { reader } = this.deps;
    const path = source.path as string;
    if (source.kind === "hosts") {
      const text = reader.readText(path, MAX_HOSTS_BYTES);
      if (text === null) throw new ImportError("source_unreadable", "the file could not be read");
      return { candidates: parseHostsFile(text).map(candidateFromHost), issues: [] };
    }
    const text = reader.readText(path, MAX_CONFIG_BYTES);
    if (text === null) throw new ImportError("source_unreadable", "the file could not be read");
    const parse = parseSshConfig(text, { home: reader.home(), include: (pattern) => reader.include(path, pattern) });
    const issues = [...parse.issues];
    const candidates: Candidate[] = [];
    for (const entry of parse.entries) {
      let candidate = candidateFromConfigEntry(entry);
      if (source.useSshG && !candidate.resolved) {
        const resolved = await this.resolveWithSshG(path, entry.alias, candidate);
        if (resolved !== null) candidate = resolved;
        else issues.push(`ssh -G gave no answer for ${entry.alias}`);
      }
      candidates.push(candidate);
    }
    return { candidates, issues };
  }

  /** ssh -G evaluates the whole configuration (Match included): its answer resolves an entry unless it still goes through a proxy. */
  private async resolveWithSshG(path: string, alias: string, base: Candidate): Promise<Candidate | null> {
    const out = await this.deps.reader.sshG(path, alias);
    if (out === null) return null;
    const values = new Map<string, string>();
    for (const line of out.split(/\r?\n/)) {
      const m = /^([a-z]+) (.*)$/.exec(line.trim());
      if (m !== null && !values.has(m[1] as string)) values.set(m[1] as string, m[2] as string);
    }
    const host = values.get("hostname");
    if (host === undefined) return null;
    const proxy = [values.get("proxyjump"), values.get("proxycommand")].some((v) => v !== undefined && v !== "none");
    if (proxy) return { ...base, flags: [...new Set([...base.flags, "proxy"])].sort() };
    const port = Number(values.get("port") ?? "22");
    const imported: ImportedFields = {
      host: host.toLowerCase(),
      port: port === 22 ? null : port,
      username: values.get("user") ?? null,
      authType: "agent",
      identityFile: null,
    };
    // Key files from -G include OpenSSH's defaults whether or not they exist, so they are not taken.
    return { ...base, imported, resolved: true, flags: base.flags.filter((f) => f === "multiple-identities"), skip: null };
  }

  async scan(sourceId: string): Promise<ScanResult> {
    const source = this.enabledSource(sourceId);
    if (source.kind === "agent") return await this.scanAgent();
    if (source.kind === "keys-dir") return await this.scanKeys(source.path as string);
    const { candidates, issues } = await this.candidates(source);
    const plan = this.plan(source, candidates);
    return {
      kind: source.kind,
      items: plan.items.map((i) => ({
        key: i.candidate.key,
        name: i.candidate.name,
        action: i.action,
        resolved: i.candidate.resolved,
        flags: i.candidate.flags,
        host: i.candidate.imported.host,
        port: i.candidate.imported.port,
        username: i.candidate.imported.username,
        identityFile: i.candidate.imported.identityFile,
        skip: i.candidate.skip,
      })),
      stale: plan.stale.map((l) => l.key),
      issues,
    };
  }

  private plan(source: ImportSource, candidates: Candidate[]) {
    return planImport(candidates, this.deps.store.links(source.id), (profileId) => {
      const p = this.deps.profiles.get(profileId);
      return p === null ? null : importedOf(p);
    });
  }

  /** Imports the chosen keys of a source (all of them when `keys` is omitted). Re-running it is a no-op. */
  async apply(sourceId: string, keys?: string[]): Promise<ImportOutcome> {
    const source = this.enabledSource(sourceId);
    if (source.kind !== "ssh-config" && source.kind !== "hosts") throw new ImportError("invalid_source", "this source holds nothing to import");
    const { candidates } = await this.candidates(source);
    const chosen = keys === undefined ? candidates : candidates.filter((c) => keys.includes(c.key));
    const plan = this.plan(source, candidates);
    const out: ImportOutcome = { created: 0, updated: 0, unchanged: 0, conflicts: [], deletedLocally: [], skipped: [], markedStale: 0 };
    const wanted = new Set(chosen.map((c) => c.key));
    const group = "Imported";
    for (const item of plan.items) {
      if (!wanted.has(item.candidate.key)) continue;
      const c = item.candidate;
      const link: ImportLink = { profileId: item.profileId ?? "", sourceId: source.id, key: c.key, imported: c.imported, resolved: c.resolved, flags: c.flags, stale: false };
      switch (item.action) {
        case "create": {
          const profile = this.deps.profiles.saveImported({ fields: toProfileFields(c.imported, c.name, group) });
          this.deps.store.putLink({ ...link, profileId: profile.id });
          out.created += 1;
          break;
        }
        case "update": {
          const current = this.deps.profiles.get(item.profileId as string);
          if (current === null) break;
          // Through the credential book: a changed destination forgets a saved secret that was bound to the old one.
          await this.deps.credentials.saveProfile({ id: current.id, fields: { ...profileFieldsOf(current), ...c.imported } });
          this.deps.store.putLink(link);
          out.updated += 1;
          break;
        }
        case "unchanged":
          if (item.profileId !== null) this.deps.store.putLink({ ...link, stale: false });
          out.unchanged += 1;
          break;
        case "conflict":
          out.conflicts.push(c.key);
          break;
        case "deleted-locally":
          out.deletedLocally.push(c.key);
          break;
        case "skip":
          out.skipped.push(c.key);
          break;
      }
    }
    for (const gone of plan.stale) {
      this.deps.store.putLink({ ...gone, stale: true });
      out.markedStale += 1;
    }
    return out;
  }

  private async scanAgent(): Promise<ScanResult> {
    const out = await this.deps.reader.agentList();
    return { kind: "agent", keys: out === null ? [] : parseAgentList(out), issues: out === null ? ["no agent answered"] : [] };
  }

  private async scanKeys(dir: string): Promise<ScanResult> {
    const { reader } = this.deps;
    const issues: string[] = [];
    const entries = reader.listDir(dir);
    if (entries === null) throw new ImportError("source_unreadable", "the directory could not be read");
    const keys: KeyInfo[] = [];
    const files = entries.filter((e) => e.kind === "file").slice(0, MAX_KEY_FILES);
    if (entries.length > MAX_KEY_FILES) issues.push(`only the first ${MAX_KEY_FILES} files were looked at`);
    for (const file of files) {
      const path = `${dir.replace(/\/$/, "")}/${file.name}`;
      if (file.name.endsWith(".pub")) {
        const text = reader.readText(path, MAX_PUBLIC_BYTES);
        const info = text === null ? null : await publicKeyInfo(text.split(/\r?\n/)[0] ?? "");
        if (info !== null) keys.push({ path, kind: "public", type: info.type, comment: info.comment, fingerprint: info.fingerprint, format: null, encrypted: null });
        continue;
      }
      if (/^(known_hosts|config|authorized_keys|environment)/.test(file.name)) continue;
      const head = reader.readHead(path, PRIVATE_KEY_HEAD_BYTES);
      if (head === null) continue;
      const info = classifyPrivateKeyHead(head);
      if (info.format === "unknown") continue;
      keys.push({ path, kind: "private", type: info.type, comment: null, fingerprint: null, format: info.format, encrypted: info.encrypted });
    }
    return { kind: "keys-dir", keys, issues };
  }
}

const sameNow = (a: ImportedFields, b: ImportedFields): boolean => JSON.stringify(a) === JSON.stringify(b);
