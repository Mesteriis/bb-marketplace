// Key metadata without key material (stage 3c). Public keys are read for their type, comment and
// SHA-256 fingerprint. A private key file is looked at through its first bytes only, to learn the
// format and whether it is passphrase-protected; nothing from it is ever returned except those
// two facts. Host-free: the SHA-256 is the platform's WebCrypto (`crypto.subtle`), bytes come in.

export interface PublicKeyInfo {
  type: string;
  comment: string;
  /** SHA256:<base64 without padding>, as `ssh-keygen -lf` prints it. */
  fingerprint: string;
}

export interface PrivateKeyHead {
  format: "openssh" | "pem" | "pkcs8" | "unknown";
  /** True/false when the head says; null when it cannot be told from the head. */
  encrypted: boolean | null;
  /** From a PEM header (RSA, EC, DSA); null for the formats that do not say. */
  type: string | null;
}

/** How much of a private key file may be looked at. */
export const PRIVATE_KEY_HEAD_BYTES = 512;

function base64ToBytes(b64: string): Uint8Array | null {
  try {
    const binary = atob(b64);
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

function bytesToBase64NoPad(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/=+$/, "");
}

const PUBLIC_TYPES = /^(ssh-(rsa|dss|ed25519)|ecdsa-sha2-nistp(256|384|521)|sk-(ssh-ed25519|ecdsa-sha2-nistp256)@openssh\.com)$/;

/** One line of an OpenSSH public key file ("type base64 [comment]"), or null. */
export async function publicKeyInfo(line: string): Promise<PublicKeyInfo | null> {
  const match = /^\s*(?:[^\s]+\s+)?(ssh-[a-z0-9]+|ecdsa-sha2-nistp\d+|sk-[a-z0-9@.-]+)\s+([A-Za-z0-9+/=]+)(?:\s+(.*))?$/.exec(line);
  if (match === null) return null;
  const [, type, b64, comment] = match as unknown as [string, string, string, string | undefined];
  if (!PUBLIC_TYPES.test(type)) return null;
  const blob = base64ToBytes(b64);
  if (blob === null || blob.length < 8) return null;
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", blob as BufferSource));
  return { type, comment: (comment ?? "").trim().slice(0, 200), fingerprint: "SHA256:" + bytesToBase64NoPad(digest) };
}

const PEM_TYPES: Record<string, string> = { "RSA PRIVATE KEY": "RSA", "EC PRIVATE KEY": "EC", "DSA PRIVATE KEY": "DSA" };

/** The format and protection of a private key, from at most the first PRIVATE_KEY_HEAD_BYTES bytes. */
export function classifyPrivateKeyHead(head: Uint8Array): PrivateKeyHead {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(head.subarray(0, PRIVATE_KEY_HEAD_BYTES));
  const lines = text.split(/\r?\n/);
  const first = (lines[0] ?? "").trim();
  const begin = /^-----BEGIN ([A-Z0-9 ]+)-----$/.exec(first);
  if (begin === null) return { format: "unknown", encrypted: null, type: null };
  const label = begin[1] as string;
  if (label === "OPENSSH PRIVATE KEY") {
    // "openssh-key-v1\0", then the cipher name as a length-prefixed string: "none" means no passphrase.
    const body = lines.slice(1).join("").replace(/-----.*$/, "").replace(/[^A-Za-z0-9+/]/g, "");
    const raw = base64ToBytes(body.slice(0, Math.floor(body.length / 4) * 4));
    const magic = "openssh-key-v1\0";
    if (raw === null || raw.length < magic.length + 4) return { format: "openssh", encrypted: null, type: null };
    if (String.fromCharCode(...raw.subarray(0, magic.length)) !== magic) return { format: "openssh", encrypted: null, type: null };
    const at = magic.length;
    const len = ((raw[at] as number) << 24) | ((raw[at + 1] as number) << 16) | ((raw[at + 2] as number) << 8) | (raw[at + 3] as number);
    if (len < 1 || len > 32 || raw.length < at + 4 + len) return { format: "openssh", encrypted: null, type: null };
    const cipher = String.fromCharCode(...raw.subarray(at + 4, at + 4 + len));
    return { format: "openssh", encrypted: cipher !== "none", type: null };
  }
  if (label === "ENCRYPTED PRIVATE KEY") return { format: "pkcs8", encrypted: true, type: null };
  if (label === "PRIVATE KEY") return { format: "pkcs8", encrypted: false, type: null };
  if (label in PEM_TYPES) {
    const encrypted = /^Proc-Type:\s*4,ENCRYPTED/m.test(lines.slice(1, 4).join("\n"));
    return { format: "pem", encrypted, type: PEM_TYPES[label] as string };
  }
  return { format: "unknown", encrypted: null, type: null };
}

export interface AgentKey {
  type: string;
  bits: number;
  fingerprint: string;
  comment: string;
}

/** `ssh-add -l` output: "256 SHA256:abc comment (ED25519)" per line; "no identities" is an empty list. */
export function parseAgentList(output: string): AgentKey[] {
  const keys: AgentKey[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = /^(\d+)\s+((?:SHA256|MD5):\S+)\s+(.*?)\s+\(([A-Za-z0-9-]+)\)\s*$/.exec(line.trim());
    if (match === null) continue;
    keys.push({ bits: Number(match[1]), fingerprint: match[2] as string, comment: (match[3] as string).slice(0, 200), type: match[4] as string });
  }
  return keys;
}
