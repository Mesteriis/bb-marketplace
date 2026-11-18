// known_hosts lines as data (stage 3c-2). The helper owns the overlay file; this module reads lines (from the
// overlay or from a known_hosts file the user switched on as an import source) for display and for choosing
// what to trust. Only plain host-key lines are kept: markers (@cert-authority, @revoked), comments and
// anything malformed are dropped. Host-free: the SHA-256 is the platform's WebCrypto.
import { publicKeyInfo } from "./ssh-keys.ts";

export interface KnownHostEntry {
  /** The line, as it would be stored. */
  line: string;
  /** Host names and patterns; empty for a hashed entry (the name is not recoverable). */
  hosts: string[];
  hashed: boolean;
  keyType: string;
  fingerprint: string;
}

const MAX_LINE = 4096;

function plainLine(raw: string): string | null {
  const line = raw.trim();
  if (line === "" || line.length > MAX_LINE || line.startsWith("#") || line.startsWith("@") || /[\u0000-\u001f\u007f]/.test(line)) return null;
  return line;
}

/** Entries of a known_hosts text, keeping only lines the helper would accept. */
export async function parseKnownHosts(text: string): Promise<KnownHostEntry[]> {
  const out: KnownHostEntry[] = [];
  const seen = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = plainLine(raw);
    if (line === null || seen.has(line)) continue;
    const [hostSpec, ...rest] = line.split(" ");
    if (hostSpec === undefined || rest.length < 2) continue;
    const info = await publicKeyInfo(rest.join(" "));
    if (info === null) continue;
    const hashed = hostSpec.startsWith("|1|");
    if (!hashed && !/^[A-Za-z0-9.:,*?![\]_-]+$/.test(hostSpec)) continue;
    seen.add(line);
    out.push({ line, hosts: hashed ? [] : hostSpec.split(","), hashed, keyType: info.type, fingerprint: info.fingerprint });
  }
  return out;
}

/** A short stable key for a line (the first 16 hex of its SHA-256), for choosing it in a list. */
export async function lineKey(line: string): Promise<string> {
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(line)));
  return Array.from(digest.subarray(0, 8), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The host name a profile's destination would appear under in known_hosts: `host`, or `[host]:port` off port 22. */
export function knownHostsName(host: string, port: number | null): string {
  const h = host.toLowerCase();
  return port === null || port === 22 ? h : `[${h}]:${port}`;
}
