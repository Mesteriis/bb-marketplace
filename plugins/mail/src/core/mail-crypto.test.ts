import { describe, expect, it } from "vitest";
import { cryptoKindOf, firstNonBlankLine, isEncrypted } from "./mail-crypto.ts";

describe("cryptoKindOf", () => {
  it("recognises PGP/MIME", () => {
    expect(cryptoKindOf('multipart/signed; micalg=pgp-sha256; protocol="application/pgp-signature"; boundary="b1"', null)).toEqual({
      kind: "pgp_signed",
      opaque: false,
    });
    expect(cryptoKindOf('Multipart/Encrypted; protocol="application/pgp-encrypted"; boundary=b2', null)).toEqual({
      kind: "pgp_encrypted",
      opaque: false,
    });
  });

  it("recognises S/MIME signed and encrypted", () => {
    expect(cryptoKindOf('multipart/signed; protocol="application/pkcs7-signature"; micalg=sha-256; boundary=b', null)?.kind).toBe(
      "smime_signed",
    );
    expect(cryptoKindOf("multipart/signed; protocol=application/x-pkcs7-signature; boundary=b", null)?.kind).toBe("smime_signed");
    expect(cryptoKindOf('application/pkcs7-mime; smime-type=signed-data; name="smime.p7m"', null)).toEqual({
      kind: "smime_signed",
      opaque: true,
    });
    for (const type of [
      'application/pkcs7-mime; smime-type=enveloped-data; name="smime.p7m"',
      "application/pkcs7-mime; smime-type=authEnveloped-data",
      'application/x-pkcs7-mime; name="smime.p7m"',
    ]) {
      expect(cryptoKindOf(type, null), type).toEqual({ kind: "smime_encrypted", opaque: false });
    }
  });

  it("does not call compressed or certificate-only S/MIME encrypted", () => {
    expect(cryptoKindOf("application/pkcs7-mime; smime-type=compressed-data", null)).toBeNull();
    expect(cryptoKindOf("application/pkcs7-mime; smime-type=certs-only", null)).toBeNull();
  });

  it("reads inline armor on the first non-blank line only", () => {
    expect(cryptoKindOf("text/plain", "-----BEGIN PGP MESSAGE-----")).toEqual({ kind: "pgp_encrypted", opaque: false });
    expect(cryptoKindOf(null, "-----BEGIN PGP SIGNED MESSAGE-----  ")).toEqual({ kind: "pgp_signed", opaque: false });
    expect(firstNonBlankLine("\r\n  \n-----BEGIN PGP MESSAGE-----\nVersion: x\n")).toBe("-----BEGIN PGP MESSAGE-----");
    const quoted = "Hi,\n\nHere it is:\n-----BEGIN PGP MESSAGE-----\n";
    expect(cryptoKindOf("text/plain", firstNonBlankLine(quoted))).toBeNull();
    expect(firstNonBlankLine("")).toBeNull();
  });

  it("is null for ordinary mail", () => {
    expect(cryptoKindOf("multipart/alternative; boundary=x", "Hello")).toBeNull();
    expect(cryptoKindOf("multipart/signed; protocol=application/other", null)).toBeNull();
    expect(cryptoKindOf(null, null)).toBeNull();
  });

  it("knows which kinds are encrypted", () => {
    expect(isEncrypted("pgp_encrypted")).toBe(true);
    expect(isEncrypted("smime_encrypted")).toBe(true);
    expect(isEncrypted("pgp_signed")).toBe(false);
    expect(isEncrypted("smime_signed")).toBe(false);
    expect(isEncrypted(null)).toBe(false);
  });
});
