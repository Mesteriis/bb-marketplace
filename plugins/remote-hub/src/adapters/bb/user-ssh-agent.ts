// Which SSH agent socket ssh itself would use for a host. A connection that signs in with "the SSH agent" follows the
// owner's own ssh configuration, and an `IdentityAgent` there (1Password, Secretive...) wins over SSH_AUTH_SOCK, so the
// socket in the environment says nothing when one is set. Read-only and passive: text is scanned (the config and the files
// its Include lines name, through the same bounded reader the import uses), no ssh program runs. Only a hint for naming a
// refusal; ssh makes the decision. Whatever the text cannot settle is "unknown", never "no agent".
import { lstatSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { isAbsolute, join } from "node:path";
import type { IncludeBudget } from "../../core/import-book.ts";
import { lookupDirective, type IncludeResult } from "../../core/ssh-config.ts";
import { createFsSourceReader } from "./fs-source-reader.ts";

const MAX_CONFIG_BYTES = 256 * 1024;
const INCLUDE_BUDGET = { files: 64, bytes: 1024 * 1024 };

export type AgentResolution = { kind: "socket"; path: string } | { kind: "none" } | { kind: "unknown" };

/** The owner's config as the resolver reads it: the text, whether it was cut, and what an Include names. */
export interface UserSshConfig {
  text: string;
  truncated: boolean;
  /** The identity of the main file (an Include of it is a cycle). */
  rootPath: string;
  include(pattern: string): IncludeResult;
}

export const NO_USER_SSH_CONFIG: UserSshConfig = { text: "", truncated: false, rootPath: "", include: () => ({ files: [], complete: true }) };

export interface AgentQuery {
  env: Record<string, string | undefined>;
  home: string;
  /** The host as typed (what `Host` lines are matched against, and %n/%h when no HostName line changes it). */
  host: string;
  /** The local user name (%u) and numeric id (%i); null when not known. */
  user: string | null;
  uid: number | null;
  config: UserSshConfig;
}

const UNKNOWN: AgentResolution = { kind: "unknown" };

/** Expands the tokens and variables ssh knows in an IdentityAgent path; null when one cannot be settled from the text. */
function expandPath(value: string, q: AgentQuery): string | null {
  let rest = value;
  if (rest === "~" || rest.startsWith("~/")) rest = q.home + rest.slice(1);
  else if (rest.startsWith("~")) return null; // ~user
  let out = "";
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i] as string;
    if (ch === "%") {
      const t = rest[i + 1];
      i += 1;
      if (t === "%") out += "%";
      else if (t === "d") out += q.home;
      else if (t === "u" && q.user !== null) out += q.user;
      else if (t === "i" && q.uid !== null) out += String(q.uid);
      else if (t === "h") {
        const hostName = lookupDirective(q.config.text, "HostName", q.host, { home: q.home, include: q.config.include, truncated: q.config.truncated, rootPath: q.config.rootPath });
        if (hostName.kind === "unknown" || (hostName.kind === "value" && /[%$]/.test(hostName.value))) return null;
        out += hostName.kind === "value" ? hostName.value : q.host;
      } else return null; // %L %l %n %p %r and anything else
    } else if (ch === "$") {
      const m = /^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/.exec(rest.slice(i));
      const name = m?.[1] ?? m?.[2];
      const resolved = name === undefined ? undefined : q.env[name];
      if (m === null || resolved === undefined || resolved === "") return null;
      out += resolved;
      i += m[0].length - 1;
    } else out += ch;
  }
  return isAbsolute(out) ? out : null;
}

/** The agent socket ssh would use for `host`. */
export function agentSocketFor(q: AgentQuery): AgentResolution {
  const fromEnv: AgentResolution = q.env.SSH_AUTH_SOCK === undefined || q.env.SSH_AUTH_SOCK === "" ? { kind: "none" } : { kind: "socket", path: q.env.SSH_AUTH_SOCK };
  const found = lookupDirective(q.config.text, "IdentityAgent", q.host, { home: q.home, include: q.config.include, truncated: q.config.truncated, rootPath: q.config.rootPath });
  if (found.kind === "unknown") return UNKNOWN;
  if (found.kind === "none" || found.value === "SSH_AUTH_SOCK") return fromEnv;
  if (found.value === "none") return { kind: "none" };
  if (found.value === "") return UNKNOWN;
  if (/^\$[A-Za-z_][A-Za-z0-9_]*$/.test(found.value)) {
    const resolved = q.env[found.value.slice(1)];
    return resolved === undefined || resolved === "" || !isAbsolute(resolved) ? UNKNOWN : { kind: "socket", path: resolved };
  }
  const path = expandPath(found.value, q);
  return path === null ? UNKNOWN : { kind: "socket", path };
}

/** The owner's real ~/.ssh/config and its Include files, or null when it is there but cannot be read. A missing file is no config. */
export function readUserSshConfig(home: string = homedir()): UserSshConfig | null {
  const path = join(home, ".ssh", "config");
  try {
    lstatSync(path);
  } catch (error) {
    return (error as { code?: string }).code === "ENOENT" ? NO_USER_SSH_CONFIG : null;
  }
  const reader = createFsSourceReader({ home });
  const read = reader.readText(path, MAX_CONFIG_BYTES);
  if (read === null) return null;
  const budget: IncludeBudget = { ...INCLUDE_BUDGET };
  return { text: read.text, truncated: read.truncated, rootPath: path, include: (pattern) => reader.include(path, pattern, budget) };
}

export function localUser(): { user: string | null; uid: number | null } {
  try {
    const info = userInfo();
    return { user: info.username, uid: info.uid >= 0 ? info.uid : null };
  } catch {
    return { user: null, uid: null };
  }
}
