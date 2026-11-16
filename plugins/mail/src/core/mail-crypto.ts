// Signed and encrypted mail (slice 3i, #92 and #97 partly): recognised from
// the top Content-Type and inline armor, never verified or decrypted (3k).
// Pure; no key material is read or kept.
import { parseStructuredHeader } from "./headers.ts";

export const CRYPTO_KINDS = ["pgp_signed", "pgp_encrypted", "smime_signed", "smime_encrypted"] as const;
export type CryptoKind = (typeof CRYPTO_KINDS)[number];

/** `opaque`: S/MIME signed-data, whose text is inside the signature (resolution 20). */
export type MailCrypto = { kind: CryptoKind; opaque: boolean };

const LINE_MAX = 2_048;
const SCAN_MAX = 64 * 1024;

/** The first line of the text that is not blank, trimmed; null when there is none in the first 64 KB. */
export function firstNonBlankLine(text: string | null): string | null {
  if (text === null) return null;
  for (const line of text.slice(0, SCAN_MAX).split(/\r\n|\r|\n/)) {
    const trimmed = line.trim();
    if (trimmed !== "") return trimmed.slice(0, LINE_MAX);
  }
  return null;
}

/**
 * What a message is from its top Content-Type and the first non-blank line
 * of its text: PGP/MIME and S/MIME by type and protocol, inline PGP armor
 * only as that first line. Null for ordinary mail.
 */
export function cryptoKindOf(contentType: string | null, firstLine: string | null): MailCrypto | null {
  if (contentType !== null) {
    const parsed = parseStructuredHeader(contentType.slice(0, LINE_MAX));
    const type = parsed.token.trim().toLowerCase();
    const protocol = (parsed.params.get("protocol") ?? "").trim().toLowerCase();
    if (type === "multipart/signed") {
      if (protocol === "application/pgp-signature") return { kind: "pgp_signed", opaque: false };
      if (protocol === "application/pkcs7-signature" || protocol === "application/x-pkcs7-signature") {
        return { kind: "smime_signed", opaque: false };
      }
    }
    if (type === "multipart/encrypted" && protocol === "application/pgp-encrypted") return { kind: "pgp_encrypted", opaque: false };
    if (type === "application/pkcs7-mime" || type === "application/x-pkcs7-mime") {
      const smime = parsed.params.get("smime-type")?.trim().toLowerCase();
      if (smime === undefined || smime === "" || smime === "enveloped-data" || smime === "authenveloped-data") {
        return { kind: "smime_encrypted", opaque: false };
      }
      if (smime === "signed-data") return { kind: "smime_signed", opaque: true };
      return null;
    }
  }
  const line = firstLine?.trim() ?? null;
  if (line === "-----BEGIN PGP MESSAGE-----") return { kind: "pgp_encrypted", opaque: false };
  if (line === "-----BEGIN PGP SIGNED MESSAGE-----") return { kind: "pgp_signed", opaque: false };
  return null;
}

/** Whether the body is ciphertext that must reach no reader (resolution 6). */
export function isEncrypted(kind: CryptoKind | null | undefined): boolean {
  return kind === "pgp_encrypted" || kind === "smime_encrypted";
}
