// Ed25519 checks for minisign signatures with node:crypto. Parsing lives in
// the core (src/core/minisign.ts).
import { createHash, createPublicKey, verify } from "node:crypto";
import { parseMinisignPublicKey, parseMinisignSignature, type MinisignSignature } from "../../core/minisign.ts";

export type MinisignResult = { ok: true; trustedComment: string } | { ok: false; reason: string };

function ed25519Key(raw: Uint8Array) {
  return createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(raw).toString("base64url") }, format: "jwk" });
}

/** Verifies `data` against a minisign signature file and public key file. */
export function verifyMinisign(data: Uint8Array, signatureText: string, publicKeyText: string): MinisignResult {
  let sig: MinisignSignature;
  try {
    sig = parseMinisignSignature(signatureText);
  } catch (error) {
    return { ok: false, reason: (error as Error).message };
  }
  const key = parseMinisignPublicKey(publicKeyText);
  if (sig.keyId !== key.keyId) return { ok: false, reason: "signed by another key" };
  const pk = ed25519Key(key.publicKey);
  const message = sig.algorithm === "ED" ? createHash("blake2b512").update(data).digest() : Buffer.from(data);
  if (!verify(null, message, pk, sig.signature)) return { ok: false, reason: "signature does not match the file" };
  const global = Buffer.concat([Buffer.from(sig.signature), Buffer.from(sig.trustedComment, "utf8")]);
  if (!verify(null, global, pk, sig.globalSignature)) return { ok: false, reason: "trusted comment is not signed" };
  return { ok: true, trustedComment: sig.trustedComment };
}
