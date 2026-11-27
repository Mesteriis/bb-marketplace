// Read statuses: a tiny image in a sent message, fetched from the owner's
// own public endpoint when the recipient's mail program shows the message.
// The image's address holds a random signed token and nothing about the
// message. An open is a hint, not a proof: some mail services fetch images
// by themselves, and many programs never fetch them.

export const READ_STATUS_KEEP_DAYS = 90;
/** The endpoint is asked for new opens at most this often. */
export const READ_STATUS_POLL_MS = 5 * 60_000;
/** Pages of the feed read in one poll. */
export const READ_STATUS_PAGES = 10;

export type OpenEvent = { seq: number; token: string; at: string; kind: string };
export type OpenView = { count: number; lastAt: string | null };

/** A sent message that was opened and not answered (Today). */
export type OpenedUnanswered = {
  accountId: string;
  threadId: string;
  subject: string;
  /** The first To recipient. */
  to: { name: string | null; address: string } | null;
  count: number;
  lastAt: string;
};

export type SentTracking = { token: string; accountId: string; rfcMessageId: string; createdAt: string };

const ORIGIN = /^https:\/\/[a-z0-9.-]+(:\d{1,5})?$/;
const TOKEN = /^[A-Za-z0-9_-]{16,32}\.[A-Za-z0-9_-]{16}$/;
const KINDS = new Set(["desktop", "mobile", "gmail-proxy", "yahoo-proxy", "machine", "unknown"]);

/** The endpoint's address when it is a plain https origin; null otherwise. */
export function readStatusOrigin(value: string): string | null {
  const origin = value.trim().replace(/\/+$/, "").toLowerCase();
  return ORIGIN.test(origin) ? origin : null;
}

/** The image the recipient's program fetches. No `display:none`: programs skip hidden images. */
export function pixelHtml(origin: string, token: string): string {
  return `<img src="${origin}/o/${token}.gif" width="1" height="1" alt="" style="border:0;width:1px;height:1px">`;
}

/** The body with the image as its last element: inside the document when it has a closing body tag. */
export function withPixel(html: string, pixel: string): string {
  const at = html.toLowerCase().lastIndexOf("</body>");
  return at === -1 ? `${html}${pixel}` : `${html.slice(0, at)}${pixel}${html.slice(at)}`;
}

/** The most characters of one feed answer that are read. */
export const READ_STATUS_FEED_CHARS = 2_000_000;
const EPOCH = /^[A-Za-z0-9_-]{8,64}$/;

export type OpenFeed = {
  events: OpenEvent[];
  next: number;
  /** The endpoint's store id; another one means its numbers started over. */
  epoch: string;
  /** The highest number the endpoint has given. */
  last: number;
  /** The highest number among the events of this answer, readable or not (0 when none). */
  top: number;
};

/** What the feed answered, kept only when it has the expected shape; anything else is dropped. */
export function parseOpenFeed(body: unknown): OpenFeed | null {
  if (body === null || typeof body !== "object") return null;
  const { events, next, epoch, last } = body as { events?: unknown; next?: unknown; epoch?: unknown; last?: unknown };
  if (!Array.isArray(events) || typeof next !== "number" || !Number.isSafeInteger(next) || next < 0) return null;
  if (typeof epoch !== "string" || !EPOCH.test(epoch)) return null;
  if (typeof last !== "number" || !Number.isSafeInteger(last) || last < 0) return null;
  const kept: OpenEvent[] = [];
  let top = 0;
  for (const raw of events) {
    if (raw === null || typeof raw !== "object") continue;
    const { seq, token, at, kind } = raw as Record<string, unknown>;
    if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 1) continue;
    if (seq > top) top = seq;
    if (typeof token !== "string" || !TOKEN.test(token)) continue;
    if (typeof at !== "string" || Number.isNaN(Date.parse(at))) continue;
    kept.push({ seq, token, at: new Date(at).toISOString(), kind: typeof kind === "string" && KINDS.has(kind) ? kind : "unknown" });
  }
  return { events: kept, next, epoch, last, top };
}

/** What the page shows for a tracked message: opens by something that is not plainly a machine. */
export function openView(events: readonly { at: string; kind: string }[]): OpenView {
  const real = events.filter((event) => event.kind !== "machine");
  const lastAt = real.reduce<string | null>((latest, event) => (latest === null || event.at > latest ? event.at : latest), null);
  return { count: real.length, lastAt };
}

/** Read-status exceptions cover this many days of Today's "opened, no reply yet". */
export const READ_STATUS_TODAY_DAYS = 14;
export const READ_STATUS_TODAY_ROWS = 20;

export type TrackExceptions = { addresses: ReadonlySet<string>; domains: ReadonlySet<string> };

const ADDRESS = /^[^\s@,;<>"]+@[a-z0-9.-]+\.[a-z0-9-]{2,}$/;
const DOMAIN = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

/** A host name in the form mail servers use (punycode for other scripts), without a trailing dot; "" when it is not one. */
function asciiHost(host: string): string {
  const plain = host.trim().toLowerCase().replace(/\.$/, "");
  if (plain === "" || /[\s/@:?#\\]/.test(plain)) return "";
  try {
    return new URL(`http://${plain}`).hostname;
  } catch {
    return "";
  }
}

/** An address as it is compared: out of "Name <addr>", lower case, its host in the mail servers' form; "" when it is not one. */
function plainAddress(value: string): string {
  const inner = /<([^<>]+)>/.exec(value)?.[1] ?? value;
  const address = inner.trim().toLowerCase();
  const at = address.lastIndexOf("@");
  if (at <= 0) return "";
  const host = asciiHost(address.slice(at + 1));
  return host === "" ? "" : `${address.slice(0, at)}@${host}`;
}

/**
 * The owner's list of recipients never to track: addresses (also as "Name <addr>") and domains (with or
 * without "@" or "*."), one a line or separated by commas or semicolons. What is neither is in `unknown`.
 */
export function parseTrackExceptions(text: string): TrackExceptions & { unknown: string[] } {
  const addresses = new Set<string>();
  const domains = new Set<string>();
  const unknown: string[] = [];
  for (const raw of text.split(/[\n,;]/)) {
    const entry = raw.trim();
    if (entry === "") continue;
    const address = plainAddress(entry);
    if (ADDRESS.test(address)) {
      addresses.add(address);
      continue;
    }
    const domain = asciiHost(entry.toLowerCase().replace(/^(\*\.|@)/, ""));
    if (DOMAIN.test(domain)) domains.add(domain);
    else unknown.push(entry);
  }
  return { addresses, domains, unknown };
}

/** True when one of the recipients is an excepted address, or at an excepted domain or under one. */
export function trackExcepted(recipients: readonly string[], list: TrackExceptions): boolean {
  return recipients.some((recipient) => {
    const address = plainAddress(recipient);
    if (address === "") return false;
    if (list.addresses.has(address)) return true;
    const host = address.slice(address.lastIndexOf("@") + 1);
    return [...list.domains].some((domain) => host === domain || host.endsWith(`.${domain}`));
  });
}
