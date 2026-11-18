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
  /** Reasons the text alone cannot say where this alias goes: "proxy", "match", "tokens", "canonicalize", "host-key-alias". */
  flags: string[];
  /** 1-based line of the first Host line that names the alias. */
  line: number;
}

export interface ConfigParse {
  entries: ConfigEntry[];
  /** Host blocks made only of patterns (`Host *`, `Host *.example`): they apply to aliases, they are not aliases. */
  patternBlocks: number;
  issues: string[];
}

export interface IncludedFile {
  path: string;
  text: string;
}

export interface ConfigOptions {
  /** The home directory `~` stands for. */
  home: string;
  /** Files named by an Include directive (a glob or a path), already read; [] when there are none or it is refused. */
  include: (pattern: string) => IncludedFile[];
  maxDepth?: number;
}

interface Directive {
  key: string;
  value: string;
  line: number;
}

interface Block {
  kind: "global" | "host" | "match";
  patterns: string[];
  directives: Directive[];
  line: number;
}

const MAX_LINES = 20_000;

function splitWords(text: string): string[] {
  const words: string[] = [];
  let current = "";
  let quoted = false;
  let started = false;
  for (const ch of text) {
    if (ch === '"') {
      quoted = !quoted;
      started = true;
    } else if (!quoted && (ch === " " || ch === "\t")) {
      if (started) words.push(current);
      current = "";
      started = false;
    } else if (!quoted && ch === "#") {
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

function readBlocks(text: string, opts: ConfigOptions, depth: number, issues: string[], out: Block[]): void {
  const lines = text.split(/\r?\n/);
  if (lines.length > MAX_LINES) {
    issues.push(`a file with more than ${MAX_LINES} lines was cut short`);
    lines.length = MAX_LINES;
  }
  let current: Block = out.length > 0 ? (out[out.length - 1] as Block) : { kind: "global", patterns: [], directives: [], line: 0 };
  if (out.length === 0) out.push(current);
  lines.forEach((raw, index) => {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) return;
    const kw = splitKeyword(line);
    if (kw === null) return;
    const lineNo = index + 1;
    if (kw.key === "host") {
      current = { kind: "host", patterns: splitWords(kw.rest), directives: [], line: lineNo };
      out.push(current);
    } else if (kw.key === "match") {
      current = { kind: "match", patterns: splitWords(kw.rest), directives: [], line: lineNo };
      out.push(current);
    } else if (kw.key === "include") {
      if (depth >= (opts.maxDepth ?? 4)) {
        issues.push("an Include nested too deeply was not followed");
        return;
      }
      for (const word of splitWords(kw.rest)) {
        const files = opts.include(word.startsWith("~") ? opts.home + word.slice(1) : word);
        // The included blocks follow in file order; lines after the Include stay with the block they were in
        // (so a directive that follows an Include is ordered before the included blocks, a small deviation
        // from ssh, which reads the included text at that point).
        for (const file of files) readBlocks(file.text, opts, depth + 1, issues, out);
      }
    } else {
      current.directives.push({ key: kw.key, value: kw.rest, line: lineNo });
    }
  });
}

/** ssh_config pattern matching for host names: `*` and `?`, case-insensitive. */
export function patternMatches(pattern: string, name: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i").test(name);
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

export function parseSshConfig(text: string, opts: ConfigOptions): ConfigParse {
  const issues: string[] = [];
  const blocks: Block[] = [];
  readBlocks(text, opts, 0, issues, blocks);

  const hasMatch = blocks.some((b) => b.kind === "match");
  const aliases = new Map<string, number>();
  let patternBlocks = 0;
  for (const block of blocks) {
    if (block.kind !== "host") continue;
    const plain = block.patterns.filter(isPlainAlias);
    if (plain.length === 0) patternBlocks += 1;
    for (const alias of plain) if (!aliases.has(alias.toLowerCase())) aliases.set(alias.toLowerCase(), block.line);
  }

  const entries: ConfigEntry[] = [];
  for (const [alias, line] of aliases) {
    let hostName: string | null = null;
    let port: number | null = null;
    let user: string | null = null;
    const identityFiles: string[] = [];
    const flags = new Set<string>();
    if (hasMatch) flags.add("match");
    // First value wins, in file order, over every block that applies to this alias (global lines apply to all).
    for (const block of blocks) {
      const applies = block.kind === "global" || (block.kind === "host" && hostSelects(block.patterns, alias));
      if (!applies) continue;
      for (const d of block.directives) {
        const value = splitWords(d.value)[0] ?? "";
        switch (d.key) {
          case "hostname":
            if (hostName === null) {
              if (/%[^h%]/.test(value)) flags.add("tokens");
              hostName = value.replace(/%h/g, alias).replace(/%%/g, "%");
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
    }
    entries.push({ alias, hostName, port, user, identityFiles, flags: [...flags].sort(), line });
  }
  return { entries, patternBlocks, issues };
}
