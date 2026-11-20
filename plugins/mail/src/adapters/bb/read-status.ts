// Read statuses, the host side: tokens signed with the key shared with the
// owner's endpoint, the image for a sent message, the poll of the endpoint's
// feed, and the opens shown under a message. Nothing here reaches an agent
// or a model: opens are the owner's alone.
import { createHmac, randomBytes } from "node:crypto";
import type { Clock, MailStore } from "../../core/ports.ts";
import {
  READ_STATUS_FEED_CHARS,
  READ_STATUS_KEEP_DAYS,
  READ_STATUS_PAGES,
  READ_STATUS_POLL_MS,
  READ_STATUS_TODAY_DAYS,
  READ_STATUS_TODAY_ROWS,
  openView,
  parseOpenFeed,
  parseTrackExceptions,
  trackExcepted,
  type OpenedUnanswered,
  pixelHtml,
  readStatusOrigin,
  type OpenView,
} from "../../core/read-status.ts";

export type ReadStatusSettings = { on: boolean; origin: string; trackKey: string; feedKey: string; /** Recipients never to track. */ exceptions: string };

const KEY_MIN = 32;
const FEED_TIMEOUT_MS = 15_000;

/** `<id>.<sig>`: 20 random base64url characters and the first 16 of HMAC-SHA256(key, id), as the endpoint checks. */
export function signedToken(trackKey: string, id: string): string {
  return `${id}.${createHmac("sha256", trackKey).update(id).digest("base64url").slice(0, 16)}`;
}

export type ReadStatus = ReturnType<typeof createReadStatus>;

export function createReadStatus(deps: {
  store: MailStore;
  clock: Clock;
  settings: () => ReadStatusSettings;
  /** The answer's status and its text, cut by the caller at READ_STATUS_FEED_CHARS. */
  fetch: (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{ status: number; text(): Promise<string> }>;
  /** A fresh token id; random by default. */
  newId?: () => string;
  log: (line: string) => void;
}) {
  const { store, clock, log } = deps;
  const newId = deps.newId ?? (() => randomBytes(15).toString("base64url"));
  let lastPoll = Number.NEGATIVE_INFINITY;
  let polling = false;

  /** The endpoint and both keys, when read statuses are on and fully set up. */
  const setup = (): { origin: string; trackKey: string; feedKey: string } | null => {
    const current = deps.settings();
    if (!current.on || current.trackKey.length < KEY_MIN || current.feedKey.length < KEY_MIN) return null;
    const origin = readStatusOrigin(current.origin);
    return origin === null ? null : { origin, trackKey: current.trackKey, feedKey: current.feedKey };
  };

  return {
    ready: (): boolean => setup() !== null,

    /** A token and its image for one sent message; null when off or not set up. */
    issue(recipients: readonly string[] = []): { token: string; html: string } | null {
      const ready = setup();
      if (ready === null) return null;
      if (trackExcepted(recipients, parseTrackExceptions(deps.settings().exceptions))) return null;
      const token = signedToken(ready.trackKey, newId());
      return { token, html: pixelHtml(ready.origin, token) };
    },

    /**
     * Reads the feed past what was read before, at most once in five minutes
     * and one poll at a time. Returns how many opens were new. A failure is
     * one log line with a status or an error name, never a key or a token.
     */
    async poll(): Promise<number> {
      const ready = setup();
      const now = clock.now().getTime();
      if (ready === null || polling || now - lastPoll < READ_STATUS_POLL_MS) return 0;
      polling = true;
      lastPoll = now;
      let kept = 0;
      try {
        for (let page = 0; page < READ_STATUS_PAGES; page += 1) {
          const { scope, cursor } = store.openFeed();
          const answer = await deps.fetch(`${ready.origin}/api/events?after=${cursor}&limit=500`, {
            headers: { Authorization: `Bearer ${ready.feedKey}`, Accept: "application/json" },
            signal: AbortSignal.timeout(FEED_TIMEOUT_MS),
          });
          if (answer.status !== 200) {
            log(`read statuses: the endpoint answered ${answer.status}`);
            break;
          }
          const text = await answer.text();
          const feed = text.length > READ_STATUS_FEED_CHARS ? null : parseOpenFeed(JSON.parse(text) as unknown);
          if (feed === null) {
            log("read statuses: the endpoint's answer was not understood");
            break;
          }
          const feedScope = `${ready.origin} ${feed.epoch}`;
          if (feedScope !== scope || feed.last < cursor) {
            // Another endpoint, or one whose numbers started over: what was read before no longer
            // lines up, so the kept opens go and the feed is read again from its start.
            store.resetOpenFeed(feedScope);
            continue;
          }
          // Where to go on from must follow from the answer itself: the last event's number, or no move at all.
          if (feed.next !== (feed.top === 0 ? cursor : feed.top) || feed.next > feed.last) {
            log("read statuses: the endpoint's answer was not understood");
            break;
          }
          kept += store.saveOpenEvents(feed.events);
          if (feed.next <= cursor) break;
          store.setOpenCursor(feed.next);
        }
        store.pruneTracking(new Date(now - READ_STATUS_KEEP_DAYS * 86_400_000).toISOString());
      } catch (error) {
        log(`read statuses: the endpoint could not be read (${error instanceof Error ? error.name : "error"})`);
      } finally {
        polling = false;
      }
      return kept;
    },

    /** The conversations with their opens, for those someone opened: the list's mark. */
    withThreads<T extends { id: string }>(threads: T[]): (T & { opens?: OpenView })[] {
      if (threads.length === 0 || !deps.settings().on) return threads;
      const found = store.threadOpens(threads.map((thread) => thread.id));
      if (found.size === 0) return threads;
      return threads.map((thread) => {
        const view = openView(found.get(thread.id) ?? []);
        return view.count === 0 ? thread : { ...thread, opens: view };
      });
    },

    /** Today: sent mail of the last two weeks that was opened and not answered. Nothing while read statuses are off. */
    unanswered(): OpenedUnanswered[] {
      if (!deps.settings().on) return [];
      return store.openedUnanswered(new Date(clock.now().getTime() - READ_STATUS_TODAY_DAYS * 86_400_000).toISOString(), READ_STATUS_TODAY_ROWS);
    },

    /** The messages with their opens, for those that carry a token. */
    withMessages<T extends { id: string }>(messages: T[]): (T & { opens?: OpenView })[] {
      if (messages.length === 0) return messages;
      const found = store.messageOpens(messages.map((message) => message.id));
      if (found.size === 0) return messages;
      return messages.map((message) => {
        const events = found.get(message.id);
        return events === undefined ? message : { ...message, opens: openView(events) };
      });
    },
  };
}
