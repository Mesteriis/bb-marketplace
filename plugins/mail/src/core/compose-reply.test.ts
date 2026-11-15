import { describe, expect, it } from "vitest";
import {
  quoteHeaderText,
  replyRecipients,
  threadingHeaders,
  type ReplySource,
} from "./compose-reply.ts";

const OWN = ["owner@example.org", "Owner.Work@example.com"];

function source(overrides: Partial<ReplySource> = {}): ReplySource {
  return {
    from: { name: "Anna Lind", address: "anna@example.org" },
    to: [{ name: null, address: "owner@example.org" }],
    cc: [],
    replyTo: [],
    subject: "Garden plans",
    date: "2026-11-14T09:05:00.000Z",
    messageId: "<m1@example.org>",
    inReplyTo: null,
    references: [],
    ...overrides,
  };
}

const addr = (address: string, name: string | null = null) => ({ name, address });

describe("replyRecipients: Reply", () => {
  it("answers the sender when there is no Reply-To", () => {
    expect(replyRecipients(source(), "reply", OWN)).toEqual({
      to: [addr("anna@example.org", "Anna Lind")],
      cc: [],
      dropped: [],
    });
  });

  it("answers Reply-To when the message has one", () => {
    const result = replyRecipients(
      source({ replyTo: [addr("list@example.net", "Garden list"), addr("b@example.net")] }),
      "reply",
      OWN,
    );
    expect(result).toEqual({
      to: [addr("list@example.net", "Garden list"), addr("b@example.net")],
      cc: [],
      dropped: [],
    });
  });

  it("answers the original To when replying to one's own message, without its Cc", () => {
    const own = source({
      from: addr("owner@example.org", "Owner"),
      to: [addr("bob@example.com", "Bob"), addr("carl@example.com")],
      cc: [addr("dora@example.com")],
    });
    expect(replyRecipients(own, "reply", OWN)).toEqual({
      to: [addr("bob@example.com", "Bob"), addr("carl@example.com")],
      cc: [],
      dropped: [],
    });
  });

  it("recognises one's own message by any account address, in any case", () => {
    const own = source({
      from: addr("OWNER.work@EXAMPLE.com"),
      to: [addr("bob@example.com")],
    });
    expect(replyRecipients(own, "reply", OWN).to).toEqual([addr("bob@example.com")]);
  });

  it("dedupes the reply target", () => {
    const result = replyRecipients(
      source({ replyTo: [addr("list@example.net"), addr("LIST@example.net", "Again")] }),
      "reply",
      OWN,
    );
    expect(result.to).toEqual([addr("list@example.net")]);
  });

  it("punycodes a target domain and drops an address that cannot be sent to", () => {
    const result = replyRecipients(
      source({ replyTo: [addr("anna@bücher.example"), addr("not an address"), addr("")] }),
      "reply",
      OWN,
    );
    expect(result.to).toEqual([addr("anna@xn--bcher-kva.example")]);
    expect(result.dropped).toEqual(["not an address"]);
  });

  it("falls back to From when every Reply-To address is unusable, and says which were dropped", () => {
    const result = replyRecipients(
      source({ replyTo: [addr("broken@"), addr("BROKEN@")] }),
      "reply",
      OWN,
    );
    expect(result).toEqual({
      to: [addr("anna@example.org", "Anna Lind")],
      cc: [],
      dropped: ["broken@"],
    });
  });

  it("lists unusable To and Cc addresses of a Reply all", () => {
    const result = replyRecipients(
      source({ to: [addr("bob@example.com"), addr("x@@example.com")], cc: [addr("nobody")] }),
      "reply_all",
      OWN,
    );
    expect(result.to).toEqual([addr("anna@example.org", "Anna Lind"), addr("bob@example.com")]);
    expect(result.cc).toEqual([]);
    expect(result.dropped).toEqual(["x@@example.com", "nobody"]);
  });

  it("keeps a display name but never a line break in it", () => {
    const result = replyRecipients(
      source({ from: addr("anna@example.org", "Anna\r\nBcc: eve@example.net") }),
      "reply",
      OWN,
    );
    expect(result.to).toEqual([addr("anna@example.org", "Anna Bcc: eve@example.net")]);
  });
});

describe("replyRecipients: Reply all", () => {
  it("adds the original To and keeps the original Cc", () => {
    const result = replyRecipients(
      source({
        to: [addr("owner@example.org"), addr("bob@example.com", "Bob")],
        cc: [addr("carl@example.com")],
      }),
      "reply_all",
      OWN,
    );
    expect(result).toEqual({
      to: [addr("anna@example.org", "Anna Lind"), addr("bob@example.com", "Bob")],
      cc: [addr("carl@example.com")],
      dropped: [],
    });
  });

  it("uses Reply-To instead of From as the target", () => {
    const result = replyRecipients(
      source({ replyTo: [addr("list@example.net")], to: [addr("bob@example.com")] }),
      "reply_all",
      OWN,
    );
    expect(result.to).toEqual([addr("list@example.net"), addr("bob@example.com")]);
  });

  it("removes every account's own addresses from To and Cc, in any case", () => {
    const result = replyRecipients(
      source({
        to: [addr("OWNER@example.org"), addr("bob@example.com")],
        cc: [addr("owner.work@example.com"), addr("carl@example.com"), addr("Owner@Example.org")],
      }),
      "reply_all",
      OWN,
    );
    expect(result).toEqual({
      to: [addr("anna@example.org", "Anna Lind"), addr("bob@example.com")],
      cc: [addr("carl@example.com")],
      dropped: [],
    });
  });

  it("dedupes across To and Cc", () => {
    const result = replyRecipients(
      source({
        to: [addr("bob@example.com"), addr("ANNA@example.org")],
        cc: [addr("Bob@Example.com"), addr("carl@example.com"), addr("carl@example.com")],
      }),
      "reply_all",
      OWN,
    );
    expect(result).toEqual({
      to: [addr("anna@example.org", "Anna Lind"), addr("bob@example.com")],
      cc: [addr("carl@example.com")],
      dropped: [],
    });
  });

  it("moves Cc into To when To ends up empty", () => {
    const result = replyRecipients(
      source({
        from: addr("owner@example.org"),
        to: [addr("owner.work@example.com")],
        cc: [addr("carl@example.com")],
      }),
      "reply_all",
      OWN,
    );
    expect(result).toEqual({ to: [addr("carl@example.com")], cc: [], dropped: [] });
  });

  it("replies to all of one's own sent message: its To and Cc, own addresses removed", () => {
    const sent = source({
      from: addr("owner@example.org"),
      to: [addr("bob@example.com"), addr("owner.work@example.com")],
      cc: [addr("carl@example.com")],
    });
    expect(replyRecipients(sent, "reply_all", OWN)).toEqual({
      to: [addr("bob@example.com")],
      cc: [addr("carl@example.com")],
      dropped: [],
    });
  });

  it("never carries a Bcc (the source has none to carry)", () => {
    const result = replyRecipients(source(), "reply_all", OWN);
    expect(Object.keys(result).sort()).toEqual(["cc", "dropped", "to"]);
  });
});

describe("threadingHeaders", () => {
  it("points at the original and appends it to References", () => {
    expect(
      threadingHeaders(source({ references: ["<a@example.org>", "<b@example.org>"] })),
    ).toEqual({
      inReplyTo: "<m1@example.org>",
      references: ["<a@example.org>", "<b@example.org>", "<m1@example.org>"],
    });
  });

  it("falls back to In-Reply-To when References is empty", () => {
    expect(threadingHeaders(source({ inReplyTo: "<p@example.org>" }))).toEqual({
      inReplyTo: "<m1@example.org>",
      references: ["<p@example.org>", "<m1@example.org>"],
    });
  });

  it("brackets bare ids and dedupes", () => {
    expect(
      threadingHeaders(
        source({ messageId: "m1@example.org", references: ["a@example.org", "<a@example.org>"] }),
      ),
    ).toEqual({
      inReplyTo: "<m1@example.org>",
      references: ["<a@example.org>", "<m1@example.org>"],
    });
  });

  it("keeps the first id plus the last 20", () => {
    const refs = Array.from({ length: 30 }, (_, i) => `<r${i}@example.org>`);
    const result = threadingHeaders(source({ references: refs }));
    expect(result.references).toHaveLength(21);
    expect(result.references[0]).toBe("<r0@example.org>");
    expect(result.references[1]).toBe("<r11@example.org>");
    expect(result.references.at(-1)).toBe("<m1@example.org>");
  });

  it("sets nothing for a message without a Message-ID, and drops unusable ids", () => {
    expect(
      threadingHeaders(
        source({ messageId: null, references: ["<a b@example.org>", "<x\r\n@example.org>", "<>"] }),
      ),
    ).toEqual({ inReplyTo: null, references: [] });
  });
});

describe("quoteHeaderText", () => {
  it("writes the reply attribution line", () => {
    expect(quoteHeaderText(source(), "reply")).toEqual([
      "On 14 Nov 2026 09:05 UTC, Anna Lind <anna@example.org> wrote:",
    ]);
    expect(quoteHeaderText(source({ from: addr("anna@example.org") }), "reply_all")).toEqual([
      "On 14 Nov 2026 09:05 UTC, anna@example.org wrote:",
    ]);
    expect(quoteHeaderText(source({ date: null }), "reply")).toEqual([
      "Anna Lind <anna@example.org> wrote:",
    ]);
  });

  it("writes the forwarded-message block", () => {
    expect(
      quoteHeaderText(
        source({ cc: [addr("carl@example.com", "Carl")], to: [addr("owner@example.org"), addr("bob@example.com")] }),
        "forward",
      ),
    ).toEqual([
      "---------- Forwarded message ----------",
      "From: Anna Lind <anna@example.org>",
      "Date: 14 Nov 2026 09:05 UTC",
      "Subject: Garden plans",
      "To: owner@example.org, bob@example.com",
      "Cc: Carl <carl@example.com>",
    ]);
  });

  it("leaves out an empty Cc and keeps control characters out", () => {
    const lines = quoteHeaderText(
      source({ subject: "Garden\r\nplans", date: "not a date" }),
      "forward",
    );
    expect(lines).toEqual([
      "---------- Forwarded message ----------",
      "From: Anna Lind <anna@example.org>",
      "Subject: Garden plans",
      "To: owner@example.org",
    ]);
  });
});
