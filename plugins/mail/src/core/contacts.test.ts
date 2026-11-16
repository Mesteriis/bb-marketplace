import { describe, expect, it } from "vitest";
import {
  CONTACT_BODY_CHARS,
  NO_BULK_HEADERS,
  classifyBulk,
  correspondenceOf,
  isAutomatedAddress,
  isBulkRow,
  pickSendingAccount,
  queryWords,
  rankContacts,
  messageTextMask,
  textMask,
  type BulkHeaders,
  type ContactMessage,
} from "./contacts.ts";

const headers = (overrides: Partial<BulkHeaders>): BulkHeaders => ({ ...NO_BULK_HEADERS, ...overrides });

describe("classifyBulk", () => {
  it.each<[string, Partial<BulkHeaders>, string, boolean]>([
    ["no list headers, a person", {}, "anna@example.org", false],
    ["List-Id", { listId: "<news.example.org>" }, "anna@example.org", true],
    ["List-Unsubscribe", { listUnsubscribe: "<mailto:u@example.org>" }, "anna@example.org", true],
    ["blank List-Id", { listId: "  " }, "anna@example.org", false],
    ["Precedence bulk", { precedence: "bulk" }, "anna@example.org", true],
    ["Precedence list (case, spaces)", { precedence: " List " }, "anna@example.org", true],
    ["Precedence junk", { precedence: "junk" }, "anna@example.org", true],
    ["Precedence first-class", { precedence: "first-class" }, "anna@example.org", false],
    ["Auto-Submitted no", { autoSubmitted: "no" }, "anna@example.org", false],
    ["Auto-Submitted No with a comment", { autoSubmitted: "No (person)" }, "anna@example.org", false],
    ["Auto-Submitted auto-replied", { autoSubmitted: "auto-replied" }, "anna@example.org", true],
    ["Auto-Submitted auto-generated; param", { autoSubmitted: "auto-generated; owner-email=x@example.org" }, "anna@example.org", true],
    ["no-reply sender", {}, "no-reply@example.org", true],
    ["noreply sender", {}, "NoReply@example.org", true],
    ["donotreply sender", {}, "do_not_reply@example.org", true],
    ["notifications sender", {}, "notifications@example.org", true],
    ["newsletter sender", {}, "newsletter+weekly@example.org", true],
    ["mailer-daemon", {}, "MAILER-DAEMON@example.org", true],
    ["postmaster", {}, "postmaster@example.org", true],
    ["a person named Noah", {}, "noah@example.org", false],
  ])("%s", (_name, overrides, from, bulk) => {
    expect(classifyBulk(headers(overrides), from)).toBe(bulk);
  });

  it("an unknown row (NULL) falls back to the sender heuristics only", () => {
    expect(isBulkRow(null, "anna@example.org")).toBe(false);
    expect(isBulkRow(null, "noreply@example.org")).toBe(true);
    expect(isBulkRow(false, "anna@example.org")).toBe(false);
    expect(isBulkRow(true, "anna@example.org")).toBe(true);
    expect(isAutomatedAddress("not-an-address")).toBe(false);
  });
});

describe("queryWords and textMask", () => {
  it("splits on non-letters, folds case and ё, drops duplicates, keeps at most 8 words", () => {
    expect(queryWords("  Бухгалтерия, ACME-ёлки acme ")).toEqual(["бухгалтерия", "acme", "елки"]);
    expect(queryWords("@@ --")).toEqual([]);
    expect(queryWords("a b c d e f g h i j")).toHaveLength(8);
  });

  it("matches word prefixes only, case-insensitively, Cyrillic included", () => {
    const words = ["бухгалт", "invoice"];
    expect(textMask("Счёт от БУХГАЛТЕРИИ", words)).toBe(0b01);
    expect(textMask("Invoices for October", words)).toBe(0b10);
    expect(textMask("Неbухгалт reinvoice", words)).toBe(0);
    expect(textMask("бухгалтерия: invoice", words)).toBe(0b11);
    expect(textMask("Ёлка", ["елк"])).toBe(1);
  });
});

const OWNERS = [
  { id: "acc_1", addresses: ["owner@example.org"] },
  { id: "acc_2", addresses: ["second@example.org"] },
];

function msg(overrides: Partial<ContactMessage>): ContactMessage {
  return {
    accountId: "acc_1",
    dedupKey: `k_${Math.random()}`,
    date: "2026-11-01T00:00:00.000Z",
    from: { name: null, address: "someone@example.org" },
    to: [{ name: null, address: "owner@example.org" }],
    cc: [],
    inSent: false,
    bulk: false,
    textMask: 0,
    ...overrides,
  };
}

describe("rankContacts", () => {
  it("returns header people with counts, the owner account, newest date; never the owner", () => {
    const result = rankContacts(
      [
        msg({ from: { name: "Anna Accountant", address: "Anna@Books.example" }, date: "2026-10-01T00:00:00.000Z" }),
        msg({
          from: { name: null, address: "owner@example.org" },
          to: [{ name: "Anna A.", address: "anna@books.example" }],
          inSent: true,
          date: "2026-10-05T00:00:00.000Z",
        }),
      ],
      queryWords("anna"),
      OWNERS,
      new Set(),
      5,
    );
    expect(result).toEqual([
      {
        address: "anna@books.example",
        name: "Anna A.",
        ownerAccount: "owner@example.org",
        sentByOwner: 1,
        received: 1,
        lastDate: "2026-10-05T00:00:00.000Z",
      },
    ]);
  });

  it("matches a word in the name, the address or the domain, or in the exchanged mail's text", () => {
    // textMask is computed per query: here only Ivan's mail mentions "invoice".
    const lookup = (words: string[]) => {
      const invoice = words.indexOf("invoice");
      return rankContacts(
        messages.map((m) => (m.from.address === "ivan@books.example" && invoice >= 0 ? { ...m, textMask: 1 << invoice } : m)),
        words,
        OWNERS,
        new Set(),
        5,
      ).map((c) => c.address);
    };
    const messages = [
      msg({ from: { name: "Ivan", address: "ivan@books.example" } }),
      msg({ from: { name: "Олег Бухгалтер", address: "oleg@example.net" } }),
      msg({ from: { name: null, address: "pay@accounting.example" } }),
      msg({ from: { name: null, address: "other@example.net" } }),
    ];
    expect(lookup(["invoice"])).toEqual(["ivan@books.example"]);
    expect(lookup(["бухгалт"])).toEqual(["oleg@example.net"]);
    expect(lookup(["account"])).toEqual(["pay@accounting.example"]);
    // Every word must match somewhere: the name gives one, the mail the other.
    expect(lookup(["ivan", "invoice"])).toEqual(["ivan@books.example"]);
    expect(lookup(["oleg", "invoice"])).toEqual([]);
    expect(rankContacts(messages, [], OWNERS, new Set(), 5)).toEqual([]);
  });

  it("drops bulk mail, automated addresses and senders of bulk mail the owner never wrote to", () => {
    const messages = [
      msg({ from: { name: "Shop", address: "shop@example.net" }, bulk: true }),
      msg({ from: { name: "Shop", address: "shop@example.net" } }),
      msg({ from: { name: "Old", address: "legacy@example.net" }, bulk: null }),
      msg({ from: { name: "Bot", address: "noreply@example.net" }, bulk: null }),
      msg({ from: { name: "Bot", address: "notifications@example.net" } }),
      msg({ from: { name: "Group", address: "friend@example.net" }, bulk: true }),
      msg({ from: { name: null, address: "owner@example.org" }, to: [{ name: null, address: "friend@example.net" }], inSent: true }),
    ];
    const found = rankContacts(messages, ["example"], OWNERS, new Set(["shop@example.net", "friend@example.net"]), 10);
    expect(found.map((c) => [c.address, c.sentByOwner, c.received])).toEqual([
      ["friend@example.net", 1, 0],
      ["legacy@example.net", 0, 1],
    ]);
  });

  it("counts a message once across folders (dedup key) and leaves out the owner's own addresses", () => {
    const copy = { dedupKey: "gm:1", from: { name: "Anna", address: "anna@example.net" }, cc: [{ name: null, address: "second@example.org" }] };
    const found = rankContacts([msg(copy), msg(copy)], ["anna"], OWNERS, new Set(), 5);
    expect(found).toHaveLength(1);
    expect(found[0]!.received).toBe(1);
    expect(rankContacts([msg(copy)], ["second"], OWNERS, new Set(), 5)).toEqual([]);
  });

  it("ranks people the owner wrote to first (by count), then two-way, then recency, then count", () => {
    const sent = (to: string, date: string) =>
      msg({ from: { name: null, address: "owner@example.org" }, to: [{ name: null, address: to }], date });
    const received = (from: string, date: string) => msg({ from: { name: null, address: from }, date });
    const messages = [
      received("recent@x.example", "2026-11-10T00:00:00.000Z"),
      received("frequent@x.example", "2026-01-01T00:00:00.000Z"),
      received("frequent@x.example", "2026-01-02T00:00:00.000Z"),
      sent("oneway@x.example", "2026-03-01T00:00:00.000Z"),
      sent("twoway@x.example", "2026-02-01T00:00:00.000Z"),
      received("twoway@x.example", "2026-02-02T00:00:00.000Z"),
      sent("many@x.example", "2025-01-01T00:00:00.000Z"),
      sent("many@x.example", "2025-01-02T00:00:00.000Z"),
      received("old@x.example", "2026-01-01T00:00:00.000Z"),
    ];
    expect(rankContacts(messages, ["x"], OWNERS, new Set(), 20).map((c) => c.address)).toEqual([
      "many@x.example",
      "twoway@x.example",
      "oneway@x.example",
      "recent@x.example",
      "frequent@x.example",
      "old@x.example",
    ]);
    expect(rankContacts(messages, ["x"], OWNERS, new Set(), 2)).toHaveLength(2);
  });

  it("the owner account is the one that exchanged mail with them most recently", () => {
    const found = rankContacts(
      [
        msg({ accountId: "acc_1", from: { name: null, address: "anna@example.net" }, date: "2026-01-01T00:00:00.000Z" }),
        msg({ accountId: "acc_1", from: { name: null, address: "anna@example.net" }, date: "2026-01-02T00:00:00.000Z" }),
        msg({ accountId: "acc_2", from: { name: null, address: "anna@example.net" }, date: "2026-05-01T00:00:00.000Z", to: [{ name: null, address: "second@example.org" }] }),
      ],
      ["anna"],
      OWNERS,
      new Set(),
      5,
    );
    expect(found[0]!.ownerAccount).toBe("second@example.org");
  });

  it("drops malformed addresses", () => {
    expect(rankContacts([msg({ from: { name: "x", address: "a b@example.net" } })], ["x"], OWNERS, new Set(), 5)).toEqual([]);
  });
});

describe("correspondenceOf and pickSendingAccount", () => {
  const messages = [
    msg({ accountId: "acc_1", from: { name: null, address: "anna@example.net" }, date: "2026-01-01T00:00:00.000Z" }),
    msg({
      accountId: "acc_2",
      from: { name: null, address: "second@example.org" },
      to: [{ name: null, address: "ANNA@example.net" }],
      date: "2026-06-01T00:00:00.000Z",
    }),
    msg({ accountId: "acc_2", from: { name: null, address: "anna@example.net" }, bulk: true, date: "2026-07-01T00:00:00.000Z" }),
  ];

  it("per account: the latest mail received from and sent to the addresses, bulk left out", () => {
    expect(correspondenceOf(messages, ["anna@example.net"], OWNERS)).toEqual([
      { accountId: "acc_1", lastReceived: "2026-01-01T00:00:00.000Z", lastSent: null },
      { accountId: "acc_2", lastReceived: null, lastSent: "2026-06-01T00:00:00.000Z" },
    ]);
  });

  it.each<[string, { accountId: string; lastReceived: string | null; lastSent: string | null }[], string | null]>([
    ["no history", [], null],
    ["received wins over sent", [
      { accountId: "acc_1", lastReceived: "2026-01-01T00:00:00.000Z", lastSent: null },
      { accountId: "acc_2", lastReceived: null, lastSent: "2026-06-01T00:00:00.000Z" },
    ], "acc_1"],
    ["the most recent receipt", [
      { accountId: "acc_1", lastReceived: "2026-01-01T00:00:00.000Z", lastSent: null },
      { accountId: "acc_2", lastReceived: "2026-02-01T00:00:00.000Z", lastSent: null },
    ], "acc_2"],
    ["a tie goes to the latest send", [
      { accountId: "acc_1", lastReceived: "2026-01-01T00:00:00.000Z", lastSent: "2026-03-01T00:00:00.000Z" },
      { accountId: "acc_2", lastReceived: "2026-01-01T00:00:00.000Z", lastSent: "2026-04-01T00:00:00.000Z" },
    ], "acc_2"],
    ["sent only", [{ accountId: "acc_2", lastReceived: null, lastSent: "2026-06-01T00:00:00.000Z" }], "acc_2"],
    ["an account that no longer exists is skipped", [{ accountId: "acc_9", lastReceived: "2026-06-01T00:00:00.000Z", lastSent: null }], null],
  ])("%s", (_name, history, picked) => {
    expect(pickSendingAccount(OWNERS, history)).toBe(picked);
  });
});

describe("own addresses by account (slice 3d)", () => {
  const WITH_ALIAS = [
    { id: "acc_1", addresses: ["owner@example.org", "alias@example.net"] },
    { id: "acc_2", addresses: ["second@example.org"] },
  ];

  it("never ranks an alias as a contact, and mail sent from it counts as the owner's", () => {
    const messages = [
      msg({ from: { name: null, address: "anna@example.net" }, to: [{ name: null, address: "alias@example.net" }] }),
      msg({ from: { name: "Me", address: "Alias@example.net" }, to: [{ name: "Bob", address: "bob@example.net" }] }),
    ];
    const found = rankContacts(messages, ["example"], WITH_ALIAS, new Set(), 10);
    expect(found.map((c) => c.address).sort()).toEqual(["anna@example.net", "bob@example.net"]);
    expect(found.find((c) => c.address === "bob@example.net")).toMatchObject({ sentByOwner: 1, ownerAccount: "owner@example.org" });
  });

  it("picks the alias's account for correspondence sent from the alias", () => {
    const messages = [
      msg({ accountId: "acc_1", from: { name: null, address: "alias@example.net" }, to: [{ name: null, address: "carl@example.net" }], date: "2026-06-01T00:00:00.000Z" }),
    ];
    const history = correspondenceOf(messages, ["carl@example.net"], WITH_ALIAS);
    expect(history).toEqual([{ accountId: "acc_1", lastReceived: null, lastSent: "2026-06-01T00:00:00.000Z" }]);
    expect(pickSendingAccount(WITH_ALIAS, history)).toBe("acc_1");
  });
});

describe("messageTextMask over redacted text (slice 3f)", () => {
  it("never matches a secret, and still matches ordinary words", () => {
    const words = ["482913", "garden", "canarytoken"];
    const token = "ghp_" + "CanaryToken0123456789abcdefXYZ";
    expect(messageTextMask("Your sign-in code", "Code 482913", `Garden club ${token}`, words)).toBe(0b010);
    expect(messageTextMask("Code 482913 inside", null, null, ["482913"])).toBe(0);
    expect(messageTextMask("Plain", "plain words", "Garden", ["garden"])).toBe(1);
  });

  it("redacts the body before its cut", () => {
    const token = "ghp_" + "CanaryToken0123456789abcdefXYZ";
    const body = `${"w ".repeat((CONTACT_BODY_CHARS - 10) / 2)}${token}`;
    expect(messageTextMask(null, null, body, ["ghp"])).toBe(0);
  });
});
