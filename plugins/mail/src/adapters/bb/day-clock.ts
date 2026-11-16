// The day clock (slice 3f): every 60 s on the server's local clock. With
// morningDigest on it builds today's digest row once, at the first tick at
// or after digestTime (a late start builds it at once; a missed day is not
// back-filled), and moves waiting reply reminders whose time came to `due`.
// Outside quiet hours a built, unshown day or a due, unshown reminder is
// announced once with a realtime token; the notice stays until a window
// shows it (day_notice_get, spec resolution 14). The clock reads the store
// only: it never scans references (resolution 7) and never calls a model.
// Beside it, the post-round step labels new mail by the owner's category
// rules and clears reminders a round's new rows answer.
import {
  REMINDERS_LIVE_MAX,
  answers,
  digestDue,
  inQuietHours,
  localCategory,
  localDay,
  localMinutes,
  needsReply,
  ownAddresses,
  parseDigestTime,
  parseQuietHours,
  ruleMatches,
  sinceCounts,
  type Category,
  type Clock,
  type MailStore,
  type ReminderRecord,
  type ReplyCandidate,
  type SinceCounts,
  type SyncOutcome,
} from "../../core/index.ts";

export const DAY_TICK_MS = 60_000;
const DAY_MS = 86_400_000;
/** Inbox rows read for the counts since the previous digest. */
const SINCE_ROWS_MAX = 2_000;
/** Reply candidates read before needsReply filters them. */
const REPLY_CANDIDATES_MAX = 500;

const lower = (address: string) => address.trim().toLowerCase();

// ---------------------------------------------------------------------------
// Today's lists (shared with today_get)
// ---------------------------------------------------------------------------

/** Conversations whose latest message waits for the owner's reply now (core needsReply over the store). */
export function needsReplyNow(store: MailStore, now: Date): ReplyCandidate[] {
  const candidates = store.replyCandidates(new Date(now.getTime() - 14 * DAY_MS).toISOString(), REPLY_CANDIDATES_MAX);
  const snoozed = new Set<string>();
  for (const account of store.listAccounts()) {
    for (const snooze of store.listSnoozes(account.id, { limit: 1_000 })) {
      const threadId = store.getMessage(snooze.messageId)?.threadId;
      if (threadId !== undefined) snoozed.add(threadId);
    }
  }
  return needsReply(candidates, {
    own: new Set(ownAddresses(store).map(lower)),
    sentTo: store.addressesSentTo(candidates.map((c) => c.fromAddress)),
    dismissed: store.replyDismissals(),
    snoozed,
    now,
  });
}

/** The category a new Inbox row counts under: the owner's or a rule's label, else the model's suggestion, else the local one. */
function countedCategory(
  stored: { category: Category | null; suggestion: string | null } | undefined,
  local: Category | null,
): Category | null {
  if (stored?.category != null) return stored.category;
  if (stored?.suggestion != null && stored.suggestion !== "none") return stored.suggestion as Category;
  return local;
}

/** Counts of new Inbox rows since `sinceIso`: by category with categories on, else bulk against personal. */
export function sinceCountsNow(store: MailStore, sinceIso: string, categoriesOn: boolean): SinceCounts {
  const since = Date.parse(sinceIso);
  const rows = store
    .inboxMessages(null, { unreadOnly: false, limit: SINCE_ROWS_MAX })
    .filter((row) => row.date !== null && Date.parse(row.date) >= since);
  const labels = categoriesOn ? store.categoriesOf(rows.map((row) => row.id)) : new Map();
  const sentTo = categoriesOn ? store.addressesSentTo(rows.map((row) => row.from.address)) : new Set<string>();
  return sinceCounts(
    rows.map((row) => ({
      bulk: row.bulk,
      fromAddress: row.from.address,
      category: categoriesOn
        ? countedCategory(
            labels.get(row.id),
            localCategory({ bulk: row.bulk, listKey: row.unsubscribe?.listKey ?? null, fromAddress: row.from.address }, sentTo),
          )
        : null,
    })),
    categoriesOn,
  );
}

/** Where "since yesterday" starts: the previous built digest, else 24 hours ago. */
export function digestSince(store: MailStore, now: Date): string {
  const yesterday = localDay(new Date(now.getTime() - DAY_MS));
  return store.getDigest(yesterday)?.builtAt ?? new Date(now.getTime() - DAY_MS).toISOString();
}

// ---------------------------------------------------------------------------
// Reminders answered (post-round, set and bind)
// ---------------------------------------------------------------------------

/**
 * Moves waiting and due reminders a stored row answers to `answered` (core
 * `answers`: In-Reply-To or References, dated after the send, not the sent
 * copy, not bulk or automated). `only`: judge only these rows (a round's
 * inserted ones). Returns how many were answered.
 */
export function replyArrived(store: MailStore, nowIso: string, only?: ReadonlySet<string>, reminders?: ReminderRecord[]): number {
  if (only !== undefined && only.size === 0) return 0;
  const live = (reminders ?? store.listReminders({ states: ["waiting", "due"], limit: REMINDERS_LIVE_MAX })).filter(
    (r): r is ReminderRecord & { sentAt: string } => r.sentAt !== null && (r.state === "waiting" || r.state === "due"),
  );
  if (live.length === 0) return 0;
  const after = live.reduce((min, r) => (r.sentAt < min ? r.sentAt : min), live[0]!.sentAt);
  const rows = store
    .answeringRows(
      live.map((r) => r.rfcMessageId),
      after,
    )
    .filter((row) => only === undefined || only.has(row.id));
  let answered = 0;
  for (const reminder of live) {
    if (!rows.some((row) => answers(reminder, row))) continue;
    const threadId = store.sentCopyThread(reminder.accountId, reminder.rfcMessageId) ?? reminder.threadId;
    if (store.updateReminder(reminder.id, { state: "answered", threadId }, nowIso)) answered++;
  }
  return answered;
}

/** The post-round step's dependencies. */
export type AfterRoundAiDeps = {
  store: MailStore;
  clock: Clock;
  categoriesOn: () => boolean;
  log?: (line: string) => void;
};

/**
 * After an ok round: the owner's category rules label genuinely new Inbox
 * rows (never returning ones, never over the owner's label; only with
 * categories on), then reminders the round's inserted rows answer are
 * cleared. Logs counts only.
 */
export function afterRoundAi(deps: AfterRoundAiDeps, accountId: string, outcome: Extract<SyncOutcome, { status: "ok" }>): void {
  const { store } = deps;
  const nowIso = deps.clock.now().toISOString();
  if (deps.categoriesOn()) {
    try {
      const returning = new Set(outcome.returning);
      const fresh = outcome.newInbox.filter((id) => !returning.has(id));
      const rules = fresh.length === 0 ? [] : store.listCategoryRules();
      if (rules.length > 0) {
        const byCategory = new Map<Category, string[]>();
        for (const row of store.notifyRows(fresh, nowIso)) {
          const rule = ruleMatches(row.fromAddress, rules);
          if (rule === null) continue;
          byCategory.set(rule.category, [...(byCategory.get(rule.category) ?? []), row.id]);
        }
        let labelled = 0;
        for (const [category, ids] of byCategory) {
          store.setCategories(ids, category, "rule", nowIso);
          labelled += ids.length;
        }
        if (labelled > 0) deps.log?.(`categories ${accountId}: ${labelled} by rule`);
      }
    } catch (error) {
      deps.log?.(`categories ${accountId}: failed (${errorName(error)})`);
    }
  }
  try {
    const answered = replyArrived(store, nowIso, new Set(outcome.inserted));
    if (answered > 0) deps.log?.(`reminders ${accountId}: ${answered} answered`);
  } catch (error) {
    deps.log?.(`reminders ${accountId}: check failed (${errorName(error)})`);
  }
}

// ---------------------------------------------------------------------------
// Notices
// ---------------------------------------------------------------------------

/** What a window shows: today's digest counts, or one due reminder. */
export type DayNotice = { kind: "digest"; day: string; replyCount: number } | { kind: "reminder"; reminder: ReminderRecord };

/**
 * Tokens for announced notices, in memory. Each notice (today's digest, a
 * reminder at one due time) is announced once per process; the token only
 * wakes the windows, which then ask for the oldest unshown notice.
 */
export class DayNoticeBook {
  private readonly announced = new Set<string>();
  private readonly tokens = new Map<string, string>();

  constructor(private readonly newToken: () => string) {}

  /** A token for a notice not announced yet, else null. */
  announce(key: string): string | null {
    if (this.announced.has(key)) return null;
    this.announced.add(key);
    const token = this.newToken();
    this.tokens.set(token, key);
    if (this.tokens.size > 100) this.tokens.delete(this.tokens.keys().next().value!);
    return token;
  }

  /** Whether a token was handed out (an unknown one still gets the oldest notice). */
  knows(token: string): boolean {
    return this.tokens.has(token);
  }
}

/**
 * The oldest unshown notice of today, marked shown: today's built digest
 * first, then due reminders by due time. Null when none waits.
 */
export function takeDayNotice(store: MailStore, now: Date): DayNotice | null {
  const nowIso = now.toISOString();
  const day = localDay(now);
  const digest = store.getDigest(day);
  if (digest !== null && digest.notifiedAt === null && store.markDigestNotified(day, nowIso)) {
    return { kind: "digest", day, replyCount: digest.replyCount };
  }
  const reminder = store
    .listReminders({ states: ["due"], dueBefore: nowIso, limit: REMINDERS_LIVE_MAX })
    .find((r) => r.notifiedAt === null);
  if (reminder !== undefined && store.updateReminder(reminder.id, { notifiedAt: nowIso }, nowIso)) {
    return { kind: "reminder", reminder };
  }
  return null;
}

// ---------------------------------------------------------------------------
// The clock
// ---------------------------------------------------------------------------

export type DayClockSettings = { morningDigest: boolean; digestTime: string; quietHours: string; mailCategories: boolean };

export interface DayClockDeps {
  store: MailStore;
  settings: () => DayClockSettings;
  /** Publishes `mail-day` { token }. */
  publish: (token: string) => void;
  book: DayNoticeBook;
  clock: Clock;
  isReady: () => boolean;
  log?: (line: string) => void;
}

export interface DayClock {
  /** Ticks now and every minute until the signal aborts. */
  start(signal: AbortSignal): Promise<void>;
  tick(): void;
}

export function createDayClock(deps: DayClockDeps): DayClock {
  const log = (line: string) => {
    try {
      deps.log?.(line);
    } catch {
      // A broken logger must not stop the clock.
    }
  };

  function tick(): void {
    let ready = false;
    try {
      ready = deps.isReady();
    } catch {
      ready = false;
    }
    if (!ready) return;
    try {
      tickOnce();
    } catch (error) {
      log(`day clock: tick failed (${errorName(error)})`);
    }
  }

  function tickOnce(): void {
    const { store } = deps;
    const now = deps.clock.now();
    const nowIso = now.toISOString();
    const day = localDay(now);
    const settings = deps.settings();

    // Reminders whose time came: waiting -> due (no reference scan here).
    const due = store.listReminders({ states: ["waiting"], dueBefore: nowIso, limit: REMINDERS_LIVE_MAX });
    for (const reminder of due) store.updateReminder(reminder.id, { state: "due" }, nowIso);
    if (due.length > 0) log(`reminders: ${due.length} due`);

    if (settings.morningDigest) {
      const minutes = parseDigestTime(settings.digestTime);
      const built = store.getDigest(day) !== null;
      if (minutes !== null && digestDue({ day, localMinutes: localMinutes(now), built }, minutes)) {
        const since = digestSince(store, now);
        const counts = sinceCountsNow(store, since, settings.mailCategories);
        const replyCount = needsReplyNow(store, now).length;
        if (
          store.putDigest({ day, builtAt: nowIso, since, replyCount, noticeCount: counts.notifications, notifiedAt: null })
        ) {
          log(`digest ${day} built`);
        }
      }
    }

    // Announce what waits, outside quiet hours; once per notice.
    if (inQuietHours(parseQuietHours(settings.quietHours), localMinutes(now))) return;
    const digest = settings.morningDigest ? store.getDigest(day) : null;
    if (digest !== null && digest.notifiedAt === null) {
      const token = deps.book.announce(`digest:${day}`);
      if (token !== null) deps.publish(token);
    }
    for (const reminder of store.listReminders({ states: ["due"], dueBefore: nowIso, limit: REMINDERS_LIVE_MAX })) {
      if (reminder.notifiedAt !== null) continue;
      // Keyed by the due time too: a snoozed reminder that comes due again is a new notice.
      const token = deps.book.announce(`reminder:${reminder.id}:${reminder.dueAt}`);
      if (token !== null) deps.publish(token);
    }
  }

  async function start(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    tick();
    while (!signal.aborted) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, DAY_TICK_MS);
        function done() {
          clearTimeout(timer);
          signal.removeEventListener("abort", done);
          resolve();
        }
        signal.addEventListener("abort", done, { once: true });
      });
      if (!signal.aborted) tick();
    }
  }

  return { start, tick };
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "unknown";
}

