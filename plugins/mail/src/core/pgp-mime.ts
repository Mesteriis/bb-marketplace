// PGP/MIME (RFC 3156) on raw message bytes (slice 3k). Outgoing: the built
// message is split into its outer headers and its content, and the content
// is wrapped as multipart/signed or multipart/encrypted. Incoming: the
// signed content and its signature, or the encrypted block, are cut out of
// the raw message exactly as they came, because a signature is over bytes.
// Pure: the cryptography is behind the PgpEngine port.

const CRLF = "\r\n";
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: false });

/** Headers that describe the content and move inside the protected part. */
const CONTENT_HEADERS = /^content-(type|transfer-encoding|disposition|description|id|language)$/i;

/** How large a message the PGP paths read: the send cap plus encoding overhead. */
export const PGP_RAW_MAX_BYTES = 60 * 1024 * 1024;

export class PgpMimeError extends Error {
  constructor(readonly kind: "malformed" | "too_large" | "not_pgp") {
    super(kind);
    this.name = "PgpMimeError";
  }
}

function latin1(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 8192) out += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return out;
}

/** Index of the first blank line's end (after CRLF CRLF, or LF LF); -1 when the message has no body. */
function headerEnd(bytes: Uint8Array): { headersEnd: number; bodyStart: number } | null {
  for (let i = 0; i < bytes.length - 1; i++) {
    if (bytes[i] !== 10) continue;
    if (bytes[i + 1] === 10) return { headersEnd: i + 1, bodyStart: i + 2 };
    if (bytes[i + 1] === 13 && bytes[i + 2] === 10) return { headersEnd: i + 1, bodyStart: i + 3 };
  }
  return null;
}

type HeaderField = { name: string; raw: string };

/** Header fields with their folded continuation lines, as written. */
function headerFields(block: string): HeaderField[] {
  const fields: HeaderField[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (line === "") continue;
    if (/^[ \t]/.test(line) && fields.length > 0) {
      fields[fields.length - 1]!.raw += CRLF + line;
      continue;
    }
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    fields.push({ name: line.slice(0, colon).trim(), raw: line });
  }
  return fields;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** A built message as its outer header lines and the entity (content headers, blank line, body) to protect. */
export function splitForProtection(raw: Uint8Array): { outer: string[]; entity: Uint8Array } {
  if (raw.length > PGP_RAW_MAX_BYTES) throw new PgpMimeError("too_large");
  const cut = headerEnd(raw);
  if (cut === null) throw new PgpMimeError("malformed");
  const fields = headerFields(latin1(raw.subarray(0, cut.headersEnd)));
  const outer = fields.filter((f) => !CONTENT_HEADERS.test(f.name) && !/^mime-version$/i.test(f.name)).map((f) => f.raw);
  const inner = fields.filter((f) => CONTENT_HEADERS.test(f.name)).map((f) => f.raw);
  if (inner.length === 0) inner.push("Content-Type: text/plain; charset=us-ascii");
  // The body without the builder's final line break: the boundary line brings its own.
  let end = raw.length;
  if (end >= 2 && raw[end - 2] === 13 && raw[end - 1] === 10) end -= 2;
  else if (end >= 1 && raw[end - 1] === 10) end -= 1;
  const entity = concat([encoder.encode(inner.join(CRLF) + CRLF + CRLF), raw.subarray(cut.bodyStart, Math.max(cut.bodyStart, end))]);
  return { outer, entity };
}

/** A boundary that does not occur in the parts; `seed` makes it unique per message. */
export function boundaryFor(seed: string, parts: Uint8Array[]): string {
  const safe = seed.replace(/[^A-Za-z0-9]/g, "").slice(0, 40) || "part";
  for (let n = 0; n < 1000; n++) {
    const boundary = `----makosh-pgp-${safe}-${n}`;
    const needle = `--${boundary}`;
    if (!parts.some((part) => latin1(part).includes(needle))) return boundary;
  }
  throw new PgpMimeError("malformed");
}

/** multipart/signed around the entity, with a detached armored signature over the entity's exact bytes. */
export function wrapSigned(outer: string[], entity: Uint8Array, signatureArmor: string, boundary: string): Uint8Array {
  const head = [
    ...outer,
    "MIME-Version: 1.0",
    `Content-Type: multipart/signed; micalg=pgp-sha256; protocol="application/pgp-signature"; boundary="${boundary}"`,
    "",
    "This is an OpenPGP/MIME signed message (RFC 3156).",
    `--${boundary}`,
    "",
  ].join(CRLF);
  const tail = [
    "",
    `--${boundary}`,
    'Content-Type: application/pgp-signature; name="signature.asc"',
    "Content-Description: OpenPGP digital signature",
    'Content-Disposition: attachment; filename="signature.asc"',
    "",
    signatureArmor.trim().replace(/\r?\n/g, CRLF),
    `--${boundary}--`,
    "",
  ].join(CRLF);
  return concat([encoder.encode(head), entity, encoder.encode(tail)]);
}

/** multipart/encrypted with the armored message (which holds the entity, signed or not). */
export function wrapEncrypted(outer: string[], messageArmor: string, boundary: string): Uint8Array {
  return encoder.encode(
    [
      ...outer,
      "MIME-Version: 1.0",
      `Content-Type: multipart/encrypted; protocol="application/pgp-encrypted"; boundary="${boundary}"`,
      "",
      "This is an OpenPGP/MIME encrypted message (RFC 3156).",
      `--${boundary}`,
      "Content-Type: application/pgp-encrypted",
      "Content-Description: PGP/MIME version identification",
      "",
      "Version: 1",
      "",
      `--${boundary}`,
      'Content-Type: application/octet-stream; name="encrypted.asc"',
      "Content-Description: OpenPGP encrypted message",
      'Content-Disposition: inline; filename="encrypted.asc"',
      "",
      messageArmor.trim().replace(/\r?\n/g, CRLF),
      `--${boundary}--`,
      "",
    ].join(CRLF),
  );
}

/** The boundary parameter of a multipart Content-Type value, or null. */
function boundaryOf(contentType: string): string | null {
  const match = /;\s*boundary\s*=\s*(?:"([^"]{1,200})"|([^\s;"]{1,200}))/i.exec(contentType);
  return match === null ? null : (match[1] ?? match[2] ?? null);
}

function contentTypeOf(headers: string): string {
  const field = headerFields(headers).find((f) => /^content-type$/i.test(f.name));
  return field === undefined ? "" : field.raw.slice(field.raw.indexOf(":") + 1).replace(/\r?\n[ \t]+/g, " ").trim();
}

/** The byte ranges of a multipart body's parts: each part without the line break that belongs to the next boundary. */
function partsOf(raw: Uint8Array, bodyStart: number, boundary: string): { start: number; end: number }[] {
  const text = latin1(raw.subarray(bodyStart));
  const marker = `--${boundary}`;
  const parts: { start: number; end: number }[] = [];
  let open: number | null = null;
  let at = 0;
  while (at <= text.length) {
    const found = text.indexOf(marker, at);
    if (found < 0) break;
    const lineStart = found === 0 || text[found - 1] === "\n";
    const after = text.slice(found + marker.length, found + marker.length + 4);
    const closing = after.startsWith("--");
    const lineEnd = text.indexOf("\n", found);
    const restOk = closing || /^[ \t]*\r?\n/.test(after) || lineEnd < 0;
    if (!lineStart || !restOk) {
      at = found + marker.length;
      continue;
    }
    if (open !== null) {
      // The CRLF (or LF) before the boundary line belongs to the boundary.
      let end = found;
      if (end >= 2 && text[end - 2] === "\r" && text[end - 1] === "\n") end -= 2;
      else if (end >= 1 && text[end - 1] === "\n") end -= 1;
      parts.push({ start: bodyStart + open, end: bodyStart + Math.max(open, end) });
    }
    if (closing || lineEnd < 0) return parts;
    open = lineEnd + 1;
    at = lineEnd + 1;
    if (parts.length > 50) throw new PgpMimeError("malformed");
  }
  return parts;
}

function bodyOfPart(part: Uint8Array): { headers: string; body: Uint8Array } {
  const cut = headerEnd(part);
  if (cut === null) {
    // A part that starts with a blank line has no headers.
    if (part[0] === 13 && part[1] === 10) return { headers: "", body: part.subarray(2) };
    if (part[0] === 10) return { headers: "", body: part.subarray(1) };
    return { headers: latin1(part), body: new Uint8Array() };
  }
  return { headers: latin1(part.subarray(0, cut.headersEnd)), body: part.subarray(cut.bodyStart) };
}

/** The first armored block of `kind` in text, or null. */
export function armorBlock(text: string, kind: "MESSAGE" | "SIGNATURE" | "PUBLIC KEY BLOCK" | "PRIVATE KEY BLOCK"): string | null {
  const begin = `-----BEGIN PGP ${kind}-----`;
  const end = `-----END PGP ${kind}-----`;
  const from = text.indexOf(begin);
  if (from < 0) return null;
  const to = text.indexOf(end, from);
  if (to < 0) return null;
  return text.slice(from, to + end.length);
}

/** A multipart/signed message's signed entity (exact bytes) and its armored signature. */
export function extractSigned(raw: Uint8Array): { entity: Uint8Array; signatureArmor: string } {
  if (raw.length > PGP_RAW_MAX_BYTES) throw new PgpMimeError("too_large");
  const cut = headerEnd(raw);
  if (cut === null) throw new PgpMimeError("malformed");
  const type = contentTypeOf(latin1(raw.subarray(0, cut.headersEnd)));
  if (!/^multipart\/signed\b/i.test(type) || !/application\/pgp-signature/i.test(type)) throw new PgpMimeError("not_pgp");
  const boundary = boundaryOf(type);
  if (boundary === null) throw new PgpMimeError("malformed");
  const parts = partsOf(raw, cut.bodyStart, boundary);
  if (parts.length < 2) throw new PgpMimeError("malformed");
  const entity = raw.subarray(parts[0]!.start, parts[0]!.end);
  const signature = bodyOfPart(raw.subarray(parts[1]!.start, parts[1]!.end));
  const armor = armorBlock(decoder.decode(signature.body), "SIGNATURE");
  if (armor === null) throw new PgpMimeError("malformed");
  return { entity, signatureArmor: armor };
}

/** The armored PGP message of a multipart/encrypted mail, or of a body that is one armored block. */
export function extractEncrypted(raw: Uint8Array): string {
  if (raw.length > PGP_RAW_MAX_BYTES) throw new PgpMimeError("too_large");
  const cut = headerEnd(raw);
  if (cut === null) throw new PgpMimeError("malformed");
  const type = contentTypeOf(latin1(raw.subarray(0, cut.headersEnd)));
  if (/^multipart\/encrypted\b/i.test(type)) {
    const boundary = boundaryOf(type);
    if (boundary === null) throw new PgpMimeError("malformed");
    for (const range of partsOf(raw, cut.bodyStart, boundary).slice(0, 4)) {
      const armor = armorBlock(decoder.decode(bodyOfPart(raw.subarray(range.start, range.end)).body), "MESSAGE");
      if (armor !== null) return armor;
    }
    throw new PgpMimeError("malformed");
  }
  const inline = armorBlock(decoder.decode(raw.subarray(cut.bodyStart)), "MESSAGE");
  if (inline === null) throw new PgpMimeError("not_pgp");
  return inline;
}

/** Armored public keys attached to or pasted into a message (at most 5). */
export function publicKeyBlocks(text: string): string[] {
  const blocks: string[] = [];
  let rest = text;
  for (let n = 0; n < 5; n++) {
    const block = armorBlock(rest, "PUBLIC KEY BLOCK");
    if (block === null) break;
    blocks.push(block);
    rest = rest.slice(rest.indexOf(block) + block.length);
  }
  return blocks;
}
