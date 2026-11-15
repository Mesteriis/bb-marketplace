import { describe, expect, it } from "vitest";
import {
  TRIAGE_CAPS,
  TriageError,
  checkTriageCaps,
  mailTriageParamsSchema,
  triageContentHash,
  triageResultText,
  validateTriage,
  type TriageHistoryRow,
  type TriageRowState,
  type ValidatedItem,
} from "./triage.ts";
import type { UnsubscribeInfo } from "./unsubscribe.ts";

const NOW = new Date("2026-11-15T12:00:00.000Z");
const LATER = "2026-11-16T08:00:00.000Z";

const unsubscribe = (extra: Partial<UnsubscribeInfo> = {}): UnsubscribeInfo => ({
  listKey: "news.example.com",
  listName: "News",
  https: "https://u.example.com/x",
  oneClick: true,
  mailto: null,
  trust: "covered",
  ...extra,
});

function state(id: string, extra: Partial<TriageRowState> = {}): TriageRowState {
  return {
    id,
    accountId: "a1",
    threadId: `t-${id}`,
    folderRole: "inbox",
    uid: 5,
    movePending: null,
    fromAddress: "news@example.com",
    unsubscribe: null,
    ...extra,
  };
}

const rows = new Map<string, TriageRowState>([
  ["m1", state("m1")],
  ["m2", state("m2", { unsubscribe: unsubscribe() })],
  ["sent", state("sent", { folderRole: "sent" })],
  ["moving", state("moving", { movePending: "Archive" })],
  ["detached", state("detached", { uid: null })],
  ["nc", state("nc", { unsubscribe: unsubscribe({ trust: "not_covered" }) })],
  ["mt", state("mt", { unsubscribe: unsubscribe({ trust: "not_covered", mailto: { address: "leave@example.com", subject: "unsubscribe", body: "" } }) })],
]);
const ctx = { rows, agentPropose: true, now: NOW };

function refusal(items: Parameters<typeof validateTriage>[0], c = ctx): string {
  try {
    validateTriage(items, c);
  } catch (error) {
    if (error instanceof TriageError) return error.message;
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("validateTriage", () => {
  it("accepts valid items with positions", () => {
    const valid = validateTriage(
      [
        { messageId: "m1", action: "archive" },
        { messageId: "m2", action: "unsubscribe", note: "a list you never read" },
        { messageId: "mt", action: "snooze", snoozeUntil: LATER },
      ],
      ctx,
    );
    expect(valid).toEqual([
      { position: 0, messageId: "m1", accountId: "a1", threadId: "t-m1", action: "archive", snoozeUntil: null, note: null },
      { position: 1, messageId: "m2", accountId: "a1", threadId: "t-m2", action: "unsubscribe", snoozeUntil: null, note: "a list you never read" },
      { position: 2, messageId: "mt", accountId: "a1", threadId: "t-mt", action: "snooze", snoozeUntil: LATER, note: null },
    ]);
  });

  it("names the position only in each refusal", () => {
    const cases: [Parameters<typeof validateTriage>[0], string][] = [
      [[{ messageId: "nope", action: "archive" }], "Item 1"],
      [[{ messageId: "m1", action: "archive" }, { messageId: "sent", action: "archive" }], "Item 2"],
      [[{ messageId: "moving", action: "archive" }], "Item 1"],
      [[{ messageId: "detached", action: "mark_read" }], "Item 1"],
      [[{ messageId: "m1", action: "archive" }, { messageId: "m1", action: "spam" }], "Item 2"],
      [[{ messageId: "m1", action: "snooze" }], "Item 1"],
      [[{ messageId: "m1", action: "snooze", snoozeUntil: "2026-11-15T12:01:00.000Z" }], "Item 1"],
      [[{ messageId: "m1", action: "snooze", snoozeUntil: "2028-01-01T00:00:00.000Z" }], "Item 1"],
      [[{ messageId: "m1", action: "snooze", snoozeUntil: "tomorrow" }], "Item 1"],
      [[{ messageId: "m1", action: "archive", snoozeUntil: LATER }], "Item 1"],
      [[{ messageId: "m1", action: "unsubscribe" }], "Unsubscribe options of item 1 are not known yet; leave it out or ask the owner to open it"],
      [[{ messageId: "nc", action: "unsubscribe" }], "Item 1"],
      [[{ messageId: "m1", action: "archive", note: "x".repeat(201) }], "Item 1"],
      [[{ messageId: "m1", action: "archive", note: "line\nbreak" }], "Item 1"],
      [[{ messageId: "m1", action: "archive", note: "tag \u{E0041}" }], "Item 1"],
      [[{ messageId: "m1", action: "archive", note: "filler \u3164" }], "Item 1"],
    ];
    for (const [items, expected] of cases) {
      const text = refusal(items);
      expect(text, JSON.stringify(items)).toContain(expected);
      expect(text).not.toMatch(/example\.com|nope|Archive/);
    }
  });

  it("refuses reply items while agentPropose is off", () => {
    expect(refusal([{ messageId: "m1", action: "reply" }], { ...ctx, agentPropose: false })).toBe(
      "Item 1: replies need the owner's 'Let agents propose mail' setting; leave reply items out",
    );
    expect(validateTriage([{ messageId: "m1", action: "reply" }], ctx)).toHaveLength(1);
  });

  it("accepts a mailto-only unsubscribe", () => {
    expect(validateTriage([{ messageId: "mt", action: "unsubscribe" }], ctx)[0]?.action).toBe("unsubscribe");
  });
});

describe("mailTriageParamsSchema", () => {
  it("takes 1 to 50 items and a one-line summary", () => {
    expect(mailTriageParamsSchema.safeParse({ items: [] }).success).toBe(false);
    const items = Array.from({ length: 51 }, () => ({ messageId: "m1", action: "archive" }));
    expect(mailTriageParamsSchema.safeParse({ items }).success).toBe(false);
    expect(mailTriageParamsSchema.safeParse({ items: items.slice(0, 50) }).success).toBe(true);
    expect(mailTriageParamsSchema.safeParse({ items: [{ messageId: "m1", action: "delete" }] }).success).toBe(false);
    expect(mailTriageParamsSchema.safeParse({ items: items.slice(0, 1), summary: "x".repeat(161) }).success).toBe(false);
    expect(mailTriageParamsSchema.safeParse({ items: items.slice(0, 1), summary: "a\nb" }).success).toBe(false);
    expect(mailTriageParamsSchema.safeParse({ items: items.slice(0, 1), summary: "Tidy the inbox" }).success).toBe(true);
  });
});

describe("checkTriageCaps", () => {
  const row = (threadId: string, s: TriageHistoryRow["state"], minutesAgo: number): TriageHistoryRow => {
    const at = new Date(NOW.getTime() - minutesAgo * 60_000).toISOString();
    return { threadId, state: s, createdAt: at, updatedAt: at };
  };

  it("allows a first batch", () => {
    expect(checkTriageCaps([], "c1", NOW)).toBeNull();
  });

  it("allows one pending card per thread and three in total", () => {
    expect(TRIAGE_CAPS.pendingPerThread).toBe(1);
    expect(checkTriageCaps([row("c1", "pending", 1)], "c1", NOW)).not.toBeNull();
    expect(checkTriageCaps([row("c1", "confirming", 1)], "c1", NOW)).not.toBeNull();
    expect(checkTriageCaps([row("c2", "pending", 1), row("c3", "pending", 1)], "c1", NOW)).toBeNull();
    expect(checkTriageCaps([row("c2", "pending", 1), row("c3", "pending", 1), row("c4", "pending", 1)], "c1", NOW)).not.toBeNull();
  });

  it("allows six per thread per hour and thirty per day", () => {
    const hour = Array.from({ length: 6 }, (_, i) => row("c1", "applied", 5 + i));
    expect(checkTriageCaps(hour, "c1", NOW)).not.toBeNull();
    expect(checkTriageCaps(hour.slice(0, 5), "c1", NOW)).toBeNull();
    const day = Array.from({ length: 30 }, (_, i) => row(`d${i}`, "applied", 120 + i));
    expect(checkTriageCaps(day, "c1", NOW)).not.toBeNull();
    expect(checkTriageCaps(day.slice(0, 29), "c1", NOW)).toBeNull();
  });

  it("cools down ten minutes after three cancelled cards in a thread", () => {
    const cancelled = [row("c1", "cancelled", 70), row("c1", "cancelled", 65), row("c1", "cancelled", 5)];
    expect(checkTriageCaps(cancelled, "c1", NOW)).not.toBeNull();
    const old = [row("c1", "cancelled", 70), row("c1", "cancelled", 65), row("c1", "cancelled", 11)];
    expect(checkTriageCaps(old, "c1", NOW)).toBeNull();
    const mixed = [row("c1", "cancelled", 70), row("c1", "applied", 65), row("c1", "cancelled", 5)];
    expect(checkTriageCaps(mixed, "c1", NOW)).toBeNull();
    expect(TRIAGE_CAPS.coolDownMs).toBe(10 * 60_000);
  });
});

describe("triageContentHash", () => {
  const items: ValidatedItem[] = [
    { position: 0, messageId: "m1", accountId: "a1", threadId: "t1", action: "archive", snoozeUntil: null, note: null },
    { position: 1, messageId: "m2", accountId: "a1", threadId: "t2", action: "snooze", snoozeUntil: LATER, note: "later" },
  ];

  it("is stable across key order and changed by any field", async () => {
    const base = await triageContentHash(items, "summary");
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    const reordered = items.map((item) => Object.fromEntries(Object.entries(item).reverse()) as ValidatedItem);
    expect(await triageContentHash(reordered, "summary")).toBe(base);
    expect(await triageContentHash(items, "other")).not.toBe(base);
    expect(await triageContentHash(items, null)).not.toBe(base);
    for (const change of [
      { messageId: "m3" },
      { accountId: "a2" },
      { action: "spam" as const },
      { snoozeUntil: "2026-11-17T08:00:00.000Z" },
      { note: "soon" },
      { position: 5 },
    ]) {
      const changed = [items[0] as ValidatedItem, { ...(items[1] as ValidatedItem), ...change }];
      expect(await triageContentHash(changed, "summary"), JSON.stringify(change)).not.toBe(base);
    }
  });
});

describe("triageResultText", () => {
  it("names ids and counts only", () => {
    const text = triageResultText({
      state: "applied",
      items: [
        { messageId: "m1", action: "archive", outcome: "done" },
        { messageId: "m2", action: "archive", outcome: "done" },
        { messageId: "m3", action: "mark_read", outcome: "done" },
        { messageId: "m4", action: "snooze", outcome: "done" },
        { messageId: "m5", action: "spam", outcome: "done" },
        { messageId: "m6", action: "unsubscribe", outcome: "done" },
        { messageId: "m7", action: "archive", outcome: "not_approved" },
        { messageId: "m8", action: "reply", outcome: "reply_approved" },
        { messageId: "m9", action: "archive", outcome: "skipped" },
        { messageId: "m10", action: "unsubscribe", outcome: "rate_limited" },
      ],
    });
    expect(text).toContain("The owner approved 9 of 10 actions.");
    expect(text).toContain("Done: archived 2, marked read 1, snoozed 1, moved 1 to Spam, unsubscribe requested for 1.");
    expect(text).toContain("Not approved: m7. Do not propose those again unless the owner asks.");
    expect(text).toContain("Replies approved for: m8");
    expect(text).toContain("mail_propose");
    expect(text).toContain("Skipped (moved since): m9.");
    expect(text).toContain("Rate-limited, try later: m10.");
  });

  it("says what happened when nothing ran", () => {
    expect(triageResultText({ state: "cancelled", items: [] })).toMatch(/nothing ran/i);
    expect(triageResultText({ state: "changed", items: [] })).toMatch(/batch changed/i);
    expect(triageResultText({ state: "expired", items: [] })).toMatch(/nothing ran/i);
    expect(triageResultText({ state: "interrupted", items: [] })).toMatch(/restart/i);
  });
});
