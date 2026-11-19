import { describe, expect, it } from "vitest";
import type { ParsedQuery } from "./model.ts";
import { SEARCH_VALUE_MAX, parseQuery } from "./search.ts";

/** The fields older callers read (every case below predates slice 3h). */
function legacy(query: ParsedQuery): Omit<ParsedQuery, "conditions" | "notes"> {
  const { conditions: _conditions, notes: _notes, ...rest } = query;
  return rest;
}

const NOW = new Date("2026-11-16T12:00:00.000Z");

describe("parseQuery", () => {
  it("parses from, subject, is:unread, after, before and free text", () => {
    expect(
      legacy(
        parseQuery(
          "invoice from:billing@example.org subject:march is:unread after:2026-01-02 before:2026-03-04 paid",
        ),
      ),
    ).toEqual({
      text: "invoice paid",
      from: "billing@example.org",
      subject: "march",
      unread: true,
      after: "2026-01-02",
      before: "2026-03-04",
    });
  });

  it("keeps quoted values", () => {
    expect(legacy(parseQuery('subject:"weekly report" from:"Invented Sender" notes'))).toEqual({
      text: "notes",
      subject: "weekly report",
      from: "Invented Sender",
    });
  });

  it("ignores an invalid date as text", () => {
    const parsed = parseQuery("after:2026-02-30 before:yesterday hello");
    expect(legacy(parsed)).toEqual({ text: "after:2026-02-30 before:yesterday hello" });
    expect(parsed.notes).toEqual([
      { kind: "bad_value", term: "after:2026-02-30" },
      { kind: "bad_value", term: "before:yesterday" },
    ]);
  });

  it("returns plain text for a query without operators", () => {
    expect(parseQuery("  just   words ")).toEqual({ text: "just words", conditions: [], notes: [] });
  });

  it("keeps unknown operators, bad values and empty values as text", () => {
    // Slice 3h: is:starred and label: are operators now.
    const parsed = parseQuery("is:bogus from: zz:x");
    expect(legacy(parsed)).toEqual({ text: "is:bogus from: zz:x" });
    expect(parsed.conditions).toEqual([]);
    expect(parsed.notes).toEqual([
      { kind: "bad_value", term: "is:bogus" },
      { kind: "unknown_operator", term: "zz:x" },
    ]);
  });

  it("splits on any Unicode whitespace", () => {
    expect(legacy(parseQuery("from:a@example.org\u00a0is:unread\u3000hello"))).toEqual({
      text: "hello",
      from: "a@example.org",
      unread: true,
    });
    expect(legacy(parseQuery("has:attachments\u2003filename:pdf\u00a0notes"))).toEqual({ text: "notes" });
  });

  it("matches operator names case-insensitively", () => {
    expect(legacy(parseQuery("FROM:a@example.org IS:UNREAD"))).toEqual({
      text: "",
      from: "a@example.org",
      unread: true,
    });
  });
});

describe("parseQuery: slice 3h operators", () => {
  const cond = (raw: string, now?: Date) => parseQuery(raw, now).conditions;

  it("reads every operator", () => {
    expect(
      cond(
        "from:a@example.org to:b@example.org cc:c@example.org subject:plan has:attachment filename:pdf " +
          "in:trash account:me@example.org is:starred larger:10K smaller:2M after:2026-01-01 before:2026/02/01 " +
          "list:dev.example.org category:bills label:Receipts",
      ),
    ).toEqual([
      { field: "from", value: "a@example.org", negated: false },
      { field: "to", value: "b@example.org", negated: false },
      { field: "cc", value: "c@example.org", negated: false },
      { field: "subject", value: "plan", negated: false },
      { field: "has", value: "attachment", negated: false },
      { field: "filename", value: "pdf", negated: false },
      { field: "in", value: "trash", negated: false },
      { field: "account", value: "me@example.org", negated: false },
      { field: "is", value: "flagged", negated: false },
      { field: "larger", value: "10240", negated: false },
      { field: "smaller", value: "2097152", negated: false },
      { field: "after", value: "2026-01-01", negated: false },
      { field: "before", value: "2026-02-01", negated: false },
      { field: "list", value: "dev.example.org", negated: false },
      { field: "category", value: "bills", negated: false },
      { field: "label", value: "Receipts", negated: false },
    ]);
  });

  it("normalizes is: and has: values", () => {
    expect(cond("is:read is:unflagged is:flagged is:unread has:attachments")).toEqual([
      { field: "is", value: "unread", negated: true },
      { field: "is", value: "flagged", negated: true },
      { field: "is", value: "flagged", negated: false },
      { field: "is", value: "unread", negated: false },
      { field: "has", value: "attachment", negated: false },
    ]);
    expect(legacy(parseQuery("-is:read"))).toEqual({ text: "", unread: true });
    expect(legacy(parseQuery("is:read"))).toEqual({ text: "", unread: false });
  });

  it("turns relative dates into after and before against the clock", () => {
    expect(cond("newer_than:3m older_than:1y newer_than:10d older_than:2w", NOW)).toEqual([
      { field: "after", value: "2026-08-16", negated: false },
      { field: "before", value: "2025-11-16", negated: false },
      { field: "after", value: "2026-11-06", negated: false },
      { field: "before", value: "2026-11-02", negated: false },
    ]);
    expect(legacy(parseQuery("newer_than:3m", NOW))).toEqual({ text: "", after: "2026-08-16" });
  });

  it("keeps relative dates as text without a clock", () => {
    const parsed = parseQuery("newer_than:3m");
    expect(parsed.text).toBe("newer_than:3m");
    expect(parsed.conditions).toEqual([]);
  });

  it("flags a bad relative date", () => {
    expect(parseQuery("newer_than:3x", NOW).notes).toEqual([{ kind: "bad_value", term: "newer_than:3x" }]);
  });

  it("flags a relative date before 1970", () => {
    const parsed = parseQuery("older_than:9999y invoice", NOW);
    expect(parsed.notes).toEqual([{ kind: "bad_value", term: "older_than:9999y" }]);
    expect(parsed.conditions.filter((c) => c.field === "before")).toEqual([]);
    expect(parseQuery("older_than:57y", NOW).notes).toEqual([{ kind: "bad_value", term: "older_than:57y" }]);
    expect(parseQuery("older_than:9999w", NOW).notes).toEqual([{ kind: "bad_value", term: "older_than:9999w" }]);
    expect(cond("older_than:56y", new Date("2026-12-31T12:00:00.000Z"))).toEqual([{ field: "before", value: "1970-12-31", negated: false }]);
  });

  it("clamps the day when months are subtracted", () => {
    expect(cond("newer_than:1m", new Date("2026-03-31T12:00:00.000Z"))).toEqual([{ field: "after", value: "2026-02-28", negated: false }]);
    expect(cond("newer_than:1m", new Date("2028-03-31T12:00:00.000Z"))).toEqual([{ field: "after", value: "2028-02-29", negated: false }]);
    expect(cond("newer_than:13m", new Date("2026-05-31T12:00:00.000Z"))).toEqual([{ field: "after", value: "2025-04-30", negated: false }]);
    expect(cond("older_than:1y", new Date("2028-02-29T12:00:00.000Z"))).toEqual([{ field: "before", value: "2027-02-28", negated: false }]);
  });

  it("negates any operator with a leading minus", () => {
    const parsed = parseQuery("-in:trash -from:a@example.org -has:attachment", NOW);
    expect(parsed.conditions).toEqual([
      { field: "in", value: "trash", negated: true },
      { field: "from", value: "a@example.org", negated: true },
      { field: "has", value: "attachment", negated: true },
    ]);
    // A negated operator never fills the older fields.
    expect(legacy(parsed)).toEqual({ text: "" });
  });

  it("keeps a bare -word and a lone minus as text", () => {
    expect(parseQuery("-word - plan")).toEqual({ text: "-word - plan", conditions: [], notes: [] });
  });

  it("keeps an unknown negated operator as text with a note", () => {
    expect(parseQuery("-bogus:x")).toEqual({
      text: "-bogus:x",
      conditions: [],
      notes: [{ kind: "unknown_operator", term: "-bogus:x" }],
    });
  });

  it("does not read a link as an operator", () => {
    expect(parseQuery("https://example.org/a")).toEqual({ text: "https://example.org/a", conditions: [], notes: [] });
  });

  it("reads quoted values, also negated", () => {
    expect(cond('-subject:"weekly report" label:"My Label"')).toEqual([
      { field: "subject", value: "weekly report", negated: true },
      { field: "label", value: "My Label", negated: false },
    ]);
  });

  it("collects repeated in: and account: for an OR", () => {
    expect(cond("in:inbox in:Spam in:Work/Projects account:a@example.org account:b@example.org")).toEqual([
      { field: "in", value: "inbox", negated: false },
      { field: "in", value: "junk", negated: false },
      { field: "in", value: "Work/Projects", negated: false },
      { field: "account", value: "a@example.org", negated: false },
      { field: "account", value: "b@example.org", negated: false },
    ]);
  });

  it("reads sizes in bytes, K and M, caps them at 2 GB and refuses others", () => {
    expect(cond("larger:500 smaller:1.5M larger:10k")).toEqual([
      { field: "larger", value: "500", negated: false },
      { field: "smaller", value: "1572864", negated: false },
      { field: "larger", value: "10240", negated: false },
    ]);
    expect(cond("larger:999999999M")).toEqual([{ field: "larger", value: String(2 * 1024 ** 3), negated: false }]);
    const bad = parseQuery("larger:abc smaller:10G");
    expect(bad.conditions).toEqual([]);
    expect(bad.notes).toEqual([
      { kind: "bad_value", term: "larger:abc" },
      { kind: "bad_value", term: "smaller:10G" },
    ]);
  });

  it("refuses a has: value other than attachment", () => {
    const parsed = parseQuery("has:pdf");
    expect(parsed.conditions).toEqual([]);
    expect(parsed.notes).toEqual([{ kind: "bad_value", term: "has:pdf" }]);
  });

  it("cuts values to 200 characters and removes control characters", () => {
    const long = "a".repeat(250);
    expect(cond(`subject:${long}`)).toEqual([{ field: "subject", value: "a".repeat(SEARCH_VALUE_MAX), negated: false }]);
    expect(cond('subject:"we\u0000ek\u0007ly\u009f"')).toEqual([{ field: "subject", value: "weekly", negated: false }]);
    expect(SEARCH_VALUE_MAX).toBe(200);
  });

  it("drops a value that is empty once control characters are gone", () => {
    expect(cond("subject:\u0001\u0002")).toEqual([]);
  });

  it("keeps the last positive from: and subject: in the older fields", () => {
    expect(legacy(parseQuery("from:a@example.org from:b@example.org -subject:x subject:y"))).toEqual({
      text: "",
      from: "b@example.org",
      subject: "y",
    });
  });
});

describe("parseQuery: operators for Inbox tabs", () => {
  const cond = (raw: string) => parseQuery(raw).conditions;

  it("reads the sender sets, dev, automated and invite, and their negations", () => {
    expect(cond("from:vip from:Team from:KNOWN is:dev is:automated has:invite")).toEqual([
      { field: "sender", value: "vip", negated: false },
      { field: "sender", value: "team", negated: false },
      { field: "sender", value: "known", negated: false },
      { field: "is", value: "dev", negated: false },
      { field: "is", value: "automated", negated: false },
      { field: "has", value: "invite", negated: false },
    ]);
    expect(cond("-from:vip -is:dev -has:invite")).toEqual([
      { field: "sender", value: "vip", negated: true },
      { field: "is", value: "dev", negated: true },
      { field: "has", value: "invite", negated: true },
    ]);
  });

  it("keeps an address that only contains such a word as an ordinary sender", () => {
    expect(cond("from:vipclient@example.com from:team@example.org")).toEqual([
      { field: "from", value: "vipclient@example.com", negated: false },
      { field: "from", value: "team@example.org", negated: false },
    ]);
  });

  it("notes a value that is none of them", () => {
    expect(parseQuery("is:devops has:invites").notes).toEqual([
      { kind: "bad_value", term: "is:devops" },
      { kind: "bad_value", term: "has:invites" },
    ]);
  });
});
