import { describe, expect, it } from "vitest";
import {
  NEEDS_REPLY_MAX,
  digestDue,
  dismissalKey,
  localDay,
  needsReply,
  parseDigestTime,
  sinceCounts,
  type ReplyCandidate,
} from "./digest.ts";

const NOW = new Date("2026-11-16T10:00:00.000Z");
const own = new Set(["me@example.com", "me@example.org"]);
const sentTo = new Set(["friend@example.com"]);

function candidate(overrides: Partial<ReplyCandidate> = {}): ReplyCandidate {
  return {
    threadId: "t1",
    accountId: "a1",
    messageId: "m1",
    dedupKey: "d1",
    date: "2026-11-15T10:00:00.000Z",
    folderRole: "inbox",
    fromAddress: "friend@example.com",
    to: ["me@example.com"],
    cc: [],
    bulk: false,
    lastSentAt: null,
    ...overrides,
  };
}

const ctx = (overrides: Partial<Parameters<typeof needsReply>[1]> = {}) => ({
  own,
  sentTo,
  dismissed: new Set<string>(),
  snoozed: new Set<string>(),
  now: NOW,
  ...overrides,
});

const ids = (list: ReplyCandidate[]) => list.map((c) => c.threadId);

describe("needsReply", () => {
  it("keeps a conversation that waits for the owner", () => {
    expect(ids(needsReply([candidate()], ctx()))).toEqual(["t1"]);
  });

  it("applies every condition", () => {
    const out = (c: ReplyCandidate, extra = {}) => needsReply([c], ctx(extra));
    expect(out(candidate({ folderRole: "archive" }))).toEqual([]);
    expect(out(candidate({ date: "2026-11-01T09:00:00.000Z" }))).toEqual([]);
    expect(out(candidate({ fromAddress: "Me@Example.org" }))).toEqual([]);
    expect(out(candidate({ bulk: true }))).toEqual([]);
    expect(out(candidate({ bulk: null, fromAddress: "noreply@example.com" }))).toEqual([]);
    expect(out(candidate({ fromAddress: "stranger@example.com", to: ["me@example.com"] }))).toHaveLength(1);
    expect(out(candidate({ fromAddress: "stranger@example.com", to: ["other@example.com"], cc: ["me@example.com"] }))).toEqual([]);
    expect(out(candidate(), { snoozed: new Set(["t1"]) })).toEqual([]);
    expect(out(candidate({ lastSentAt: "2026-11-15T11:00:00.000Z" }))).toEqual([]);
    expect(out(candidate({ lastSentAt: "2026-11-14T11:00:00.000Z" }))).toHaveLength(1);
  });

  it("drops a dismissed conversation until a newer message comes", () => {
    const dismissed = new Set([dismissalKey("a1", "d1")]);
    expect(needsReply([candidate()], ctx({ dismissed }))).toEqual([]);
    expect(needsReply([candidate({ dedupKey: "d2", messageId: "m2" })], ctx({ dismissed }))).toHaveLength(1);
  });

  it("answers at most 30, newest first", () => {
    const list = Array.from({ length: 40 }, (_, i) =>
      candidate({ threadId: `t${i}`, date: new Date(NOW.getTime() - (i + 1) * 3_600_000).toISOString() }),
    );
    const out = needsReply([...list].reverse(), ctx());
    expect(out).toHaveLength(NEEDS_REPLY_MAX);
    expect(out[0]!.threadId).toBe("t0");
    expect(out[29]!.threadId).toBe("t29");
  });
});

describe("digest time", () => {
  it("parses HH:MM", () => {
    expect(parseDigestTime("08:00")).toBe(480);
    expect(parseDigestTime(" 23:59 ")).toBe(1439);
    expect(parseDigestTime("24:00")).toBeNull();
    expect(parseDigestTime("8:00")).toBeNull();
    expect(parseDigestTime("")).toBeNull();
  });

  it("is due at or after the time when not built", () => {
    const day = "2026-11-16";
    expect(digestDue({ day, localMinutes: 479, built: false }, 480)).toBe(false);
    expect(digestDue({ day, localMinutes: 480, built: false }, 480)).toBe(true);
    expect(digestDue({ day, localMinutes: 900, built: false }, 480)).toBe(true);
    expect(digestDue({ day, localMinutes: 900, built: true }, 480)).toBe(false);
  });

  it("names the server-local day", () => {
    expect(localDay(new Date(2026, 0, 5, 23, 30))).toBe("2026-01-05");
  });
});

describe("sinceCounts", () => {
  const rows = [
    { bulk: true, fromAddress: "news@example.com", category: "newsletters" as const },
    { bulk: false, fromAddress: "bank@example.com", category: "bills" as const },
    { bulk: false, fromAddress: "noreply@example.com", category: "notifications" as const },
    { bulk: false, fromAddress: "friend@example.com", category: null },
  ];

  it("counts by category when on", () => {
    expect(sinceCounts(rows, true)).toEqual({ notifications: 1, newsletters: 1, bills: 1, bulk: 0, personal: 0 });
  });

  it("counts bulk against personal when off", () => {
    expect(sinceCounts(rows, false)).toEqual({ notifications: 0, newsletters: 0, bills: 0, bulk: 1, personal: 3 });
  });
});
