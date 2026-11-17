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

// ---- Reading (slice 3p, #95) ----

/** One message found in an mbox stream. */
export type MboxMessage = {
  /** Where the message's bytes start in the file, after its "From " line. */
  offset: number;
  /** How many bytes of the file it takes, up to the next "From " line. */
  length: number;
  /** The message as it was before it was put in the mbox; null when it is over the size cap. */
  raw: Uint8Array | null;
};

const SPACE = 0x20;
const COLON = 0x3a;
const isDigit = (byte: number | undefined) => byte !== undefined && byte >= 0x30 && byte <= 0x39;

/**
 * Whether `line` (without its line end) starts an entry: "From ", a sender,
 * and a time of day somewhere after it. The time keeps a body line that
 * happens to begin with "From " in an unquoted mbox from splitting a message.
 */
export function isMboxSeparator(line: Uint8Array): boolean {
  for (let k = 0; k < FROM.length; k++) if (line[k] !== FROM[k]) return false;
  if (line.length < 12 || line[FROM.length] === SPACE) return false;
  for (let i = FROM.length + 1; i + 4 < line.length; i++) {
    if (line[i + 2] === COLON && isDigit(line[i]) && isDigit(line[i + 1]) && isDigit(line[i + 3]) && isDigit(line[i + 4])) return true;
  }
  return false;
}

/**
 * Splits an mbox given in chunks, in one pass. Each message comes back
 * unquoted (a `>From ` line loses one ">", as mboxrd and mboxo write them)
 * with its place in the file. A message over `maxBytes` is reported without
 * its bytes. Bytes before the first "From " line are not a message.
 */
export class MboxSplitter {
  /** Absolute file offset of `carry[0]`. */
  private position = 0;
  /** The unfinished last line of the chunks so far. */
  private carry = new Uint8Array(0);
  private current: { offset: number; parts: Uint8Array[]; size: number; over: boolean } | null = null;

  /** `startOffset`: where in the file the first chunk begins (an import that goes on from a "From " line). */
  constructor(
    private readonly maxBytes: number,
    startOffset = 0,
  ) {
    this.position = startOffset;
  }

  push(chunk: Uint8Array): MboxMessage[] {
    const data = this.carry.length === 0 ? chunk : concat([this.carry, chunk]);
    const done: MboxMessage[] = [];
    let lineStart = 0;
    let runStart = 0;
    for (;;) {
      const lf = data.indexOf(LF, lineStart);
      if (lf === -1) break;
      const line = data.subarray(lineStart, lf);
      if (isMboxSeparator(line)) {
        this.take(data, runStart, lineStart);
        const finished = this.finish(this.position + lineStart);
        if (finished !== null) done.push(finished);
        this.current = { offset: this.position + lf + 1, parts: [], size: 0, over: false };
        runStart = lf + 1;
      } else if (line[0] === GT && looksLikeSeparator(data, lineStart)) {
        // Unquote: everything up to this line, then the line without its first ">".
        this.take(data, runStart, lineStart);
        runStart = lineStart + 1;
      }
      lineStart = lf + 1;
    }
    this.take(data, runStart, lineStart);
    // Copy: `data` may be the caller's buffer, reused for the next chunk.
    this.carry = data.slice(lineStart);
    this.position += lineStart;
    return done;
  }

  /** The last message, once the file has ended. */
  end(): MboxMessage[] {
    const rest = this.carry;
    this.carry = new Uint8Array(0);
    let end = this.position + rest.length;
    if (rest.length > 0) {
      if (isMboxSeparator(rest)) {
        // A "From " line with nothing after it: the message before it ends here.
        end = this.position;
        const finished = this.finish(end);
        this.current = null;
        this.position += rest.length;
        return finished === null ? [] : [finished];
      }
      const start = rest[0] === GT && looksLikeSeparator(rest, 0) ? 1 : 0;
      this.take(rest, start, rest.length);
    }
    this.position = end;
    const finished = this.finish(end);
    this.current = null;
    return finished === null ? [] : [finished];
  }

  private take(data: Uint8Array, from: number, to: number): void {
    const current = this.current;
    if (current === null || to <= from) return;
    current.size += to - from;
    if (current.size > this.maxBytes) {
      current.over = true;
      current.parts = [];
      return;
    }
    // Copy: the parts outlive this chunk.
    current.parts.push(data.slice(from, to));
  }

  private finish(endOffset: number): MboxMessage | null {
    const current = this.current;
    if (current === null) return null;
    const length = endOffset - current.offset;
    if (current.over) return { offset: current.offset, length, raw: null };
    let raw = concat(current.parts);
    // The empty line that closes an entry is the mbox's, not the message's.
    if (raw.length >= 2 && raw[raw.length - 1] === LF && raw[raw.length - 2] === LF) raw = raw.subarray(0, raw.length - 1);
    else if (raw.length >= 4 && raw[raw.length - 1] === LF && raw[raw.length - 2] === CR && raw[raw.length - 3] === LF) raw = raw.subarray(0, raw.length - 2);
    return { offset: current.offset, length, raw };
  }
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0]!;
  let size = 0;
  for (const part of parts) size += part.length;
  const out = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** The message a stored place of an mbox holds: that slice of the file, unquoted. */
export function mboxSliceMessage(slice: Uint8Array, maxBytes: number): Uint8Array | null {
  const splitter = new MboxSplitter(maxBytes);
  // A slice is one entry's bytes: give it the separator the splitter starts on.
  splitter.push(new TextEncoder().encode("From MAILER-DAEMON Thu Jan  1 00:00:00 1970\n"));
  splitter.push(slice);
  return splitter.end()[0]?.raw ?? null;
}
