import { describe, expect, it } from "vitest";
import {
  AGENT_BODY_MAX_CHARS,
  PROPOSAL_CAPS,
  PROPOSAL_PURGE_MS,
  PROPOSAL_TTL_MS,
  RECIPIENT_ROW_COLLAPSE,
  SUBMIT_VALUE_MAX_BYTES,
  agentQuoteLines,
  checkProposalCaps,
  contentHash,
  linksIn,
  mergeAgentRecipients,
  nextProposalState,
  parseSubmitValue,
  proposalContent,
  recipientFlags,
  refusedHidden,
  revealHidden,
  type ProposalCapRow,
  type ProposalEvent,
  type ProposalState,
} from "./agent-propose.ts";
import type { ComposeAttachment, DraftRecord } from "./model.ts";
import type { ReplySource } from "./compose-reply.ts";

type HashedAttachment = ComposeAttachment & { sha256: string };

function draft(overrides: Partial<DraftRecord> = {}): DraftRecord {
  return {
    id: "d1",
    kind: "reply",
    accountId: "acc_1",
    sourceMessageId: "m1",
    messageId: "<x1@example.org>",
    inReplyTo: "<m1@example.org>",
    references: ["<m0@example.org>", "<m1@example.org>"],
    to: [{ name: "Anna Lind", address: "Anna@Example.org" }],
    cc: [],
    bcc: [{ name: null, address: "hidden@example.net" }],
    subject: "Re: Garden plans",
    doc: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Invented reply" }] }] },
    serverCopy: null,
    importHtml: null,
    origin: "owner",
    proposalId: null,
    createdAt: "2026-11-15T10:00:00.000Z",
    revision: 1,
    serverState: "none",
    updatedAt: "2026-11-15T10:00:00.000Z",
    ...overrides,
  };
}

const FILES: HashedAttachment[] = [
  { id: "a1", fileName: "plan.txt", mimeType: "text/plain", size: 10, sha256: "a".repeat(64) },
  { id: "a2", fileName: "map.png", mimeType: "image/png", size: 20, sha256: "b".repeat(64) },
];

describe("constants", () => {
  it("match the spec", () => {
    expect(PROPOSAL_TTL_MS).toBe(24 * 60 * 60 * 1000);
    expect(PROPOSAL_PURGE_MS).toBe(7 * 24 * 60 * 60 * 1000);
    expect(AGENT_BODY_MAX_CHARS).toBe(50_000);
    expect(SUBMIT_VALUE_MAX_BYTES).toBe(1024);
    expect(RECIPIENT_ROW_COLLAPSE).toBe(10);
    expect(PROPOSAL_CAPS).toEqual({
      pendingPerThread: 1,
      pendingTotal: 3,
      perThreadPerHour: 5,
      totalPerDay: 30,
      refusedInARow: 3,
      coolDownMs: 60 * 60 * 1000,
    });
  });
});

describe("proposalContent and contentHash", () => {
  const base = () => proposalContent(draft(), "Owner Name", "owner@example.org", FILES);

  it("is JSON with sorted keys and lowercased addresses", () => {
    const parsed = JSON.parse(base());
    expect(Object.keys(parsed)).toEqual([...Object.keys(parsed)].sort());
    expect(parsed.to[0].address).toBe("anna@example.org");
    expect(parsed.fromAddress).toBe("owner@example.org");
    expect(parsed.fromName).toBe("Owner Name");
    expect(parsed.attachments).toEqual([
      { fileName: "plan.txt", mimeType: "text/plain", sha256: "a".repeat(64), size: 10 },
      { fileName: "map.png", mimeType: "image/png", sha256: "b".repeat(64), size: 20 },
    ]);
    // Nested doc keys are sorted too.
    expect(base()).toContain('{"content":[{"content":[{"text":"Invented reply","type":"text"}]');
  });

  it("does not depend on key order of the input", () => {
    const d = draft();
    const shuffled = Object.fromEntries(Object.entries(d).reverse()) as DraftRecord;
    const docShuffled = {
      ...shuffled,
      doc: { content: d.doc.content, type: "doc" } as DraftRecord["doc"],
    };
    expect(proposalContent(docShuffled, "Owner Name", "owner@example.org", FILES)).toBe(base());
  });

  it("ignores id, revision, timestamps and server copy state", () => {
    const other = draft({ id: "d2", revision: 5, updatedAt: "2026-11-16T00:00:00.000Z", serverState: "saved" });
    expect(proposalContent(other, "Owner Name", "owner@example.org", FILES)).toBe(base());
  });

  it("is stable and hashes to 64 hex", async () => {
    const one = await contentHash(base());
    expect(one).toMatch(/^[0-9a-f]{64}$/);
    expect(await contentHash(base())).toBe(one);
  });

  const variants: [string, () => string][] = [
    ["From display name", () => proposalContent(draft(), "Someone Else", "owner@example.org", FILES)],
    ["From display name null", () => proposalContent(draft(), null, "owner@example.org", FILES)],
    ["From address", () => proposalContent(draft(), "Owner Name", "other@example.org", FILES)],
    ["account", () => proposalContent(draft({ accountId: "acc_2" }), "Owner Name", "owner@example.org", FILES)],
    ["kind", () => proposalContent(draft({ kind: "reply_all" }), "Owner Name", "owner@example.org", FILES)],
    ["source", () => proposalContent(draft({ sourceMessageId: "m2" }), "Owner Name", "owner@example.org", FILES)],
    ["to", () => proposalContent(draft({ to: [{ name: null, address: "bob@example.com" }] }), "Owner Name", "owner@example.org", FILES)],
    ["to name", () => proposalContent(draft({ to: [{ name: "Other", address: "anna@example.org" }] }), "Owner Name", "owner@example.org", FILES)],
    ["cc", () => proposalContent(draft({ cc: [{ name: null, address: "c@example.com" }] }), "Owner Name", "owner@example.org", FILES)],
    [
      "bcc order",
      () =>
        proposalContent(
          draft({
            bcc: [
              { name: null, address: "b2@example.net" },
              { name: null, address: "hidden@example.net" },
            ],
          }),
          "Owner Name",
          "owner@example.org",
          FILES,
        ),
    ],
    ["subject", () => proposalContent(draft({ subject: "Re: Other" }), "Owner Name", "owner@example.org", FILES)],
    [
      "doc",
      () =>
        proposalContent(
          draft({ doc: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Changed" }] }] } }),
          "Owner Name",
          "owner@example.org",
          FILES,
        ),
    ],
    ["inReplyTo", () => proposalContent(draft({ inReplyTo: null }), "Owner Name", "owner@example.org", FILES)],
    ["references", () => proposalContent(draft({ references: [] }), "Owner Name", "owner@example.org", FILES)],
    ["attachment order", () => proposalContent(draft(), "Owner Name", "owner@example.org", [FILES[1]!, FILES[0]!])],
    [
      "attachment sha256",
      () => proposalContent(draft(), "Owner Name", "owner@example.org", [{ ...FILES[0]!, sha256: "c".repeat(64) }, FILES[1]!]),
    ],
    ["attachment removed", () => proposalContent(draft(), "Owner Name", "owner@example.org", [FILES[0]!])],
  ];

  it.each(variants)("changes with %s", async (_name, build) => {
    expect(await contentHash(build())).not.toBe(await contentHash(base()));
  });

  it("does not change with address case", async () => {
    const upper = draft({ to: [{ name: "Anna Lind", address: "ANNA@EXAMPLE.ORG" }] });
    expect(await contentHash(proposalContent(upper, "Owner Name", "Owner@Example.org", FILES))).toBe(
      await contentHash(base()),
    );
  });
});

describe("mergeAgentRecipients", () => {
  const computed = {
    to: [{ name: "Anna Lind", address: "anna@example.org" }],
    cc: [{ name: "Ben", address: "ben@example.org" }],
  };

  it("new: the agent's lists, names dropped, nothing marked added", () => {
    const out = mergeAgentRecipients("new", { to: [], cc: [] }, {
      to: [{ name: "boss@example.com", address: "x@example.org" }],
      cc: [{ name: null, address: "c@example.com" }],
      bcc: [{ name: "B", address: "b@example.net" }],
    });
    expect(out).toEqual({
      to: [{ name: null, address: "x@example.org" }],
      cc: [{ name: null, address: "c@example.com" }],
      bcc: [{ name: null, address: "b@example.net" }],
      added: [],
    });
  });

  it("forward: the agent's lists, ignoring anything computed", () => {
    const out = mergeAgentRecipients("forward", computed, {
      to: [{ name: null, address: "f@example.com" }],
      cc: [],
      bcc: [],
    });
    expect(out.to).toEqual([{ name: null, address: "f@example.com" }]);
    expect(out.cc).toEqual([]);
    expect(out.added).toEqual([]);
  });

  it.each(["reply", "reply_all"] as const)("%s: computed kept with names, agent appended, added exact", (kind) => {
    const out = mergeAgentRecipients(kind, computed, {
      to: [
        { name: "Spoof", address: "ANNA@example.org" },
        { name: "Boss", address: "extra@example.com" },
      ],
      cc: [{ name: null, address: "cc2@example.com" }],
      bcc: [{ name: null, address: "b@example.net" }],
    });
    expect(out.to).toEqual([
      { name: "Anna Lind", address: "anna@example.org" },
      { name: null, address: "extra@example.com" },
    ]);
    expect(out.cc).toEqual([
      { name: "Ben", address: "ben@example.org" },
      { name: null, address: "cc2@example.com" },
    ]);
    expect(out.bcc).toEqual([{ name: null, address: "b@example.net" }]);
    expect(out.added).toEqual(["extra@example.com", "cc2@example.com", "b@example.net"]);
  });

  it("reply: an empty agent list removes nothing", () => {
    const out = mergeAgentRecipients("reply", computed, { to: [], cc: [], bcc: [] });
    expect(out.to).toEqual(computed.to);
    expect(out.cc).toEqual(computed.cc);
    expect(out.added).toEqual([]);
  });

  it("dedupes across fields and case variants, To first", () => {
    const out = mergeAgentRecipients("new", { to: [], cc: [] }, {
      to: [
        { name: null, address: "a@example.com" },
        { name: null, address: "A@Example.com" },
      ],
      cc: [
        { name: null, address: "a@example.com" },
        { name: null, address: "c@example.com" },
      ],
      bcc: [
        { name: null, address: "C@example.com" },
        { name: null, address: "d@example.com" },
      ],
    });
    expect(out.to.map((a) => a.address)).toEqual(["a@example.com"]);
    expect(out.cc.map((a) => a.address)).toEqual(["c@example.com"]);
    expect(out.bcc.map((a) => a.address)).toEqual(["d@example.com"]);
  });

  it("reply: an agent Cc of a computed To address is not added twice", () => {
    const out = mergeAgentRecipients("reply_all", computed, {
      to: [],
      cc: [{ name: null, address: "anna@example.org" }],
      bcc: [{ name: null, address: "Ben@example.org" }],
    });
    expect(out.cc).toEqual(computed.cc);
    expect(out.bcc).toEqual([]);
    expect(out.added).toEqual([]);
  });
});

describe("recipientFlags", () => {
  const ctx = {
    sentTo: new Set(["known@example.com"]),
    ownDomains: ["example.org"],
    added: ["extra@example.com"],
  };

  it("new when never sent to; received-from does not count", () => {
    expect(recipientFlags("stranger@example.com", ctx)).toEqual(["new", "outside"]);
    expect(recipientFlags("known@example.com", ctx)).toEqual(["outside"]);
    expect(recipientFlags("Known@Example.com", ctx)).toEqual(["outside"]);
  });

  it("added only when listed", () => {
    expect(recipientFlags("EXTRA@example.com", ctx)).toEqual(["new", "added", "outside"]);
  });

  it("outside by own domains, case-insensitive", () => {
    expect(recipientFlags("colleague@Example.ORG", { ...ctx, sentTo: new Set(["colleague@example.org"]) })).toEqual([]);
    expect(recipientFlags("x@sub.example.org", { ...ctx, sentTo: new Set(["x@sub.example.org"]) })).toEqual(["outside"]);
  });

  it("hidden_chars when the address holds bidi or zero-width characters", () => {
    expect(recipientFlags("known​@example.com", ctx)).toContain("hidden_chars");
  });
});

describe("revealHidden", () => {
  const codePoints = [
    0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0x200e, 0x200f, 0x061c,
    0x200b, 0x200c, 0x200d, 0x2060, 0xfeff,
  ];

  it.each(codePoints)("strips and counts U+%s", (cp) => {
    const ch = String.fromCodePoint(cp);
    expect(revealHidden(`a${ch}b${ch}`)).toEqual({ shown: "ab", hidden: 2 });
  });

  it.each([
    0x00ad, 0x180e, 0x2061, 0x2062, 0x2063, 0x2064, 0x206a, 0x206f, 0xfff9, 0xfffb, 0x110bd, 0x1d173, 0x1d17a,
    0xe0001, 0xe0020, 0xe0041, 0xe007f, 0xfe00, 0xfe0f, 0xe0100, 0xe01ef, 0x2028, 0x2029, 0x3164, 0x115f, 0x1160,
    0xffa0, 0x034f, 0x17b4, 0x17b5, 0x180b, 0x180f,
  ])("strips and counts invisible U+%s beyond bidi and zero-width marks", (cp) => {
    const ch = String.fromCodePoint(cp);
    expect(revealHidden(`a${ch}b${ch}`)).toEqual({ shown: "ab", hidden: 2 });
  });

  it("counts a supplementary character once", () => {
    expect(revealHidden("a\u{E0041}b").hidden).toBe(1);
  });

  it("leaves clean text alone", () => {
    const text = "Plain invented text — with dashes, émigré and 日本語.\nNew line\ttab";
    expect(revealHidden(text)).toEqual({ shown: text, hidden: 0 });
  });
});

describe("refusedHidden", () => {
  it.each([0xe0000, 0xe0001, 0xe0041, 0xe007f, 0x3164, 0x115f, 0x1160, 0xffa0])("refuses U+%s", (cp) => {
    expect(refusedHidden(`a${String.fromCodePoint(cp)}b`)).toBe(true);
  });

  it.each([0x200b, 0x202e, 0x00ad, 0xfe0f, 0x2028])("only reveals U+%s", (cp) => {
    expect(refusedHidden(`a${String.fromCodePoint(cp)}b`)).toBe(false);
  });
});

describe("linksIn", () => {
  it("finds scheme links and mailto", () => {
    expect(linksIn("See https://Example.com/a?b=1 and http://example.net. Write mailto:x@Example.org!")).toEqual([
      { url: "https://Example.com/a?b=1", host: "example.com" },
      { url: "http://example.net", host: "example.net" },
      { url: "mailto:x@Example.org", host: "example.org" },
    ]);
  });

  it("finds www., host.tld/path and bare host.tld", () => {
    expect(linksIn("Go to www.example.com, then evil.example/login or just Example.org.")).toEqual([
      { url: "www.example.com", host: "www.example.com" },
      { url: "evil.example/login", host: "evil.example" },
      { url: "Example.org", host: "example.org" },
    ]);
  });

  it("shows IDN hosts as punycode", () => {
    const [link] = linksIn("Visit пример.рф/путь");
    expect(link?.host).toBe("xn--e1afmkfd.xn--p1ai");
  });

  it("accepts a punycode TLD", () => {
    expect(linksIn("shop.xn--p1ai")).toEqual([{ url: "shop.xn--p1ai", host: "shop.xn--p1ai" }]);
  });

  it("ignores e.g., i.e., version numbers, decimals and plain addresses", () => {
    expect(linksIn("e.g. this, i.e. that; version 1.2.3 costs 3.50, write to anna@example.org.")).toEqual([]);
  });

  it("dedupes in order", () => {
    expect(linksIn("example.com example.com https://a.example.com example.com")).toEqual([
      { url: "example.com", host: "example.com" },
      { url: "https://a.example.com", host: "a.example.com" },
    ]);
  });

  it("finds links in brackets", () => {
    expect(linksIn("(see example.com) <https://example.net/x>")).toEqual([
      { url: "example.com", host: "example.com" },
      { url: "https://example.net/x", host: "example.net" },
    ]);
  });

  it("is linear on long input", () => {
    const text = "a.".repeat(25_000);
    const started = Date.now();
    linksIn(text);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe("checkProposalCaps", () => {
  const now = new Date("2026-11-15T12:00:00.000Z");
  const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
  const MIN = 60 * 1000;
  const HOUR = 60 * MIN;
  const row = (threadId: string, state: ProposalState, createdMsAgo: number, updatedMsAgo = createdMsAgo): ProposalCapRow => ({
    threadId,
    state,
    createdAt: ago(createdMsAgo),
    updatedAt: ago(updatedMsAgo),
  });

  it("allows with no rows", () => {
    expect(checkProposalCaps([], "t1", now)).toBeNull();
  });

  it("one pending card per thread (confirming counts)", () => {
    expect(checkProposalCaps([row("t1", "pending", MIN)], "t1", now)).toBe("pending_thread");
    expect(checkProposalCaps([row("t1", "confirming", MIN)], "t1", now)).toBe("pending_thread");
    expect(checkProposalCaps([row("t2", "pending", MIN)], "t1", now)).toBeNull();
  });

  it("three pending cards in all threads", () => {
    const rows = [row("t2", "pending", MIN), row("t3", "pending", MIN), row("t4", "pending", MIN)];
    expect(checkProposalCaps(rows, "t1", now)).toBe("pending_total");
    expect(checkProposalCaps(rows.slice(0, 2), "t1", now)).toBeNull();
  });

  it("five per thread per hour", () => {
    const rows = Array.from({ length: 5 }, (_, i) => row("t1", "queued", (i + 1) * MIN));
    expect(checkProposalCaps(rows, "t1", now)).toBe("thread_hour");
    expect(checkProposalCaps(rows, "t2", now)).toBeNull();
    const older = Array.from({ length: 5 }, (_, i) => row("t1", "queued", HOUR + (i + 1) * MIN));
    expect(checkProposalCaps(older, "t1", now)).toBeNull();
  });

  it("thirty in all threads per day", () => {
    const rows = Array.from({ length: 30 }, (_, i) => row(`t${i + 10}`, "queued", 2 * HOUR + i * MIN));
    expect(checkProposalCaps(rows, "t1", now)).toBe("total_day");
    expect(checkProposalCaps(rows.slice(1), "t1", now)).toBeNull();
    const older = Array.from({ length: 30 }, (_, i) => row(`t${i + 10}`, "queued", 25 * HOUR + i * MIN));
    expect(checkProposalCaps(older, "t1", now)).toBeNull();
  });

  it("cool-down after three refused or cancelled in a row, reset after the hour", () => {
    const rows = [
      row("t1", "cancelled", 3 * HOUR, 50 * MIN),
      row("t1", "refused", 2 * HOUR, 40 * MIN),
      row("t1", "cancelled", 90 * MIN, 30 * MIN),
    ];
    expect(checkProposalCaps(rows, "t1", now)).toBe("cool_down");
    expect(checkProposalCaps(rows, "t2", now)).toBeNull();
    const later = rows.map((r) => ({ ...r, updatedAt: ago(61 * MIN) }));
    expect(checkProposalCaps(later, "t1", now)).toBeNull();
  });

  it("no cool-down when a success breaks the run", () => {
    const rows = [
      row("t1", "cancelled", 3 * HOUR, 50 * MIN),
      row("t1", "queued", 2 * HOUR, 40 * MIN),
      row("t1", "refused", 90 * MIN, 30 * MIN),
      row("t1", "cancelled", 80 * MIN, 20 * MIN),
    ];
    expect(checkProposalCaps(rows, "t1", now)).toBeNull();
  });

  it("no cool-down with only two", () => {
    const rows = [row("t1", "cancelled", 2 * HOUR, 40 * MIN), row("t1", "refused", 90 * MIN, 30 * MIN)];
    expect(checkProposalCaps(rows, "t1", now)).toBeNull();
  });
});

describe("nextProposalState", () => {
  const allowed: [ProposalState, ProposalEvent, ProposalState][] = [
    ["pending", "confirm", "confirming"],
    ["confirming", "queue", "queued"],
    ["pending", "open", "opened"],
    ["confirming", "open", "opened"],
    ["confirming", "queue_failed", "opened"],
    ["queued", "undo", "opened"],
    ["pending", "cancel", "cancelled"],
    ["pending", "expire", "expired"],
    ["pending", "refuse", "refused"],
    ["confirming", "expire", "expired"],
    ["confirming", "refuse", "refused"],
    ["confirming", "stale", "pending"],
    ["confirming", "cancel", "cancelled"],
  ];
  const states: ProposalState[] = ["pending", "confirming", "queued", "opened", "cancelled", "expired", "refused"];
  const events: ProposalEvent[] = ["confirm", "queue", "open", "queue_failed", "cancel", "expire", "refuse", "undo", "stale"];

  it.each(allowed)("%s --%s--> %s", (from, event, to) => {
    expect(nextProposalState(from, event)).toBe(to);
  });

  it("refuses every other transition", () => {
    for (const from of states) {
      for (const event of events) {
        if (allowed.some(([f, e]) => f === from && e === event)) continue;
        expect(nextProposalState(from, event), `${from} ${event}`).toBeNull();
      }
    }
  });
});

describe("parseSubmitValue", () => {
  const good = {
    action: "send",
    proposalId: "p_1",
    contentHash: "a".repeat(64),
    viewToken: "A".repeat(42) + "_",
  };

  it("parses a good value", () => {
    expect(parseSubmitValue(good)).toEqual(good);
    expect(parseSubmitValue({ ...good, action: "open" })).toEqual({ ...good, action: "open" });
  });

  it.each([
    ["extra key", { ...good, extra: 1 }],
    ["bad action", { ...good, action: "cancel" }],
    ["short hash", { ...good, contentHash: "a".repeat(63) }],
    ["upper hash", { ...good, contentHash: "A".repeat(64) }],
    ["short token", { ...good, viewToken: "A".repeat(42) }],
    ["padded token", { ...good, viewToken: "A".repeat(42) + "=" }],
    ["token with plus", { ...good, viewToken: "A".repeat(42) + "+" }],
    ["empty id", { ...good, proposalId: "" }],
    ["missing token", { action: "send", proposalId: "p_1", contentHash: "a".repeat(64) }],
    ["null", null],
    ["string", "send"],
  ])("refuses %s", (_name, value) => {
    expect(parseSubmitValue(value)).toBeNull();
  });

  it("refuses a value over the byte cap", () => {
    expect(parseSubmitValue({ ...good, proposalId: "p".repeat(SUBMIT_VALUE_MAX_BYTES) })).toBeNull();
  });

  it("refuses a value that cannot be serialized", () => {
    const loop: Record<string, unknown> = { ...good };
    loop.self = loop;
    expect(parseSubmitValue(loop)).toBeNull();
  });
});

describe("agentQuoteLines", () => {
  const source: ReplySource = {
    from: { name: "Anna Lind", address: "anna@example.org" },
    to: [{ name: null, address: "owner@example.org" }],
    cc: [],
    replyTo: [],
    subject: "Garden plans",
    date: "2026-11-14T09:05:00.000Z",
    messageId: "<m1@example.org>",
    inReplyTo: null,
    references: [],
  };
  const header = ["On 14 Nov 2026 09:05 UTC, Anna Lind <anna@example.org> wrote:"];

  it("text only", () => {
    expect(agentQuoteLines(source, "reply", { text: "Line one\r\nLine two", html: null })).toEqual([
      ...header,
      "Line one",
      "Line two",
    ]);
  });

  it("HTML only, through htmlToText", () => {
    const lines = agentQuoteLines(source, "reply_all", { text: null, html: "<p>First</p><p>Second <b>bold</b></p>" });
    expect(lines[0]).toBe(header[0]);
    expect(lines).toContain("First");
    expect(lines).toContain("Second bold");
    expect(lines.slice(1).join("\n")).not.toMatch(/[<>]/);
  });

  it("both: the stored text wins", () => {
    expect(agentQuoteLines(source, "reply", { text: "Stored text", html: "<p>HTML text</p>" })).toEqual([
      ...header,
      "Stored text",
    ]);
  });

  it("neither: the header only", () => {
    expect(agentQuoteLines(source, "reply", { text: null, html: null })).toEqual(header);
  });

  it("forward: the forwarded-message block", () => {
    const lines = agentQuoteLines(source, "forward", { text: "Body", html: null });
    expect(lines[0]).toBe("---------- Forwarded message ----------");
    expect(lines.at(-1)).toBe("Body");
  });
});
