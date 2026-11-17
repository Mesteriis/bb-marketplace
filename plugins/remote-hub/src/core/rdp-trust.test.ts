import { describe, expect, it } from "vitest";
import { createRdpTrustStore, fingerprintEqual, normalizeFingerprint } from "./rdp-trust.ts";

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
