// Host-free, in-memory RDP certificate trust for one BB run (stage 2b).
//
// Trust is keyed by "host:port" plus the SHA-256 fingerprint of the presented
// certificate. "Trust for this BB run" stores a fingerprint; a later connect
// presenting the SAME fingerprint is auto-accepted, while a DIFFERENT
// certificate on a trusted host:port yields a cert_changed prompt and is never
// auto-accepted. No wildcard, no "trust this host" without a fingerprint.
// Stage 3 adds storage; this module is pure logic only.

/** Normalize a SHA-256 fingerprint to 64 uppercase hex, colon-separated.
 *  Returns null when the input is not exactly 32 bytes of hex (optionally
 *  already colon-separated). */
export function normalizeFingerprint(input: string): string | null {
  const hex = input.replace(/:/g, "").trim();
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) return null;
  const upper = hex.toUpperCase();
  let out = "";
  for (let i = 0; i < upper.length; i += 2) {
    if (i > 0) out += ":";
    out += upper.slice(i, i + 2);
  }
  return out;
}

/** Compare two fingerprints independent of case and colons. */
export function fingerprintEqual(a: string, b: string): boolean {
  const na = normalizeFingerprint(a);
  const nb = normalizeFingerprint(b);
  return na !== null && na === nb;
}

export interface RdpTrustStore {
  /** Record a session-trusted fingerprint for host:port. */
  trust(host: string, port: number, fingerprint: string): void;
  /** Whether this exact fingerprint is trusted for host:port. */
  isTrusted(host: string, port: number, fingerprint: string): boolean;
  /** Every trusted fingerprint for host:port (empty when none). */
  trustedFor(host: string, port: number): string[];
  clear(): void;
}

function keyOf(host: string, port: number): string {
  return host.toLowerCase() + ":" + port;
}

export function createRdpTrustStore(): RdpTrustStore {
  const byHostPort = new Map<string, Set<string>>();

  return {
    trust(host, port, fingerprint) {
      const normalized = normalizeFingerprint(fingerprint);
      if (normalized === null) return;
      const key = keyOf(host, port);
      let set = byHostPort.get(key);
      if (set === undefined) {
        set = new Set();
        byHostPort.set(key, set);
      }
      set.add(normalized);
    },
    isTrusted(host, port, fingerprint) {
      const normalized = normalizeFingerprint(fingerprint);
      if (normalized === null) return false;
      return byHostPort.get(keyOf(host, port))?.has(normalized) ?? false;
    },
    trustedFor(host, port) {
      return Array.from(byHostPort.get(keyOf(host, port)) ?? []).sort();
    },
    clear() {
      byHostPort.clear();
    },
  };
}
