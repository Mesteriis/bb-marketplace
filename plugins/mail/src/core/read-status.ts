// Read statuses: a tiny image in a sent message, fetched from the owner's
// own public endpoint when the recipient's mail program shows the message.
// The image's address holds a random signed token and nothing about the
// message. An open is a hint, not a proof: some mail services fetch images
// by themselves, and many programs never fetch them.

export const READ_STATUS_ORIGIN = "https://makosh.sh-inc.dev";
export const READ_STATUS_KEEP_DAYS = 90;
/** The endpoint is asked for new opens at most this often. */
export const READ_STATUS_POLL_MS = 5 * 60_000;
/** Pages of the feed read in one poll. */
export const READ_STATUS_PAGES = 10;

export type OpenEvent = { seq: number; token: string; at: string; kind: string };
export type OpenView = { count: number; lastAt: string | null };

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

/** The body with the image at its end. */
export function withPixel(html: string, pixel: string): string {
  return `${html}${pixel}`;
}

/** What the feed answered, kept only when it has the expected shape; anything else is dropped. */
export function parseOpenFeed(body: unknown): { events: OpenEvent[]; next: number } | null {
  if (body === null || typeof body !== "object") return null;
  const { events, next } = body as { events?: unknown; next?: unknown };
  if (!Array.isArray(events) || typeof next !== "number" || !Number.isSafeInteger(next) || next < 0) return null;
  const kept: OpenEvent[] = [];
  for (const raw of events) {
    if (raw === null || typeof raw !== "object") continue;
    const { seq, token, at, kind } = raw as Record<string, unknown>;
    if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 1) continue;
    if (typeof token !== "string" || !TOKEN.test(token)) continue;
    if (typeof at !== "string" || Number.isNaN(Date.parse(at))) continue;
    kept.push({ seq, token, at: new Date(at).toISOString(), kind: typeof kind === "string" && KINDS.has(kind) ? kind : "unknown" });
  }
  return { events: kept, next };
}

/** What the page shows for a tracked message: opens by something that is not plainly a machine. */
export function openView(events: readonly { at: string; kind: string }[]): OpenView {
  const real = events.filter((event) => event.kind !== "machine");
  const lastAt = real.reduce<string | null>((latest, event) => (latest === null || event.at > latest ? event.at : latest), null);
  return { count: real.length, lastAt };
}
