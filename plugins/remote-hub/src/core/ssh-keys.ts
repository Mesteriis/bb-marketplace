// Key metadata without key material (stage 3c). Public keys are read for their type, comment and
// SHA-256 fingerprint. A PRIVATE key file is never opened by this plugin's import: not for its header,
// not to learn whether a passphrase protects it (the user says so when saving a passphrase).
// Host-free: the SHA-256 is the platform's WebCrypto (`crypto.subtle`), text comes in.

export interface PublicKeyInfo {
  type: string;
  comment: string;
  /** SHA256:<base64 without padding>, as `ssh-keygen -lf` prints it. */
  fingerprint: string;
}

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
