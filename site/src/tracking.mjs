// Read statuses: what the public endpoint knows and keeps.
// A token is `<id>.<sig>`: a random id the mail plugin made and a signature
// with the key it shares with this server, so only tokens of the owner's
// own mail are recorded. The token says nothing about the message. No IP
// address, no full User-Agent and no referrer is kept: only the token, the
// time and a coarse kind of the program that fetched the image.
import { createHmac, timingSafeEqual } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const KEEP_DAYS = 90;
export const EVENTS_PER_TOKEN = 100;
export const EVENTS_MAX = 200_000;
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
 * "everything after N".
 */
export class OpenStore {
  #file;
  #events = [];
  #perToken = new Map();
  #lastSeen = new Map();
  #seq = 0;

  constructor(file) {
    this.#file = file;
    if (file !== null && existsSync(file)) {
      for (const line of readFileSync(file, "utf8").split("\n")) {
        if (line === "") continue;
        try {
          const event = JSON.parse(line);
          if (typeof event.seq === "number" && typeof event.token === "string" && typeof event.at === "string" && typeof event.kind === "string") {
            this.#add(event);
          }
        } catch {
          // A torn last line after a crash: skipped.
        }
      }
    }
  }

  #add(event) {
    this.#events.push(event);
    this.#perToken.set(event.token, (this.#perToken.get(event.token) ?? 0) + 1);
    this.#lastSeen.set(`${event.token} ${event.kind}`, Date.parse(event.at));
    if (event.seq > this.#seq) this.#seq = event.seq;
  }

  /** Records one open; false when it is a repeat or a bound is reached. */
  record(token, kind, now) {
    const key = `${token} ${kind}`;
    const last = this.#lastSeen.get(key);
    if (last !== undefined && now.getTime() - last < REPEAT_MS) return false;
    if ((this.#perToken.get(token) ?? 0) >= EVENTS_PER_TOKEN) return false;
    if (this.#events.length >= EVENTS_MAX) return false;
    const event = { seq: this.#seq + 1, token, at: now.toISOString(), kind };
    this.#add(event);
    if (this.#file !== null) {
      mkdirSync(dirname(this.#file), { recursive: true });
      appendFileSync(this.#file, `${JSON.stringify(event)}\n`, { mode: 0o600 });
    }
    return true;
  }

  /** Up to `limit` events after sequence number `after`, oldest first, and where to go on from. */
  after(after, limit = PAGE_MAX) {
    const from = this.#events.findIndex((event) => event.seq > after);
    const events = from === -1 ? [] : this.#events.slice(from, from + Math.min(Math.max(limit, 1), PAGE_MAX));
    return { events, next: events.length > 0 ? events[events.length - 1].seq : after };
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
    if (this.#file !== null) {
      const temp = `${this.#file}.tmp`;
      writeFileSync(temp, kept.map((event) => `${JSON.stringify(event)}\n`).join(""), { mode: 0o600 });
      renameSync(temp, this.#file);
    }
    return dropped;
  }

  get size() {
    return this.#events.length;
  }
}
