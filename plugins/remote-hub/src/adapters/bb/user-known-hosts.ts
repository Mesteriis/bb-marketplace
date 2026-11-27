// Whether the user's own known_hosts already holds a key for a host: what a connection WITHOUT a saved secret (an agent,
// a plain key) is checked against by ssh itself. Read-only and passive: a file is read and compared, no ssh program is
// run and no configuration is evaluated, so this is a hint for a listing, never a decision; ssh makes the decision with
// StrictHostKeyChecking=yes when a channel is opened.
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { knownHostsName } from "../../core/known-hosts.ts";

/** True when a plain or hashed line names exactly this host (and port). Markers, comments and patterns do not count. */
export function knownHostsTextHolds(text: string, host: string, port: number | null): boolean {
  const name = knownHostsName(host, port);
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#") || line.startsWith("@")) continue;
    const spec = line.split(/\s+/, 1)[0] as string;
    if (spec.startsWith("|1|")) {
      const [, , salt, hash] = spec.split("|");
      if (salt === undefined || hash === undefined) continue;
      try {
        if (createHmac("sha1", Buffer.from(salt, "base64")).update(name).digest("base64") === hash) return true;
      } catch {
        // not a hashed entry after all
      }
      continue;
    }
    if (spec.split(",").some((entry) => entry.toLowerCase() === name)) return true;
  }
  return false;
}

/** The user's known_hosts, or "" when there is none or it cannot be read. */
export function readUserKnownHosts(): string {
  try {
    return readFileSync(join(homedir(), ".ssh", "known_hosts"), "utf8");
  } catch {
    return "";
  }
}
