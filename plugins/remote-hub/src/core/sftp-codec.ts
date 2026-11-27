// Between the contract's JSON shapes (sftp-contract.ts) and the bytes the SFTP client works with: paths, file data and
// attributes. Host-free: base64 is done here, in one pass, because a chunk is up to 4 MiB.
import type { SftpEntryAttrs } from "./sftp-client.ts";
import { SFTP_LIMITS, type SftpAttrs, type SftpPath } from "./sftp-contract.ts";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const VALUE = new Uint8Array(128).fill(255);
for (let i = 0; i < 64; i++) VALUE[ALPHABET.charCodeAt(i)] = i;

export function toBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  // In pieces: one string of 5.6 million characters built a character at a time is slow, and so is one huge apply().
  const PIECE = 3 * 8192;
  for (let at = 0; at < bytes.length; at += PIECE) {
    const end = Math.min(at + PIECE, bytes.length);
    let out = "";
    let i = at;
    for (; i + 2 < end; i += 3) {
      const n = ((bytes[i] as number) << 16) | ((bytes[i + 1] as number) << 8) | (bytes[i + 2] as number);
      out += ALPHABET[(n >> 18) & 63]! + ALPHABET[(n >> 12) & 63]! + ALPHABET[(n >> 6) & 63]! + ALPHABET[n & 63]!;
    }
    if (i < end) {
      const two = i + 1 < end;
      const n = ((bytes[i] as number) << 16) | (two ? (bytes[i + 1] as number) << 8 : 0);
      out += ALPHABET[(n >> 18) & 63]! + ALPHABET[(n >> 12) & 63]! + (two ? ALPHABET[(n >> 6) & 63]! : "=") + "=";
    }
    parts.push(out);
  }
  return parts.join("");
}

/** Decodes canonical base64 (the contract's schema already checked the alphabet, the length and the padding). */
export function fromBase64(text: string): Uint8Array {
  const n = text.length;
  const pad = n > 0 && text.charCodeAt(n - 1) === 61 ? (text.charCodeAt(n - 2) === 61 ? 2 : 1) : 0;
  const out = new Uint8Array((n / 4) * 3 - pad);
  let o = 0;
  for (let i = 0; i < n; i += 4) {
    const a = VALUE[text.charCodeAt(i)] as number;
    const b = VALUE[text.charCodeAt(i + 1)] as number;
    const c = text.charCodeAt(i + 2) === 61 ? 0 : (VALUE[text.charCodeAt(i + 2)] as number);
    const d = text.charCodeAt(i + 3) === 61 ? 0 : (VALUE[text.charCodeAt(i + 3)] as number);
    const v = (a << 18) | (b << 12) | (c << 6) | d;
    if (o < out.length) out[o++] = (v >> 16) & 255;
    if (o < out.length) out[o++] = (v >> 8) & 255;
    if (o < out.length) out[o++] = v & 255;
  }
  return out;
}

const encoder = new TextEncoder();
const strict = new TextDecoder("utf-8", { fatal: true });

/** The bytes of a path a plugin sent, or null when it is empty, holds a NUL or is longer than a path may be. */
export function pathBytes(path: SftpPath): Uint8Array | null {
  const bytes = "text" in path ? encoder.encode(path.text) : fromBase64(path.bytes);
  if (bytes.length === 0 || bytes.length > SFTP_LIMITS.pathBytes || bytes.includes(0)) return null;
  return bytes;
}

/** A path or name the server holds: `text` when the bytes are valid UTF-8 that encodes back to the same bytes, else `bytes`. */
export function pathOut(bytes: Uint8Array): SftpPath {
  try {
    const text = strict.decode(bytes);
    // A leading byte-order mark is dropped by the decoder: such a name goes out as bytes so it comes back unchanged.
    if (text.length > 0 && encoder.encode(text).length === bytes.length) return { text };
  } catch {
    // not UTF-8
  }
  return { bytes: toBase64(bytes) };
}

export function attrsOut(attrs: SftpEntryAttrs): SftpAttrs {
  return { type: attrs.type, size: attrs.size.toString(), mtime: attrs.mtime, mode: attrs.mode, linkTarget: attrs.linkTarget === null || attrs.linkTarget.length === 0 ? null : pathOut(attrs.linkTarget) };
}
