// Read statuses: what the public endpoint knows and keeps.
// A token is `<id>.<sig>`: a random id the mail plugin made and a signature
// with the key it shares with this server, so only tokens of the owner's
// own mail are recorded. The token says nothing about the message. No IP
// address, no full User-Agent and no referrer is kept: only the token, the
// time and a coarse kind of the program that fetched the image.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, truncateSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const KEEP_DAYS = 90;
export const EVENTS_PER_TOKEN = 100;
/** Sized so the whole store fits the container's memory, also while it is loaded. */
export const EVENTS_MAX = 50_000;
/** A repeat of the same token and kind inside this window is one open. */
export const REPEAT_MS = 60_000;
export const PAGE_MAX = 500;

const TOKEN = /^([A-Za-z0-9_-]{16,32})\.([A-Za-z0-9_-]{16})$/;

/** The signature of a token id: the first 16 characters of HMAC-SHA256 in base64url. */
export function signTokenId(key, id) {
  return createHmac("sha256", key).update(id).digest("base64url").slice(0, 16);
}

/** The token when it is well formed and signed with the key; null otherwise. */
export function validToken(key, raw) {
  const match = TOKEN.exec(raw);
  if (match === null) return null;
  const expected = Buffer.from(signTokenId(key, match[1]));
  const given = Buffer.from(match[2]);
  return expected.length === given.length && timingSafeEqual(expected, given) ? raw : null;
}

/** Constant-time comparison of two secrets of any length. */
export function sameSecret(a, b) {
  const left = createHmac("sha256", "compare").update(String(a)).digest();
  const right = createHmac("sha256", "compare").update(String(b)).digest();
  return timingSafeEqual(left, right);
}

/**
 * What fetched the image, as far as a User-Agent can tell. Mail services
 * that fetch images themselves are named, because such a fetch is not a
 * person reading. Apple's Mail Privacy Protection cannot be told apart.
 */
export function clientKind(userAgent) {
  const ua = String(userAgent ?? "");
  if (/GoogleImageProxy/i.test(ua)) return "gmail-proxy";
  if (/YahooMailProxy/i.test(ua)) return "yahoo-proxy";
  if (/bot|crawler|spider|preview|scanner|curl|wget|python|java\//i.test(ua)) return "machine";
  if (/iPhone|iPad|Android|Mobile/i.test(ua)) return "mobile";
  if (/Windows|Macintosh|X11|Linux/i.test(ua)) return "desktop";
  return "unknown";
}

/**
 * The opens, kept in memory and in an append-only file of JSON lines.
 * Each has a sequence number that only grows, so a reader asks for
 * "everything after N". Beside the file is a small state file with the
 * store's `epoch` (a random id made once) and the highest number ever
 * given: numbers are never reused, also after everything was pruned, and a
 * reader that sees another epoch knows its place no longer means anything.
 */
export class OpenStore {
  #file;
  #stateFile;
  #events = [];
  #perToken = new Map();
  #lastSeen = new Map();
  #seq = 0;
  #epoch;
  #failed = false;
  #full = false;
  #log;

  constructor(file, log = () => {}) {
    this.#file = file;
    this.#stateFile = file === null ? null : `${file}.state`;
    this.#log = log;
    let state = null;
    if (this.#stateFile !== null && existsSync(this.#stateFile)) {
      try {
        const read = JSON.parse(readFileSync(this.#stateFile, "utf8"));
        if (typeof read.epoch === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(read.epoch) && Number.isSafeInteger(read.seq) && read.seq >= 0) state = read;
      } catch {
        // An unreadable state file: a new epoch below.
      }
    }
    if (file !== null && existsSync(file)) {
      const text = readFileSync(file, "utf8");
      // A torn last line after a crash is cut off, so the next append starts a line of its own.
      const whole = text.endsWith("\n") || text === "" ? text : text.slice(0, text.lastIndexOf("\n") + 1);
      if (whole.length !== text.length) truncateSync(file, Buffer.byteLength(whole));
      for (const line of whole.split("\n")) {
        if (line === "") continue;
        try {
          const event = JSON.parse(line);
          if (typeof event.seq === "number" && typeof event.token === "string" && typeof event.at === "string" && typeof event.kind === "string") {
            this.#add(event);
          }
        } catch {
          // A damaged line: skipped.
        }
      }
    }
    this.#epoch = state?.epoch ?? randomBytes(12).toString("base64url");
    if (state !== null && state.seq > this.#seq) this.#seq = state.seq;
    if (state === null || state.seq !== this.#seq) this.#saveState();
  }

  /** Throws when the place for the data cannot be written: the server must not start like that. */
  checkWritable() {
    if (this.#file === null) return;
    mkdirSync(dirname(this.#file), { recursive: true });
    appendFileSync(this.#file, "", { mode: 0o600 });
    this.#saveState();
  }

  #saveState() {
    if (this.#stateFile === null) return;
    mkdirSync(dirname(this.#stateFile), { recursive: true });
    const temp = `${this.#stateFile}.tmp`;
    writeFileSync(temp, `${JSON.stringify({ epoch: this.#epoch, seq: this.#seq })}\n`, { mode: 0o600 });
    renameSync(temp, this.#stateFile);
  }

  #add(event) {
    this.#events.push(event);
    this.#perToken.set(event.token, (this.#perToken.get(event.token) ?? 0) + 1);
    this.#lastSeen.set(`${event.token} ${event.kind}`, Date.parse(event.at));
    if (event.seq > this.#seq) this.#seq = event.seq;
  }

  /** Records one open; false when it is a repeat, a bound is reached or the file cannot be written. */
  record(token, kind, now) {
    const key = `${token} ${kind}`;
    const last = this.#lastSeen.get(key);
    if (last !== undefined && now.getTime() - last < REPEAT_MS) return false;
    if ((this.#perToken.get(token) ?? 0) >= EVENTS_PER_TOKEN) return false;
    if (this.#events.length >= EVENTS_MAX) {
      if (!this.#full) this.#log("opens: the store is full; new opens are not recorded");
      this.#full = true;
      return false;
    }
    const event = { seq: this.#seq + 1, token, at: now.toISOString(), kind };
    if (this.#file !== null) {
      // The file first: an open that could not be written is not kept in memory either, and its number is not used.
      try {
        appendFileSync(this.#file, `${JSON.stringify(event)}\n`, { mode: 0o600 });
        this.#failed = false;
      } catch (error) {
        if (!this.#failed) this.#log(`opens: the data file cannot be written (${error instanceof Error && "code" in error ? error.code : "error"})`);
        this.#failed = true;
        return false;
      }
    }
    this.#add(event);
    return true;
  }

  /** Up to `limit` events after sequence number `after`, oldest first; where to go on from; the epoch and the highest number given. */
  after(after, limit = PAGE_MAX) {
    const from = this.#events.findIndex((event) => event.seq > after);
    const events = from === -1 ? [] : this.#events.slice(from, from + Math.min(Math.max(limit, 1), PAGE_MAX));
    return { events, next: events.length > 0 ? events[events.length - 1].seq : after, epoch: this.#epoch, last: this.#seq };
  }

  /** Drops what is older than 90 days and rewrites the file; returns how many were dropped. */
  prune(now) {
    const oldest = now.getTime() - KEEP_DAYS * 86_400_000;
    const kept = this.#events.filter((event) => Date.parse(event.at) >= oldest);
    const dropped = this.#events.length - kept.length;
    if (dropped === 0) return 0;
    const seq = this.#seq;
    this.#events = [];
    this.#perToken = new Map();
    this.#lastSeen = new Map();
    for (const event of kept) this.#add(event);
    this.#seq = seq;
    this.#full = false;
    if (this.#file !== null) {
      // The highest number first: if the rewrite is interrupted, numbers still never go back.
      this.#saveState();
      const temp = `${this.#file}.tmp`;
      writeFileSync(temp, kept.map((event) => `${JSON.stringify(event)}\n`).join(""), { mode: 0o600 });
      renameSync(temp, this.#file);
    }
    return dropped;
  }

  get size() {
    return this.#events.length;
  }

  get epoch() {
    return this.#epoch;
  }
}
