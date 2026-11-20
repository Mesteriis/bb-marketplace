// Smart Send and sender insights, the pure part: when someone usually
// writes, how fast they and the owner answer one another, and who they
// write with — counted from the mail between the owner and one address.
// No model and nothing from outside the mailbox.
import { normalizeMessageId } from "./headers.ts";

export const RHYTHM_DAYS = 180;
export const RHYTHM_MESSAGES = 500;
/** Fewer incoming messages than this say nothing. */
export const RHYTHM_MIN_MESSAGES = 5;
/** Fewer answered pairs than this give no median. */
export const RHYTHM_MIN_PAIRS = 3;
const PAIR_MAX_MS = 14 * 86_400_000;
const AHEAD_MS = 60 * 60_000;
const WEEKDAY_SHARE = 0.8;
export const MOST_WITH_MAX = 3;
const MOST_WITH_MIN = 2;

/** The mail between the owner and one address, each way. Dates are ISO 8601. */
export type Exchange = {
  incoming: { date: string; messageId: string | null; inReplyTo: string | null; /** Other To/Cc addresses. */ others: string[] }[];
  outgoing: { date: string; messageId: string | null; inReplyTo: string | null }[];
};

/** How a moment reads on the owner's clock, and the moment a day and hour stand for. */
export type TimeReader = {
  /** The hour (0–23) and the day of the week (0 Sunday … 6 Saturday). */
  parts(date: Date): { hour: number; weekday: number };
  /** `hour`:00 on the day `dayOffset` days after `base`'s day. */
  at(base: Date, dayOffset: number, hour: number): Date;
};

/** The server's own zone: the owner's clock. */
export const LOCAL_TIME: TimeReader = {
  parts: (date) => ({ hour: date.getHours(), weekday: date.getDay() }),
  at: (base, dayOffset, hour) => new Date(base.getFullYear(), base.getMonth(), base.getDate() + dayOffset, hour, 0, 0, 0),
};

/** UTC, for tests and nothing else. */
export const UTC_TIME: TimeReader = {
  parts: (date) => ({ hour: date.getUTCHours(), weekday: date.getUTCDay() }),
  at: (base, dayOffset, hour) => new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() + dayOffset, hour)),
};

type Rhythm = { hour: number; spanFrom: number; weekdaysOnly: boolean };

function rhythmOf(exchange: Exchange, time: TimeReader): Rhythm | null {
  const moments = exchange.incoming.map((message) => new Date(message.date)).filter((date) => !Number.isNaN(date.getTime()));
  if (moments.length < RHYTHM_MIN_MESSAGES) return null;
  const hours = new Array<number>(24).fill(0);
  let weekdays = 0;
  for (const moment of moments) {
    const { hour, weekday } = time.parts(moment);
    hours[hour]! += 1;
    if (weekday >= 1 && weekday <= 5) weekdays += 1;
  }
  let hour = 0;
  let spanFrom = 0;
  let spanBest = -1;
  for (let h = 0; h < 24; h++) {
    if (hours[h]! > hours[hour]!) hour = h;
    // A span never wraps midnight: 22–01 would read oddly on the card.
    const span = h <= 21 ? hours[h]! + hours[h + 1]! + hours[h + 2]! : -1;
    if (span > spanBest) {
      spanBest = span;
      spanFrom = h;
    }
  }
  return { hour, spanFrom, weekdaysOnly: weekdays / moments.length >= WEEKDAY_SHARE };
}

/**
 * The time a message to this person is best sent: the next occurrence of
 * the hour they usually write, on a day they write, at least an hour from
 * `now`. Null from too little mail.
 */
export function smartSendTime(exchange: Exchange, now: Date, time: TimeReader = LOCAL_TIME): { at: string; hour: number } | null {
  const rhythm = rhythmOf(exchange, time);
  if (rhythm === null) return null;
  for (let day = 0; day <= 7; day++) {
    const candidate = time.at(now, day, rhythm.hour);
    if (candidate.getTime() - now.getTime() < AHEAD_MS) continue;
    const { weekday, hour } = time.parts(candidate);
    // A day whose clock skips that hour (summer time starts) is passed over: the label would name another hour.
    if (hour !== rhythm.hour) continue;
    if (rhythm.weekdaysOnly && (weekday === 0 || weekday === 6)) continue;
    return { at: candidate.toISOString(), hour };
  }
  return null;
}

function median(values: number[]): number | null {
  if (values.length < RHYTHM_MIN_PAIRS) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return Math.round(sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2);
}

/** Minutes between each answer and the message it answers (by In-Reply-To), within 14 days. */
function replyMinutes(
  answers: readonly { date: string; inReplyTo: string | null }[],
  asked: readonly { date: string; messageId: string | null }[],
): number[] {
  // Ids are compared as the rest of Mail compares them: without angle brackets and outer spaces.
  const sentAt = new Map<string, number>();
  for (const message of asked) {
    const at = Date.parse(message.date);
    if (message.messageId !== null && !Number.isNaN(at)) sentAt.set(normalizeMessageId(message.messageId), at);
  }
  const out: number[] = [];
  for (const answer of answers) {
    const from = answer.inReplyTo === null ? undefined : sentAt.get(normalizeMessageId(answer.inReplyTo));
    const at = Date.parse(answer.date);
    if (from === undefined || Number.isNaN(at) || at < from || at - from > PAIR_MAX_MS) continue;
    out.push((at - from) / 60_000);
  }
  return out;
}

export type SenderInsights = {
  /** The median minutes they take to answer the owner; null from fewer than three answers. */
  theirReplyMinutes: number | null;
  ownReplyMinutes: number | null;
  /** The three hours they usually write in, on the owner's clock: from (inclusive) to (exclusive). */
  usualFrom: number;
  usualTo: number;
  weekdaysOnly: boolean;
  /** Who else is on their mail to the owner most often. */
  mostWith: { address: string; count: number }[];
};

/**
 * What the sender card says about someone; null from too little mail.
 * `own`: the owner's addresses and the person's own, left out of "most with".
 */
export function senderInsights(exchange: Exchange, own: ReadonlySet<string>, time: TimeReader = LOCAL_TIME): SenderInsights | null {
  const rhythm = rhythmOf(exchange, time);
  if (rhythm === null) return null;
  const counts = new Map<string, number>();
  for (const message of exchange.incoming) {
    for (const address of new Set(message.others.map((other) => other.trim().toLowerCase()))) {
      if (address !== "" && !own.has(address)) counts.set(address, (counts.get(address) ?? 0) + 1);
    }
  }
  const mostWith = [...counts]
    .filter(([, count]) => count >= MOST_WITH_MIN)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, MOST_WITH_MAX)
    .map(([address, count]) => ({ address, count }));
  return {
    theirReplyMinutes: median(replyMinutes(exchange.incoming, exchange.outgoing)),
    ownReplyMinutes: median(replyMinutes(exchange.outgoing, exchange.incoming)),
    usualFrom: rhythm.spanFrom,
    usualTo: rhythm.spanFrom + 3,
    weekdaysOnly: rhythm.weekdaysOnly,
    mostWith,
  };
}
