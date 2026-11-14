import { describe, expect, it } from "vitest";
import { parseQuery } from "./search.ts";

describe("parseQuery", () => {
  it("parses from, subject, is:unread, after, before and free text", () => {
    expect(
      parseQuery(
        "invoice from:billing@example.org subject:march is:unread after:2026-01-02 before:2026-03-04 paid",
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
    expect(parseQuery('subject:"weekly report" from:"Invented Sender" notes')).toEqual({
      text: "notes",
      subject: "weekly report",
      from: "Invented Sender",
    });
  });

  it("ignores an invalid date as text", () => {
    expect(parseQuery("after:2026-02-30 before:yesterday hello")).toEqual({
      text: "after:2026-02-30 before:yesterday hello",
    });
  });

  it("returns plain text for a query without operators", () => {
    expect(parseQuery("  just   words ")).toEqual({ text: "just words" });
  });

  it("keeps unknown operators and empty values as text", () => {
    expect(parseQuery("is:starred from: label:x")).toEqual({ text: "is:starred from: label:x" });
  });

  it("matches operator names case-insensitively", () => {
    expect(parseQuery("FROM:a@example.org IS:UNREAD")).toEqual({
      text: "",
      from: "a@example.org",
      unread: true,
    });
  });
});
