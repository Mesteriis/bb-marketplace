// Which SSH agent socket ssh itself would use for a host. A connection that signs in with "the SSH agent" follows the
// owner's own ssh configuration, and an `IdentityAgent` there (1Password, Secretive...) wins over SSH_AUTH_SOCK, so the
// socket in the environment says nothing when one is set. Read-only and passive: a text is scanned, no ssh program runs.
// Only a hint for naming a refusal; ssh makes the decision. `Match` blocks are not evaluated (their lines are skipped).
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function hostMatches(patterns: string[], host: string): boolean {
  let hit = false;
  for (const pattern of patterns) {
    const negated = pattern.startsWith("!");
    const body = negated ? pattern.slice(1) : pattern;
    const re = new RegExp(`^${body.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`, "i");
    if (re.test(host)) {
      if (negated) return false;
      hit = true;
    }
  }
  return hit;
}

function words(rest: string): string[] {
  return [...rest.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? (m[2] as string));
}

/** The first `IdentityAgent` value that applies to `host` (outside any block, or in a matching `Host` block), or null. */
function configuredAgent(configText: string, host: string): string | null {
  let applies = true;
  for (const raw of configText.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const m = /^([A-Za-z]+)(?:\s*=\s*|\s+)(.*)$/.exec(line);
    if (m === null) continue;
    const key = (m[1] as string).toLowerCase();
    const rest = m[2] as string;
    if (key === "host") applies = hostMatches(words(rest), host);
    else if (key === "match") applies = false;
    else if (key === "identityagent" && applies) return words(rest)[0] ?? null;
  }
  return null;
}

export interface AgentSocketQuery {
  env: Record<string, string | undefined>;
  home: string;
  host: string;
  configText: string;
}

/** The socket path ssh would talk to for `host`, or null when it would use no agent (none, or nothing to resolve). */
export function agentSocketFor({ env, home, host, configText }: AgentSocketQuery): string | null {
  const value = configuredAgent(configText, host);
  const fromEnv = env.SSH_AUTH_SOCK === undefined || env.SSH_AUTH_SOCK === "" ? null : env.SSH_AUTH_SOCK;
  if (value === null || value === "SSH_AUTH_SOCK") return fromEnv;
  if (value === "none") return null;
  if (value.startsWith("$")) {
    const name = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(value)?.[1];
    const resolved = name === undefined ? undefined : env[name];
    return resolved === undefined || resolved === "" ? null : resolved;
  }
  if (value.startsWith("~/")) return join(home, value.slice(2));
  if (value.startsWith("%d/")) return join(home, value.slice(3));
  return value;
}

/** The owner's ssh configuration text, or "" when there is none (or it cannot be read). */
export function readUserSshConfig(home: string = homedir()): string {
  try {
    return readFileSync(join(home, ".ssh", "config"), "utf8");
  } catch {
    return "";
  }
}
