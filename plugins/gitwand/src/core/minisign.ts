// minisign public keys and signatures (https://jedisct1.github.io/minisign/).
// Parsing only; the Ed25519 checks run in the host adapter. A signature is
// valid when, with the key whose id it names:
//   "Ed": signature verifies over the file itself,
//   "ED": signature verifies over BLAKE2b-512 of the file,
//   and globalSignature verifies over signature ‖ trusted comment.

export interface MinisignPublicKey {
  keyId: string;
  publicKey: Uint8Array;
}

export interface MinisignSignature {
  algorithm: "Ed" | "ED";
  keyId: string;
  signature: Uint8Array;
  trustedComment: string;
  globalSignature: Uint8Array;
}

function decode(text: string): Uint8Array | null {
  try {
    return Uint8Array.from(atob(text.trim()), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
const lines = (text: string) => text.replace(/\r\n/g, "\n").split("\n").filter((l) => l !== "");

export function parseMinisignPublicKey(text: string): MinisignPublicKey {
  const all = lines(text);
  const raw = decode(all[1] ?? "");
  if (all.length !== 2 || raw === null || raw.length !== 42 || raw[0] !== 0x45 || raw[1] !== 0x64) {
    throw new Error("invalid minisign public key");
  }
  return { keyId: hex(raw.slice(2, 10)), publicKey: raw.slice(10) };
}

export function parseMinisignSignature(text: string): MinisignSignature {
  const all = lines(text);
  const raw = decode(all[1] ?? "");
  const global = decode(all[3] ?? "");
  const prefix = "trusted comment: ";
  if (all.length !== 4 || raw === null || raw.length !== 74 || global === null || global.length !== 64 || !all[2].startsWith(prefix)) {
    throw new Error("invalid minisign signature");
  }
  const algorithm = String.fromCharCode(raw[0], raw[1]);
  if (algorithm !== "Ed" && algorithm !== "ED") throw new Error("invalid minisign signature: unknown algorithm");
  return { algorithm, keyId: hex(raw.slice(2, 10)), signature: raw.slice(10), trustedComment: all[2].slice(prefix.length), globalSignature: global };
}
