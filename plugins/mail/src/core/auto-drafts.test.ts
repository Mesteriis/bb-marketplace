import { describe, expect, it } from "vitest";
import { AUTO_DRAFTS_PER_DAY, DraftBudget, eligible, replyDraftStale, type AutoDraftRow } from "./auto-drafts.ts";

const row = (overrides: Partial<AutoDraftRow> = {}): AutoDraftRow => ({
  folderRole: "inbox",
  bulk: false,
  listed: false,
  fromAddress: "ann@example.com",
  to: ["owner@example.org"],
  hasBody: true,
  inAiScope: true,
  suspicious: false,
  replyTo: [],
  answered: false,
  ...overrides,
});
const ctx = { own: new Set(["owner@example.org"]), sentTo: new Set(["ann@example.com"]) };

describe("eligible", () => {
  it("takes a message a person the owner writes to sent to the owner", () => {
    expect(eligible(row(), ctx)).toBe(true);
    expect(eligible(row({ fromAddress: "Ann@Example.com", to: ["Owner@Example.org"] }), ctx)).toBe(true);
    expect(eligible(row({ replyTo: ["Ann@example.com"] }), ctx)).toBe(true);
  });

  it.each([
    ["another folder", { folderRole: "archive" as const }],
    ["outside AI access", { inAiScope: false }],
    ["bulk mail", { bulk: true }],
    ["a mailing list", { listed: true }],
    ["an automated sender with no bulk signal", { bulk: null, fromAddress: "no-reply@example.com" }],
    ["the owner's own message", { fromAddress: "owner@example.org" }],
    ["a sender the owner never wrote to", { fromAddress: "stranger@example.net" }],
    ["the owner only in Cc", { to: ["team@example.com"] }],
    ["no body", { hasBody: false }],
    ["a message Mail warns about", { suspicious: true }],
    ["a reply that would go to an address the owner never wrote to", { replyTo: ["x@evil.example"] }],
    ["a message the owner has answered", { answered: true }],
  ])("leaves out %s", (_name, overrides) => {
    expect(eligible(row(overrides), { own: ctx.own, sentTo: new Set(["ann@example.com", "no-reply@example.com"]) })).toBe(false);
  });
});

describe("DraftBudget", () => {
  it("counts what was taken before a restart: the times given at the start", () => {
    let now = Date.parse("2026-11-20T08:00:00.000Z");
    const hour = 60 * 60 * 1000;
    // Two inside the last day, one older, in any order.
    const budget = new DraftBudget({ now: () => new Date(now) }, 3, [now - 2 * hour, now - 30 * hour, now - 5 * hour]);
    expect(budget.take()).toBe(true);
    expect(budget.take()).toBe(false);
    // The oldest counted one is 5 hours old: a slot opens 19 hours later.
    now += 19 * hour;
    expect(budget.take()).toBe(true);
    expect(budget.take()).toBe(false);
  });

  it("allows fifty a day and starts again a day after the oldest", () => {
    let now = Date.parse("2026-11-20T08:00:00.000Z");
    const budget = new DraftBudget({ now: () => new Date(now) });
    expect(AUTO_DRAFTS_PER_DAY).toBe(50);
    for (let i = 0; i < 50; i++) expect(budget.take()).toBe(true);
    expect(budget.take()).toBe(false);
    now += 24 * 60 * 60 * 1000 - 1;
    expect(budget.take()).toBe(false);
    now += 1;
    expect(budget.take()).toBe(true);
  });
});

describe("replyDraftStale", () => {
  const draft = { createdAt: "2026-11-20T08:00:00.000Z" };
  const now = new Date("2026-11-21T08:00:00.000Z");
  it("keeps a fresh draft of a message still in the Inbox", () => {
    expect(replyDraftStale(draft, { folderRole: "inbox", ownerRepliedAt: null, inAiScope: true }, now)).toBe(false);
    expect(replyDraftStale(draft, { folderRole: null, ownerRepliedAt: "2026-11-19T08:00:00.000Z", inAiScope: true }, now)).toBe(false);
  });
  it("drops it when the message is gone, in Trash or Spam, answered since, or after 14 days", () => {
    expect(replyDraftStale(draft, null, now)).toBe(true);
    expect(replyDraftStale(draft, { folderRole: "trash", ownerRepliedAt: null, inAiScope: true }, now)).toBe(true);
    expect(replyDraftStale(draft, { folderRole: "junk", ownerRepliedAt: null, inAiScope: true }, now)).toBe(true);
    expect(replyDraftStale(draft, { folderRole: "inbox", ownerRepliedAt: null, inAiScope: false }, now)).toBe(true);
    expect(replyDraftStale(draft, { folderRole: "inbox", ownerRepliedAt: "2026-11-20T09:00:00.000Z", inAiScope: true }, now)).toBe(true);
    expect(replyDraftStale(draft, { folderRole: "inbox", ownerRepliedAt: null, inAiScope: true }, new Date("2026-12-04T08:00:00.000Z"))).toBe(true);
    expect(replyDraftStale(draft, { folderRole: "inbox", ownerRepliedAt: null, inAiScope: true }, new Date("2026-12-04T07:59:59.000Z"))).toBe(false);
  });
});
