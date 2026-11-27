// A passive reader for OpenSSH client configuration (stage 3c). It never runs ssh and never
// executes anything: it reads text and works out, for each plainly named `Host` alias, what the
// first-match-wins rules of ssh_config(5) give for HostName, Port, User and IdentityFile.
// Whatever it cannot know from the text alone (Match blocks, ProxyJump/ProxyCommand, %-tokens other
// than %h, canonicalization) is reported as a FLAG on the entry instead of being guessed: such an
// alias is not "resolved" and must keep going through the user's own configuration.
// Host-free: Include files and the home directory come in through `options`.

export interface ConfigEntry {
  alias: string;
  /** The HostName in force (after %h), or null when none is set (the alias is the host name then). */
  hostName: string | null;
  port: number | null;
  user: string | null;
  /** IdentityFile values with ~ expanded, in order. */
  identityFiles: string[];
  /** Reasons the text alone cannot say where this alias goes: "proxy", "match", "tokens", "canonicalize", "host-key-alias", "incomplete" */
  flags: string[];
}

export interface ConfigParse {
  entries: ConfigEntry[];
  /** Host blocks made only of patterns (`Host *`, `Host *.example`): they apply to aliases, they are not aliases. */
  patternBlocks: number;
  issues: string[];
  /**
   * True when something that could change an alias was not read faithfully: an Include that was refused, cut
   * short, unreadable, cyclic or too deep, a file cut at its limits. Every entry is then flagged "incomplete".
   */
  incomplete: boolean;
}

export interface IncludedFile {
  path: string;
  text: string;
  /** The file was cut at a limit: its end was not read. */
  truncated?: boolean;
}

/** What an Include resolves to. `complete: false` when a file was refused, missing for a reason other than "no match", or over budget. */
export interface IncludeResult {
  files: IncludedFile[];
  complete: boolean;
}

export interface ConfigOptions {
  /** The home directory `~` stands for. */
  home: string;
  /** Files named by an Include directive (a glob or a path), already read. */
  include: (pattern: string) => IncludeResult;
  maxDepth?: number;
  /** The main text was cut at its limit. */
  truncated?: boolean;
}

interface Directive {
  key: string;
  value: string;
  line: number;
}

/** A Host or Match line that must hold for the lines under it. An Include inside a block adds to its conditions. */
interface Cond {
  kind: "host" | "match";
  patterns: string[];
}

/** One directive with the conditions it sits under, in file order (included text where the Include stood). */
interface Item {
  conds: Cond[];
  directive: Directive;
}

const MAX_LINES = 20_000;

/**
 * Splits the way OpenSSH's argv_split does for config lines: words at blanks; single or double quotes group and
 * are removed BEFORE a pattern is looked at (so `'!prod'` is the negation `!prod`); a backslash before a quote or
 * a backslash is that character; an unquoted `#` starts a comment.
 */
function splitWords(text: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: string | null = null;
  let started = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    const next = text[i + 1];
    if (ch === "\\" && next !== undefined && (next === '"' || next === "'" || next === "\\" || (quote === null && next === " "))) {
      current += next;
      started = true;
      i += 1;
    } else if (quote !== null) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (ch === " " || ch === "\t") {
      if (started) words.push(current);
      current = "";
      started = false;
    } else if (ch === "#") {
      break;
    } else {
      current += ch;
      started = true;
    }
  }
  if (started) words.push(current);
  return words;
}

/** `Key value`, `Key=value`, `Key = value`. */
function splitKeyword(line: string): { key: string; rest: string } | null {
  const match = /^([A-Za-z][A-Za-z0-9]*)(?:[ \t]*=[ \t]*|[ \t]+)(.*)$/.exec(line);
  if (match === null) return null;
  return { key: (match[1] as string).toLowerCase(), rest: match[2] as string };
}

interface ReadState {
  opts: ConfigOptions;
  issues: string[];
  items: Item[];
  /** Every Host line read, with the conditions it sits under (an alias is named by one of these, even with no directive under it). */
  hostChains: Cond[][];
  incomplete: boolean;
  /** The canonical paths of the files being read now: an Include that names one of them is a cycle. */
  stack: string[];
}

/**
 * Reads one file into `state.items`, in file order. `base` are the conditions the file is included under; a Host or
 * Match line inside it adds to them, and nothing the file does leaks back out to the including file: after an
 * Include the including file carries on in its own scope, exactly as OpenSSH does.
 */
function readInto(text: string, base: Cond[], depth: number, state: ReadState): void {
  const lines = text.split(/\r?\n/);
  if (lines.length > MAX_LINES) {
    state.issues.push(`a file with more than ${MAX_LINES} lines was cut short`);
    state.incomplete = true;
    lines.length = MAX_LINES;
  }
  let conds: Cond[] = base;
  lines.forEach((raw, index) => {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) return;
    const kw = splitKeyword(line);
    if (kw === null) return;
    if (kw.key === "host") {
      conds = [...base, { kind: "host", patterns: splitWords(kw.rest) }];
      state.hostChains.push(conds);
    } else if (kw.key === "match") {
      conds = [...base, { kind: "match", patterns: splitWords(kw.rest) }];
    } else if (kw.key === "include") {
      for (const word of splitWords(kw.rest)) includeInto(word, conds, depth, state);
    } else {
      // ssh refuses a single-value keyword with more than one word ("garbage at end of line"), so nothing it
      // would have said about this alias can be trusted.
      if ((kw.key === "hostname" || kw.key === "port" || kw.key === "user") && splitWords(kw.rest).length > 1) {
        state.issues.push(`a "${kw.key}" line with more than one value was not understood`);
        state.incomplete = true;
      }
      state.items.push({ conds, directive: { key: kw.key, value: kw.rest, line: index + 1 } });
    }
  });
}

function includeInto(word: string, conds: Cond[], depth: number, state: ReadState): void {
  const { opts, issues } = state;
  if (depth >= (opts.maxDepth ?? 4)) {
    issues.push("an Include nested too deeply was not followed");
    state.incomplete = true;
    return;
  }
  if (/[$]\{|%/.test(word)) {
    issues.push("an Include that uses ${VAR} or a %-token was not followed");
    state.incomplete = true;
    return;
  }
  // Only `~` and `~/...` stand for the home directory; `~user/...` names another user's, which the text cannot say.
  if (word.startsWith("~") && word !== "~" && !word.startsWith("~/")) {
    issues.push("an Include with ~user was not followed");
    state.incomplete = true;
    return;
  }
  const result = opts.include(word.startsWith("~") ? opts.home + word.slice(1) : word);
  if (!result.complete) {
    issues.push("an Include was refused, unreadable or over the scan's limits");
    state.incomplete = true;
  }
  for (const file of result.files) {
    if (state.stack.includes(file.path)) {
      issues.push("an Include cycle was not followed");
      state.incomplete = true;
      continue;
    }
    if (file.truncated === true) {
      issues.push("an included file was cut at its size limit");
      state.incomplete = true;
    }
    state.stack.push(file.path);
    readInto(file.text, conds, depth + 1, state);
    state.stack.pop();
  }
}

/**
 * ssh_config pattern matching for host names: `*` and `?`. Case-SENSITIVE: ssh compares the name as typed with the
 * pattern as written (verified with `ssh -G`: `Host Case` selects `ssh Case` and not `ssh case`).
 */
export function patternMatches(pattern: string, name: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`).test(name);
}

function isPlainAlias(pattern: string): boolean {
  return pattern !== "" && !/[*?!]/.test(pattern) && !pattern.includes(",");
}

/** Whether a `Host` line's patterns select `alias`: some pattern matches and no negated one does. */
function hostSelects(patterns: string[], alias: string): boolean {
  let positive = false;
  for (const p of patterns) {
    if (p.startsWith("!")) {
      if (patternMatches(p.slice(1), alias)) return false;
    } else if (patternMatches(p, alias)) {
      positive = true;
    }
  }
  return positive;
}

function expandHome(path: string, home: string): string {
  if (path === "~") return home;
  return path.startsWith("~/") ? home + path.slice(1) : path;
}

/** `%h` is the alias and `%%` a percent sign: `%%h` is the text "%h", not the alias. Anything else with a % is a token this reader does not know. */
function expandHostName(value: string, alias: string): { text: string; tokens: boolean } {
  const masked = value.replace(/%%/g, "\u0000");
  const tokens = /%[^h]/.test(masked.replace(/%h/g, ""));
  return { text: masked.replace(/%h/g, alias).replace(/\u0000/g, "%"), tokens };
}

export function parseSshConfig(text: string, opts: ConfigOptions): ConfigParse {
  const state: ReadState = { opts, issues: [], items: [], hostChains: [], incomplete: opts.truncated === true, stack: [] };
  if (opts.truncated === true) state.issues.push("the config was cut at its size limit");
  readInto(text, [], 0, state);
  const { items } = state;

  const hasMatch = items.some((i) => i.conds.some((c) => c.kind === "match"));
  // An alias is a plain name on a Host line, and only where the lines before it (the blocks an Include sits in) select it too.
  const aliases = new Set<string>();
  let patternBlocks = 0;
  for (const chain of state.hostChains) {
    const cond = chain[chain.length - 1] as Cond;
    const outer = chain.slice(0, -1);
    const plain = cond.patterns.filter(isPlainAlias);
    if (plain.length === 0) patternBlocks += 1;
    for (const alias of plain) {
      if (outer.every((c) => c.kind === "match" || hostSelects(c.patterns, alias))) aliases.add(alias);
    }
  }

  const entries: ConfigEntry[] = [];
  for (const written of aliases) {
    // ssh matches the name AS TYPED against the patterns as written, case-sensitively (verified with `ssh -G`).
    const alias = written;
    let hostName: string | null = null;
    let port: number | null = null;
    let user: string | null = null;
    const identityFiles: string[] = [];
    const flags = new Set<string>();
    if (hasMatch) flags.add("match");
    if (state.incomplete) flags.add("incomplete");
    // First value wins, in FILE order, over every line whose conditions all select this alias.
    for (const { conds, directive: d } of items) {
      if (conds.some((c) => c.kind === "match" || !hostSelects(c.patterns, alias))) continue;
      const value = splitWords(d.value)[0] ?? "";
      switch (d.key) {
        case "hostname":
          if (hostName === null) {
            const expanded = expandHostName(value, alias);
            if (expanded.tokens) flags.add("tokens");
            hostName = expanded.text;
          }
          break;
        case "port":
          if (port === null && /^\d{1,5}$/.test(value) && Number(value) >= 1 && Number(value) <= 65535) port = Number(value);
          break;
        case "user":
          if (user === null && value !== "") {
            if (value.includes("%")) flags.add("tokens");
            user = value;
          }
          break;
        case "identityfile":
          if (value !== "") {
            if (value.includes("%")) flags.add("tokens");
            identityFiles.push(expandHome(value, opts.home));
          }
          break;
        case "proxyjump":
        case "proxycommand":
          if (value.toLowerCase() !== "none") flags.add("proxy");
          break;
        case "canonicalizehostname":
          if (value.toLowerCase() !== "no") flags.add("canonicalize");
          break;
        case "hostkeyalias":
          flags.add("host-key-alias");
          break;
        default:
      }
    }
    entries.push({ alias, hostName, port, user, identityFiles, flags: [...flags].sort() });
  }
  return { entries, patternBlocks, issues: state.issues, incomplete: state.incomplete };
}

/** What the text alone says about one single-value directive for a host. */
export type DirectiveLookup = { kind: "value"; value: string } | { kind: "none" } | { kind: "unknown" };

/** ssh's own limit on nested Include files. */
export const SSH_INCLUDE_MAX_DEPTH = 16;

/**
 * The first value of each directive (`IdentityAgent`, `HostName`...) that ssh would take for `host`, from the text of a config and
 * the files its Include lines name, read where the Include stands. The text is read ONCE, so every key sees the same files
 * and the budget of `opts.include` is spent once. `none`: no line applies. `unknown`: the text cannot say: a Match block holds
 * the directive before any certain value, or something was not read faithfully (a refused, cyclic, too deep or cut Include, a
 * file cut at its limit). `rootPath` is the identity of the main file, so an Include of it is a cycle.
 */
export function lookupDirectives(text: string, keys: string[], host: string, opts: ConfigOptions & { rootPath?: string }): Record<string, DirectiveLookup> {
  const state: ReadState = { opts: { ...opts, maxDepth: opts.maxDepth ?? SSH_INCLUDE_MAX_DEPTH }, issues: [], items: [], hostChains: [], incomplete: opts.truncated === true, stack: opts.rootPath === undefined ? [] : [opts.rootPath] };
  readInto(text, [], 0, state);
  const out: Record<string, DirectiveLookup> = {};
  for (const key of keys) {
    const wanted = key.toLowerCase();
    let found: DirectiveLookup | null = null;
    for (const { conds, directive: d } of state.items) {
      if (d.key !== wanted) continue;
      if (conds.some((c) => c.kind === "host" && !hostSelects(c.patterns, host))) continue;
      found = conds.some((c) => c.kind === "match") || state.incomplete ? { kind: "unknown" } : { kind: "value", value: splitWords(d.value)[0] ?? "" };
      break;
    }
    out[key] = found ?? (state.incomplete ? { kind: "unknown" } : { kind: "none" });
  }
  return out;
}

/** One directive of `lookupDirectives`. */
export function lookupDirective(text: string, key: string, host: string, opts: ConfigOptions & { rootPath?: string }): DirectiveLookup {
  return lookupDirectives(text, [key], host, opts)[key] as DirectiveLookup;
}
