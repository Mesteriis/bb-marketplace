// Host-free RDP certificate trust: for one BB run (stage 2b) and, since stage 3c-2, kept for good when
// the user chose "always trust" (a storage port keeps those; the SQLite adapter lives outside the core).
//
// Trust is keyed by "host:port" plus the SHA-256 fingerprint of the presented
// certificate. "Trust for this BB run" stores a fingerprint; a later connect
// presenting the SAME fingerprint is auto-accepted, while a DIFFERENT
// certificate on a trusted host:port yields a cert_changed prompt and is never
// auto-accepted. No wildcard, no "trust this host" without a fingerprint.

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

/** A certificate the user trusted for good. */
export interface TrustedRdpCert {
  host: string;
  port: number;
  /** Normalised: 64 uppercase hex, colon-separated. */
  fingerprint: string;
  addedAt: string;
}

/** Where "always trust" decisions are kept (metadata only: no secret, no certificate body). */
export interface PersistentRdpTrust {
  all(): TrustedRdpCert[];
  add(cert: TrustedRdpCert): void;
  remove(host: string, port: number, fingerprint: string): boolean;
}

export interface RdpTrustStore {
  /** Trust for good (kept by the persistent port); false when there is no such port or the fingerprint is not valid. */
  trustAlways(host: string, port: number, fingerprint: string, now: Date): boolean;
  /** Every certificate trusted for good, newest last. */
  listAlways(): TrustedRdpCert[];
  /** Forget one exact certificate, trusted for a run or for good. */
  forget(host: string, port: number, fingerprint: string): boolean;
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

export function createRdpTrustStore(persistent?: PersistentRdpTrust): RdpTrustStore {
  const byHostPort = new Map<string, Set<string>>();
  const kept = (host: string, port: number): string[] =>
    (persistent?.all() ?? []).filter((c) => keyOf(c.host, c.port) === keyOf(host, port)).map((c) => c.fingerprint);

  return {
    trustAlways(host, port, fingerprint, now) {
      const normalized = normalizeFingerprint(fingerprint);
      if (normalized === null || persistent === undefined) return false;
      persistent.add({ host: host.toLowerCase(), port, fingerprint: normalized, addedAt: now.toISOString() });
      return true;
    },
    listAlways() {
      return persistent?.all() ?? [];
    },
    forget(host, port, fingerprint) {
      const normalized = normalizeFingerprint(fingerprint);
      if (normalized === null) return false;
      const key = keyOf(host, port);
      const inRun = byHostPort.get(key)?.delete(normalized) ?? false;
      const forgotten = persistent?.remove(host.toLowerCase(), port, normalized) ?? false;
      return inRun || forgotten;
    },
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
      return (byHostPort.get(keyOf(host, port))?.has(normalized) ?? false) || kept(host, port).includes(normalized);
    },
    trustedFor(host, port) {
      return Array.from(new Set([...(byHostPort.get(keyOf(host, port)) ?? []), ...kept(host, port)])).sort();
    },
    clear() {
      byHostPort.clear();
    },
  };
}
