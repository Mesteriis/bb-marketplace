// Outgoing addresses: parse what the owner typed or pasted into one address,
// split a pasted list, compare and dedupe. 3b sends without SMTPUTF8, so a
// local part must be ASCII; a domain may be typed as an IDN and is punycoded
// here (through the global WHATWG URL parser, so the core imports nothing).

/** An address the composer can put into a header. `address` is ASCII, its domain punycoded. */
export type OutgoingAddress = { name: string | null; address: string };

export type AddressProblem = "empty" | "too_long" | "control" | "syntax" | "non_ascii_local";

export type ParsedAddress =
  | { ok: true; value: OutgoingAddress }
  | { ok: false; problem: AddressProblem };

/** Longest input taken as one address, display name included. */
const MAX_INPUT = 320;
const MIN_ADDRESS = 3;
const MAX_LOCAL = 64;
const MAX_LABEL = 63;
const MAX_DOMAIN = 253;

// C0 controls (tab included), DEL, C1 controls, and the percent-encoded forms
// of CR, LF and NUL, which some layer downstream might decode.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]|%0[ad0]/i;
// RFC 5322 atext.
const ATEXT = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+$/;
const ASCII = /^[ -~]*$/;
const LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
// ASCII characters a typed domain may hold; anything else ASCII is refused
// before the URL parser can read it as a port, path, credential or IP.
const DOMAIN_ASCII = /^[A-Za-z0-9.-]$/;

export function parseAddress(input: string): ParsedAddress {
  const text = input.trim();
  if (text === "") return { ok: false, problem: "empty" };
  if (CONTROL.test(text)) return { ok: false, problem: "control" };
  if (text.length > MAX_INPUT) return { ok: false, problem: "too_long" };

  const parts = splitNameAndAddress(text);
  if (parts === null) return { ok: false, problem: "syntax" };
  const checked = checkAddress(parts.address);
  if (!checked.ok) return checked;
  return { ok: true, value: { name: parts.name, address: checked.address } };
}

/** The domain in ASCII form: lowercased, IDN labels punycoded. Throws when it is not a usable host name. */
export function toAsciiDomain(domain: string): string {
  if (domain === "" || [...domain].some((ch) => ch.charCodeAt(0) < 0x80 && !DOMAIN_ASCII.test(ch))) {
    throw new Error("Invalid domain");
  }
  const host = new URL(`http://${domain}/`).hostname;
  if (host === "") throw new Error("Invalid domain");
  return host;
}

/** Splits pasted text into address candidates at commas, semicolons and line breaks outside quotes and angle brackets. */
export function splitAddressList(text: string): string[] {
  const pieces: string[] = [];
  let current = "";
  let quoted = false;
  let angle = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] ?? "";
    if (quoted) {
      current += ch;
      if (ch === "\\" && i + 1 < text.length) {
        current += text[i + 1] ?? "";
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      }
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === "<") angle = true;
    else if (ch === ">") angle = false;
    else if (!angle && (ch === "," || ch === ";" || ch === "\n" || ch === "\r")) {
      pieces.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  pieces.push(current);
  return pieces.map((piece) => piece.trim()).filter((piece) => piece !== "");
}

/** The same mailbox: the whole address compared lowercased. Gmail dot and plus variants are different addresses. */
export function sameAddress(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** Keeps the first entry of each address, in order. */
export function dedupeAddresses<T extends { address: string }>(list: readonly T[]): T[] {
  const seen = new Set<string>();
  const kept: T[] = [];
  for (const entry of list) {
    const key = entry.address.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(entry);
  }
  return kept;
}

/** `addr`, `<addr>`, `Name <addr>` or `"Quoted name" <addr>`; null when the shape is wrong. */
function splitNameAndAddress(text: string): { name: string | null; address: string } | null {
  if (!text.endsWith(">")) {
    return /[<>,;"\s]/.test(text) ? null : { name: null, address: text };
  }
  const open = text.lastIndexOf("<");
  if (open < 0) return null;
  const address = text.slice(open + 1, -1);
  if (/[<>,;"\s]/.test(address)) return null;
  const rawName = text.slice(0, open).trim();
  const name = parseDisplayName(rawName);
  if (name === undefined) return null;
  return { name, address };
}

/** The display name, unquoted; null when absent; undefined when malformed. */
function parseDisplayName(raw: string): string | null | undefined {
  if (raw === "") return null;
  if (raw.startsWith('"')) {
    let name = "";
    let i = 1;
    for (; i < raw.length; i += 1) {
      const ch = raw[i] ?? "";
      if (ch === "\\") {
        if (i + 1 >= raw.length) return undefined;
        name += raw[i + 1] ?? "";
        i += 1;
      } else if (ch === '"') {
        break;
      } else {
        name += ch;
      }
    }
    if (i !== raw.length - 1) return undefined;
    const trimmed = name.trim();
    return trimmed === "" ? null : trimmed;
  }
  if (/[<>,;"]/.test(raw)) return undefined;
  return raw.replace(/\s+/g, " ");
}

function checkAddress(
  address: string,
): { ok: true; address: string } | { ok: false; problem: AddressProblem } {
  const syntax = { ok: false, problem: "syntax" } as const;
  if (address.length < MIN_ADDRESS) return syntax;
  const at = address.lastIndexOf("@");
  if (at <= 0 || at !== address.indexOf("@")) return syntax;
  const local = address.slice(0, at);
  const domain = address.slice(at + 1);
  if (!ASCII.test(local)) return { ok: false, problem: "non_ascii_local" };
  if (local.length > MAX_LOCAL) return syntax;
  if (!local.split(".").every((atom) => ATEXT.test(atom))) return syntax;

  let ascii: string;
  try {
    ascii = toAsciiDomain(domain);
  } catch {
    return syntax;
  }
  if (ascii.length > MAX_DOMAIN) return syntax;
  const labels = ascii.split(".");
  if (labels.length < 2) return syntax;
  if (!labels.every((label) => label.length <= MAX_LABEL && LABEL.test(label))) return syntax;
  // A numeric last label is an IP address in disguise (the URL parser turns
  // "192.0.2.1" and even "1.2" into IPv4 hosts).
  if (/^[0-9]+$/.test(labels[labels.length - 1] ?? "")) return syntax;
  // The URL parser drops a trailing dot and maps full-width dots; neither is
  // what the owner typed as a mail domain.
  if (domain.endsWith(".")) return syntax;
  const full = `${local}@${ascii}`;
  if (full.length > MAX_INPUT) return { ok: false, problem: "too_long" };
  return { ok: true, address: full };
}
