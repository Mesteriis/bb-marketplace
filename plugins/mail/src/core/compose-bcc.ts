// The Bcc header of the Sent copy. The MIME is built once, without Bcc, and
// those exact bytes go to SMTP; the copy appended to Sent (or Drafts) gets
// one folded, ASCII-only Bcc line spliced into its header block here, and is
// otherwise byte-for-byte the same.

/** Longest physical header line written. */
const FOLD_AT = 76;
const PRINTABLE_ASCII = /^[\u0020-\u007e]+$/;
const ADDRESS = /^[\u0021-\u007e]+@[\u0021-\u007e]+$/;

/**
 * "Bcc: a, b\r\n" folded at 76 columns, or null without recipients. A display
 * name is kept (quoted) only when it is printable ASCII; the address must be
 * ASCII already (outgoing addresses are punycoded), or this throws.
 */
export function bccHeaderLine(bcc: { name: string | null; address: string }[]): string | null {
  if (bcc.length === 0) return null;
  const items = bcc.map((entry) => {
    if (!ADDRESS.test(entry.address) || /[<>,;"\\]/.test(entry.address)) {
      throw new Error("A Bcc address is not plain ASCII");
    }
    const name = entry.name?.trim() ?? "";
    if (name === "" || !PRINTABLE_ASCII.test(name)) return entry.address;
    return `"${name.replace(/["\\]/g, (ch) => `\\${ch}`)}" <${entry.address}>`;
  });
  const lines: string[] = [];
  let current = "Bcc:";
  items.forEach((item, index) => {
    const piece = index < items.length - 1 ? `${item},` : item;
    if (current.length + 1 + piece.length > FOLD_AT && current !== "Bcc:") {
      lines.push(current);
      current = ` ${piece}`;
    } else {
      current += ` ${piece}`;
    }
  });
  lines.push(current);
  return `${lines.join("\r\n")}\r\n`;
}

/**
 * Inserts `line` (one Bcc header, folded, ending in CRLF) at the end of the
 * header block, before the first empty line. Every other byte is kept.
 * Throws when the message has no header block end or the line is anything
 * but one ASCII Bcc header.
 */
export function insertBccHeader(raw: Uint8Array, line: string): Uint8Array {
  if (!isBccLine(line)) throw new Error("Not a Bcc header line");
  const end = headerEnd(raw);
  if (end < 0) throw new Error("The message has no header block end");
  const bytes = new TextEncoder().encode(line);
  const out = new Uint8Array(raw.length + bytes.length);
  out.set(raw.subarray(0, end), 0);
  out.set(bytes, end);
  out.set(raw.subarray(end), end + bytes.length);
  return out;
}

function isBccLine(line: string): boolean {
  if (!line.startsWith("Bcc: ") || !line.endsWith("\r\n")) return false;
  const physical = line.slice(0, -2).split("\r\n");
  return physical.every(
    (part, index) => PRINTABLE_ASCII.test(part) && (index === 0 || part.startsWith(" ")) && part.trim() !== "",
  );
}

/** Index just after the CRLF that ends the last header line, or -1. */
function headerEnd(raw: Uint8Array): number {
  for (let i = 0; i + 3 < raw.length; i += 1) {
    if (raw[i] === 0x0d && raw[i + 1] === 0x0a && raw[i + 2] === 0x0d && raw[i + 3] === 0x0a) {
      return i + 2;
    }
  }
  return -1;
}
