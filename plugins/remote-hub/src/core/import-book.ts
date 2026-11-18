// The import book (stage 3c): sources the user has switched on, a scan that shows what each holds, and an
// import that turns chosen entries into profiles. Nothing is read from a source until the user has switched
// that source on; `ssh -G` is a further per-source switch, off by default. Host-free: files, the agent and
// ssh itself arrive through the `SourceReader` port.
import {
  candidateFromConfigEntry,
  candidateFromHost,
  importedOf,
  planImport,
  skipReason,
  toProfileFields,
  type Candidate,
  type ImportAction,
  type ImportLink,
  type ImportedFields,
} from "./import-plan.ts";
import { parseHostsFile } from "./hosts-file.ts";
import { lineKey, parseKnownHosts, parseKnownHostsText, type KnownHostEntry } from "./known-hosts.ts";
import type { CredentialBook } from "./credential.ts";
import { profileFieldsOf, type Profile, type Provenance } from "./profile.ts";
import type { ProfileBook } from "./profile-book.ts";
import { parseAgentList, publicKeyInfo, type AgentKey } from "./ssh-keys.ts";
import { parseSshConfig, type IncludeResult } from "./ssh-config.ts";

export type SourceKind = "ssh-config" | "hosts" | "keys-dir" | "agent" | "known-hosts";

/** The helper-owned known_hosts overlay: what saved-secret SSH sessions trust. */
export interface KnownHostsOverlay {
  list(): Promise<string[]>;
  add(lines: string[]): Promise<number>;
  remove(host: string): Promise<number>;
}

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

/** Text read from a file, and whether the file was longer than the limit (the rest was not read). */
export interface ReadText {
  text: string;
  truncated: boolean;
}

/** What one scan may still read through Include: shared by every Include of that scan, so a pattern cannot be repeated to get more. */
export interface IncludeBudget {
  files: number;
  bytes: number;
}

/** The outside world, bounded: every read has a size limit and every path is one the caller chose. */
export interface SourceReader {
  home(): string;
  /** A regular file only; a link that leaves the file's own directory, a FIFO, a device... is refused (null). */
  readText(path: string, maxBytes: number): ReadText | null;
  listDir(path: string): DirEntry[] | null;
  /** The files an Include names, refused unless they stay inside the config's own directory; draws on `budget`. */
  include(configPath: string, pattern: string, budget: IncludeBudget): IncludeResult;
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

/** A public key file, with the private file that sits beside it by name (never opened). */
export interface KeyInfo {
  publicPath: string;
  /** The sibling file without ".pub", when the directory has one; its contents are not read. */
  privatePath: string | null;
  type: string;
  comment: string;
  fingerprint: string;
}

export interface TrustItem {
  key: string;
  hosts: string[];
  hashed: boolean;
  keyType: string;
  fingerprint: string;
  /** Already in the overlay. */
  trusted: boolean;
}

export type ScanResult =
  | {
      kind: "ssh-config" | "hosts";
      /** Identifies THIS review: apply and resolve act on it and on nothing newer. */
      scanId: string;
      /** Part of the source was not read faithfully: no entry is offered as resolved and nothing is marked stale. */
      incomplete: boolean;
      items: ScanItem[];
      stale: string[];
      issues: string[];
    }
  | { kind: "known-hosts"; scanId: string; items: TrustItem[]; issues: string[] }
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
  /** Without it a known_hosts source can be listed but not trusted. */
  knownHosts?: KnownHostsOverlay | undefined;
}

const MAX_CONFIG_BYTES = 256 * 1024;
/** One scan may follow at most this many Include files and read this many bytes through them, all patterns together. */
const MAX_SCAN_FILES = 50;
const MAX_SCAN_BYTES = 1024 * 1024;
const MAX_HOSTS_BYTES = 512 * 1024;
const MAX_KEY_FILES = 200;
const MAX_PUBLIC_BYTES = 8 * 1024;
const SOURCE_PATH = /^\/[^\0\n\r]*$/;

/**
 * Host names are case-insensitive but ssh_config aliases are not: `Prod` and `prod` are two entries. Keys are lower
 * case, so when two entries of one scan would share a key they keep their alias as typed instead.
 */
function separateCaseOnlyDuplicates(candidates: Candidate[]): Candidate[] {
  const count = new Map<string, number>();
  for (const c of candidates) count.set(c.key, (count.get(c.key) ?? 0) + 1);
  return candidates.map((c) => ((count.get(c.key) ?? 0) > 1 ? { ...c, key: c.name } : c));
}

export class ImportBook {
  constructor(private readonly deps: ImportBookDeps) {}

  sources(): ImportSource[] {
    return this.deps.store.sources();
  }

  /** Where such sources usually are. Only strings: nothing is read, and none is registered until the user adds it. */
  suggestions(): Array<{ kind: SourceKind; path: string | null; label: string }> {
    const home = this.deps.reader.home().replace(/\/$/, "");
    return [
      { kind: "ssh-config", path: `${home}/.ssh/config`, label: "SSH config" },
      { kind: "keys-dir", path: `${home}/.ssh`, label: "SSH keys (public files)" },
      { kind: "hosts", path: "/etc/hosts", label: "Hosts file" },
      { kind: "known-hosts", path: `${home}/.ssh/known_hosts`, label: "Known hosts (host keys to trust)" },
      { kind: "agent", path: null, label: "SSH agent" },
    ];
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

  /** The reviewed scans: what each source showed the user last, kept so that apply and resolve act on exactly that. */
  private readonly reviewed = new Map<string, { id: string; candidates: Candidate[]; incomplete: boolean }>();

  private async candidates(source: ImportSource): Promise<{ candidates: Candidate[]; issues: string[]; incomplete: boolean }> {
    const { reader } = this.deps;
    const path = source.path as string;
    if (source.kind === "hosts") {
      const read = reader.readText(path, MAX_HOSTS_BYTES);
      if (read === null) throw new ImportError("source_unreadable", "the file could not be read (a link that leaves its directory, a pipe or a missing file is refused)");
      // A cut file may end in half a name: nothing from it is offered as resolved.
      const candidates = parseHostsFile(read.text).map(candidateFromHost).map((c) => (read.truncated ? { ...c, resolved: false, flags: ["incomplete"] } : c));
      return {
        candidates,
        issues: read.truncated ? ["the file was cut at its size limit"] : [],
        incomplete: read.truncated,
      };
    }
    const read = reader.readText(path, MAX_CONFIG_BYTES);
    if (read === null) throw new ImportError("source_unreadable", "the file could not be read (a link that leaves its directory, a pipe or a missing file is refused)");
    // One budget for the whole scan: every Include draws on it.
    const budget: IncludeBudget = { files: MAX_SCAN_FILES, bytes: MAX_SCAN_BYTES };
    const parse = parseSshConfig(read.text, { home: reader.home(), include: (pattern) => reader.include(path, pattern, budget), truncated: read.truncated });
    return { candidates: separateCaseOnlyDuplicates(parse.entries.map(candidateFromConfigEntry)), issues: [...parse.issues], incomplete: parse.incomplete };
  }

  private newScanId(): string {
    return this.deps.newId();
  }

  private scanItems(source: ImportSource, review: { id: string; candidates: Candidate[]; incomplete: boolean }, issues: string[]): ScanResult {
    const plan = this.plan(source, review.candidates);
    return {
      kind: source.kind as "ssh-config" | "hosts",
      scanId: review.id,
      incomplete: review.incomplete,
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
      // An incomplete scan says nothing about what is gone.
      stale: review.incomplete ? [] : plan.stale.map((l) => l.key),
      issues,
    };
  }

  /**
   * ssh -G for the entries the user chose, and only those: it makes ssh evaluate the configuration, which RUNS local commands
   * named in it (Match exec) and may read files outside the config's directory. The answer replaces those entries in the
   * reviewed scan, and a NEW review (a new scan id) is returned, because the destinations may now be different.
   */
  async resolve(sourceId: string, scanId: string, keys: string[]): Promise<ScanResult> {
    const source = this.enabledSource(sourceId);
    if (source.kind !== "ssh-config") throw new ImportError("invalid_source", "only an ssh config can use ssh -G");
    if (!source.useSshG) throw new ImportError("ssh_g_off", "ssh -G is switched off for this source");
    const review = this.reviewed.get(sourceId);
    if (review === undefined || review.id !== scanId) throw new ImportError("scan_required", "scan the source again before resolving");
    if (review.incomplete) throw new ImportError("scan_incomplete", "part of this config could not be read completely, so nothing from it is offered as resolved");
    const next: Candidate[] = [];
    const issues: string[] = [];
    for (const candidate of review.candidates) {
      if (!keys.includes(candidate.key) || candidate.resolved && !review.incomplete) {
        next.push(candidate);
        continue;
      }
      const resolved = await this.resolveWithSshG(source.path as string, candidate);
      if (resolved === null) issues.push(`ssh -G gave no answer for ${candidate.name}`);
      next.push(resolved ?? candidate);
    }
    // Entries that ssh resolved are no longer in doubt; the rest of an incomplete scan still is.
    const fresh = { id: this.newScanId(), candidates: next, incomplete: review.incomplete };
    this.reviewed.set(sourceId, fresh);
    return this.scanItems(source, fresh, issues);
  }

  /** ssh -G evaluates the whole configuration (Match included): its answer resolves an entry unless it still goes through a proxy. */
  private async resolveWithSshG(path: string, base: Candidate): Promise<Candidate | null> {
    const out = await this.deps.reader.sshG(path, base.name);
    if (out === null) return null;
    const values = new Map<string, string>();
    for (const line of out.split(/\r?\n/)) {
      const m = /^([a-z]+) (.*)$/.exec(line.trim());
      if (m !== null && !values.has(m[1] as string)) values.set(m[1] as string, m[2] as string);
    }
    const host = values.get("hostname");
    if (host === undefined) return null;
    const proxy = [values.get("proxyjump"), values.get("proxycommand")].some((v) => v !== undefined && v !== "none");
    if (proxy) return { ...base, flags: [...new Set([...base.flags.filter((f) => f !== "incomplete"), "proxy"])].sort() };
    const port = Number(values.get("port") ?? "22");
    const imported: ImportedFields = {
      host: host.toLowerCase(),
      port: port === 22 ? null : port,
      username: values.get("user") ?? null,
      authType: "agent",
      identityFile: null,
    };
    // What ssh returned is checked like anything else, so a hostile HostName shows up as skipped in the review.
    return { ...base, imported, resolved: true, flags: base.flags.filter((f) => f === "multiple-identities"), skip: skipReason(imported, base.name) };
  }

  async scan(sourceId: string): Promise<ScanResult> {
    const source = this.enabledSource(sourceId);
    if (source.kind === "agent") return await this.scanAgent();
    if (source.kind === "keys-dir") return await this.scanKeys(source.path as string);
    if (source.kind === "known-hosts") return await this.scanKnownHosts(source.id, source.path as string);
    const { candidates, issues, incomplete } = await this.candidates(source);
    const review = { id: this.newScanId(), candidates, incomplete };
    this.reviewed.set(sourceId, review);
    return this.scanItems(source, review, issues);
  }

  private plan(source: ImportSource, candidates: Candidate[]) {
    return planImport(candidates, this.deps.store.links(source.id), (profileId) => {
      const p = this.deps.profiles.get(profileId);
      return p === null ? null : importedOf(p);
    });
  }

  /**
   * Imports the chosen entries of the scan the user reviewed (`scanId`), never of a newer read of the file, so what is
   * applied is what was shown. Re-running it is a no-op.
   */
  async apply(sourceId: string, keys?: string[], scanId?: string): Promise<ImportOutcome> {
    const source = this.enabledSource(sourceId);
    if (source.kind === "known-hosts") return await this.applyKnownHosts(source.id, keys, scanId);
    if (source.kind !== "ssh-config" && source.kind !== "hosts") throw new ImportError("invalid_source", "this source holds nothing to import");
    const review = this.reviewed.get(sourceId);
    if (review === undefined || scanId === undefined || review.id !== scanId) throw new ImportError("scan_required", "review a scan of this source before importing");
    const { candidates } = review;
    const chosen = keys === undefined ? candidates : candidates.filter((c) => keys.includes(c.key));
    const plan = this.plan(source, candidates);
    const out: ImportOutcome = { created: 0, updated: 0, unchanged: 0, conflicts: [], deletedLocally: [], skipped: [], markedStale: 0 };
    const wanted = new Set(chosen.map((c) => c.key));
    const group = "Imported";
    for (const item of plan.items) {
      const c = item.candidate;
      const link: ImportLink = { profileId: item.profileId ?? "", sourceId: source.id, key: c.key, imported: c.imported, resolved: c.resolved, flags: c.flags, stale: false };
      // An entry that came back after being marked stale is simply current again, chosen or not.
      if (item.action === "unchanged" && item.profileId !== null && !wanted.has(c.key)) {
        const existing = this.deps.store.links(source.id).find((l) => l.key === c.key);
        if (existing?.stale === true) this.deps.store.putLink({ ...existing, stale: false });
        continue;
      }
      if (!wanted.has(c.key)) continue;
      switch (item.action) {
        case "create": {
          const profile = this.deps.profiles.saveImported({ fields: toProfileFields(c.imported, c.name, group), needsConfig: !c.resolved });
          this.deps.store.putLink({ ...link, profileId: profile.id });
          out.created += 1;
          break;
        }
        case "update": {
          const current = this.deps.profiles.get(item.profileId as string);
          if (current === null) break;
          // Through the credential book: a changed destination forgets a saved secret that was bound to the old one.
          await this.deps.credentials.saveProfile({ id: current.id, fields: { ...profileFieldsOf(current), ...c.imported } });
          this.deps.profiles.setNeedsConfig(current.id, !c.resolved);
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
    // A scan that was not read faithfully says nothing about what is gone from the source.
    if (!review.incomplete) {
      for (const gone of plan.stale) {
        this.deps.store.putLink({ ...gone, stale: true });
        out.markedStale += 1;
      }
    }
    return out;
  }

  /** The overlay's entries, for showing what saved-secret SSH sessions trust. */
  async trustedHosts(): Promise<Array<Omit<TrustItem, "trusted">>> {
    if (this.deps.knownHosts === undefined) return [];
    const entries = await parseKnownHosts((await this.deps.knownHosts.list()).join("\n"));
    return Promise.all(entries.map(async (e) => ({ key: await lineKey(e.line), hosts: e.hosts, hashed: e.hashed, keyType: e.keyType, fingerprint: e.fingerprint })));
  }

  /** Forgets a host: its keys leave the overlay, so the next session asks again. */
  async forgetHost(host: string): Promise<number> {
    if (this.deps.knownHosts === undefined) throw new ImportError("known_hosts_unavailable", "the known hosts file is not available");
    return await this.deps.knownHosts.remove(host);
  }

  private async knownHostEntries(path: string): Promise<{ entries: KnownHostEntry[]; wildcardLines: number }> {
    const read = this.deps.reader.readText(path, MAX_HOSTS_BYTES * 8);
    if (read === null) throw new ImportError("source_unreadable", "the file could not be read (a link that leaves its directory, a pipe or a missing file is refused)");
    return await parseKnownHostsText(read.text);
  }

  /** What the user was shown for each known_hosts source: the lines by their key, and nothing else is ever added. */
  private readonly reviewedKnownHosts = new Map<string, { id: string; lines: Map<string, string> }>();

  private async scanKnownHosts(sourceId: string, path: string): Promise<ScanResult> {
    const { entries, wildcardLines } = await this.knownHostEntries(path);
    const have = new Set(this.deps.knownHosts === undefined ? [] : (await this.deps.knownHosts.list()).map((l) => l.trim()));
    const items = await Promise.all(
      entries.map(async (e) => ({ key: await lineKey(e.line), hosts: e.hosts, hashed: e.hashed, keyType: e.keyType, fingerprint: e.fingerprint, trusted: have.has(e.line) })),
    );
    const lines = new Map<string, string>();
    for (let i = 0; i < entries.length; i++) lines.set((items[i] as { key: string }).key, (entries[i] as KnownHostEntry).line);
    const review = { id: this.newScanId(), lines };
    this.reviewedKnownHosts.set(sourceId, review);
    const issues: string[] = [];
    if (this.deps.knownHosts === undefined) issues.push("the helper's known hosts file is not available");
    if (wildcardLines > 0) {
      issues.push(wildcardLines === 1 ? "1 line that trusts a key for many hosts (wildcards or negation) was not offered" : `${wildcardLines} lines that trust a key for many hosts (wildcards or negation) were not offered`);
    }
    return { kind: "known-hosts", scanId: review.id, items, issues };
  }

  /**
   * Copies the chosen host keys into the overlay: only lines of the scan the user reviewed (`scanId`), only the keys
   * named in an explicit selection, only plain host-key lines. A later change of the file adds nothing.
   */
  private async applyKnownHosts(sourceId: string, keys: string[] | undefined, scanId: string | undefined): Promise<ImportOutcome> {
    if (this.deps.knownHosts === undefined) throw new ImportError("known_hosts_unavailable", "the known hosts file is not available");
    const review = this.reviewedKnownHosts.get(sourceId);
    if (review === undefined || scanId === undefined || review.id !== scanId) throw new ImportError("scan_required", "review a scan of this source before trusting keys");
    if (keys === undefined) throw new ImportError("selection_required", "choose which keys to trust: nothing is trusted by default");
    const chosen: string[] = [];
    for (const key of keys) {
      const line = review.lines.get(key);
      if (line === undefined) throw new ImportError("unknown_entry", "a chosen key is not in the reviewed scan");
      chosen.push(line);
    }
    const added = chosen.length === 0 ? 0 : await this.deps.knownHosts.add(chosen);
    return { created: added, updated: 0, unchanged: chosen.length - added, conflicts: [], deletedLocally: [], skipped: [], markedStale: 0 };
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
    const names = new Set(files.map((f) => f.name));
    for (const file of files) {
      if (!file.name.endsWith(".pub")) continue; // private files are neither opened nor listed on their own
      const path = `${dir.replace(/\/$/, "")}/${file.name}`;
      const read = reader.readText(path, MAX_PUBLIC_BYTES);
      const info = read === null ? null : await publicKeyInfo(read.text.split(/\r?\n/)[0] ?? "");
      if (info === null) continue;
      const sibling = file.name.slice(0, -4);
      keys.push({ publicPath: path, privatePath: names.has(sibling) ? `${dir.replace(/\/$/, "")}/${sibling}` : null, type: info.type, comment: info.comment, fingerprint: info.fingerprint });
    }
    return { kind: "keys-dir", keys, issues };
  }
}

const sameNow = (a: ImportedFields, b: ImportedFields): boolean => JSON.stringify(a) === JSON.stringify(b);
