import { describe, expect, it } from "vitest";
import { createRdpTrustStore, fingerprintEqual, normalizeFingerprint, type PersistentRdpTrust, type TrustedRdpCert } from "./rdp-trust.ts";

const FP =
  "AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89";

describe("normalizeFingerprint", () => {
  it("uppercases and inserts colons", () => {
    expect(normalizeFingerprint("abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789")).toBe(FP);
  });
  it("accepts already colon-separated mixed case", () => {
    expect(normalizeFingerprint("ab:cd:ef:01:23:45:67:89:ab:cd:ef:01:23:45:67:89:ab:cd:ef:01:23:45:67:89:ab:cd:ef:01:23:45:67:89")).toBe(FP);
  });
  it("rejects wrong length and non-hex", () => {
    expect(normalizeFingerprint("abcd")).toBeNull();
    expect(normalizeFingerprint("g".repeat(64))).toBeNull();
    expect(normalizeFingerprint("")).toBeNull();
  });
});

describe("fingerprintEqual", () => {
  it("compares case- and colon-insensitively", () => {
    expect(fingerprintEqual(FP, FP.toLowerCase().replace(/:/g, ""))).toBe(true);
    expect(fingerprintEqual(FP, "00" + FP.slice(2))).toBe(false);
  });
  it("returns false when either is invalid", () => {
    expect(fingerprintEqual("nope", FP)).toBe(false);
    expect(fingerprintEqual(FP, "nope")).toBe(false);
  });
});

describe("createRdpTrustStore", () => {
  it("a session-trusted fingerprint is trusted and connect-without-prompt", () => {
    const store = createRdpTrustStore();
    expect(store.isTrusted("host", 3389, FP)).toBe(false);
    store.trust("host", 3389, FP);
    expect(store.isTrusted("host", 3389, FP)).toBe(true);
  });

  it("a different certificate on a trusted host:port is never auto-accepted", () => {
    const store = createRdpTrustStore();
    store.trust("host", 3389, FP);
    const other = "00" + FP.slice(2);
    expect(store.isTrusted("host", 3389, other)).toBe(false);
    // cert_changed detection: host:port has a trusted fingerprint, but not this one.
    expect(store.trustedFor("host", 3389)).toEqual([FP]);
  });

  it("trust is keyed by host:port (case-insensitive host)", () => {
    const store = createRdpTrustStore();
    store.trust("Host", 3389, FP);
    expect(store.isTrusted("host", 3389, FP)).toBe(true);
    expect(store.isTrusted("host", 3390, FP)).toBe(false);
  });

  it("normalizes before storing and ignores invalid fingerprints", () => {
    const store = createRdpTrustStore();
    store.trust("h", 3389, "ab".repeat(32)); // 64 lowercase hex, no colons
    expect(store.isTrusted("h", 3389, "AB".repeat(32))).toBe(true);
    store.trust("h", 3389, "not-a-fingerprint");
    expect(store.trustedFor("h", 3389)).toEqual([
      "AB:AB:AB:AB:AB:AB:AB:AB:AB:AB:AB:AB:AB:AB:AB:AB:AB:AB:AB:AB:AB:AB:AB:AB:AB:AB:AB:AB:AB:AB:AB:AB",
    ]);
  });

  it("clear removes everything", () => {
    const store = createRdpTrustStore();
    store.trust("h", 3389, FP);
    store.clear();
    expect(store.isTrusted("h", 3389, FP)).toBe(false);
    expect(store.trustedFor("h", 3389)).toEqual([]);
  });
});

describe("trust for good (stage 3c-2)", () => {
  const FP_A = "AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99";
  const FP_B = "99:88:77:66:55:44:33:22:11:00:FF:EE:DD:CC:BB:AA:99:88:77:66:55:44:33:22:11:00:FF:EE:DD:CC:BB:AA";
  const memory = (): PersistentRdpTrust & { rows: TrustedRdpCert[] } => {
    const rows: TrustedRdpCert[] = [];
    return {
      rows,
      all: () => [...rows],
      add: (c) => void (rows.some((r) => r.host === c.host && r.port === c.port && r.fingerprint === c.fingerprint) || rows.push(c)),
      remove: (h, p, f) => {
        const i = rows.findIndex((r) => r.host === h && r.port === p && r.fingerprint === f);
        if (i >= 0) rows.splice(i, 1);
        return i >= 0;
      },
    };
  };

  it("a certificate trusted for good survives a new store over the same storage, and only that exact certificate is trusted", () => {
    const disk = memory();
    expect(createRdpTrustStore(disk).trustAlways("Win.Example.TEST", 3389, FP_A.toLowerCase(), new Date("2026-11-18T10:00:00.000Z"))).toBe(true);
    const later = createRdpTrustStore(disk);
    expect(later.isTrusted("win.example.test", 3389, FP_A)).toBe(true);
    expect(later.isTrusted("win.example.test", 3389, FP_B)).toBe(false);
    expect(later.isTrusted("win.example.test", 3390, FP_A)).toBe(false);
    expect(later.listAlways()).toEqual([{ host: "win.example.test", port: 3389, fingerprint: FP_A, addedAt: "2026-11-18T10:00:00.000Z" }]);
    // The other certificate is a change on a host that has a trusted one, so the dialog calls it cert_changed.
    expect(later.trustedFor("win.example.test", 3389)).toEqual([FP_A]);
  });

  it("forgetting removes it for good and for the run; an unknown one is reported as not found", () => {
    const disk = memory();
    const store = createRdpTrustStore(disk);
    store.trustAlways("h", 3389, FP_A, new Date());
    store.trust("h", 3389, FP_B);
    expect(store.forget("h", 3389, FP_A)).toBe(true);
    expect(store.forget("h", 3389, FP_B)).toBe(true);
    expect(store.isTrusted("h", 3389, FP_A) || store.isTrusted("h", 3389, FP_B)).toBe(false);
    expect(disk.rows).toEqual([]);
    expect(store.forget("h", 3389, FP_A)).toBe(false);
    expect(store.forget("h", 3389, "not-a-fingerprint")).toBe(false);
  });

  it("without storage there is nothing to keep, and an invalid fingerprint is never kept", () => {
    expect(createRdpTrustStore().trustAlways("h", 1, FP_A, new Date())).toBe(false);
    const disk = memory();
    expect(createRdpTrustStore(disk).trustAlways("h", 1, "zz", new Date())).toBe(false);
    expect(disk.rows).toEqual([]);
  });
});
