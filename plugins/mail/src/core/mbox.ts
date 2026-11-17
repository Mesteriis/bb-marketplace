// mbox (slice 3o, #94): the one-file mailbox format other mail programs
// read. Written as "mboxrd": each message starts with a "From " line, its
// own lines that look like one are quoted with ">", and line ends are LF.
// Works on bytes, so a message in any charset comes out as it went in.
import { headerValue } from "./headers.ts";

const LF = 0x0a;
const CR = 0x0d;
const GT = 0x3e;
const FROM = [0x46, 0x72, 0x6f, 0x6d, 0x20]; // "From "

/** Whether the line starting at `at` is `>*From `: the lines mboxrd quotes. */
function looksLikeSeparator(raw: Uint8Array, at: number): boolean {
  let i = at;
  while (i < raw.length && raw[i] === GT) i++;
  for (let k = 0; k < FROM.length; k++) if (raw[i + k] !== FROM[k]) return false;
  return true;
}

/**
 * A message's bytes as an mbox entry body: CRLF becomes LF, every line of
 * the form `>*From ` gets one more ">", and the entry ends with an empty
 * line.
 */
export function mboxBody(raw: Uint8Array): Uint8Array {
  // Worst case: one ">" per line, plus the closing line ends.
  let lines = 1;
  for (let i = 0; i < raw.length; i++) if (raw[i] === LF) lines++;
  const out = new Uint8Array(raw.length + lines + 2);
  let o = 0;
  let lineStart = true;
  for (let i = 0; i < raw.length; i++) {
    const byte = raw[i]!;
    if (lineStart) {
      if (looksLikeSeparator(raw, i)) out[o++] = GT;
      lineStart = false;
    }
    if (byte === CR && raw[i + 1] === LF) continue;
    out[o++] = byte;
    if (byte === LF) lineStart = true;
  }
  if (o > 0 && out[o - 1] !== LF) out[o++] = LF;
  out[o++] = LF;
  return out.subarray(0, o);
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n: number) => String(n).padStart(2, "0");

/** `From sender Thu Nov 17 10:00:00 2026`: the line that starts an entry, in UTC. */
export function mboxFromLine(sender: string, date: Date): string {
  const day = String(date.getUTCDate()).padStart(2, " ");
  const time = `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
  return `From ${sender} ${DAYS[date.getUTCDay()]} ${MONTHS[date.getUTCMonth()]} ${day} ${time} ${date.getUTCFullYear()}`;
}

/**
 * The separator line for a message: its From address and its Date, or
 * MAILER-DAEMON and `fallback` when the message does not give them. The
 * address is kept only when it is plain ASCII without spaces.
 */
export function mboxSeparator(raw: Uint8Array, fallback: Date): string {
  const from = headerValue(raw, "from") ?? "";
  const address = /<([^<>\s]+@[^<>\s]+)>/.exec(from)?.[1] ?? /(^|\s)([^<>\s"(),;:]+@[^<>\s"(),;:]+)/.exec(from)?.[2] ?? "";
  const sender = /^[\x21-\x7e]{3,254}$/.test(address) ? address : "MAILER-DAEMON";
  const parsed = Date.parse(headerValue(raw, "date") ?? "");
  return mboxFromLine(sender, Number.isNaN(parsed) ? fallback : new Date(parsed));
}

/** One message as a whole mbox entry. */
export function mboxEntry(raw: Uint8Array, fallback: Date): Uint8Array {
  const head = new TextEncoder().encode(`${mboxSeparator(raw, fallback)}\n`);
  const body = mboxBody(raw);
  const out = new Uint8Array(head.length + body.length);
  out.set(head);
  out.set(body, head.length);
  return out;
}
