import { describe, expect, it } from "vitest";
import { quoteRanges } from "./quotes.ts";

/** The hidden text of each range. */
const hidden = (text: string) => quoteRanges(text).map((r) => text.slice(r.start, r.end));

describe("quoteRanges", () => {
  it("hides an English attribution and the quote under it", () => {
    const text = "Thanks, invented reply.\n\nOn Mon, 1 Jan 2026, A <a@example.org> wrote:\n> old line\n> more\n";
    expect(hidden(text)).toEqual(["On Mon, 1 Jan 2026, A <a@example.org> wrote:\n> old line\n> more\n"]);
  });

  it("hides a wrapped two-line attribution", () => {
    const text = "Reply.\nOn Mon, 1 Jan 2026 at 10:00, Invented Person\n<a@example.org> wrote:\n> quoted\n";
    expect(hidden(text)).toEqual(["On Mon, 1 Jan 2026 at 10:00, Invented Person\n<a@example.org> wrote:\n> quoted\n"]);
  });

  it("hides a Russian attribution", () => {
    const text =
      "\u041e\u0442\u0432\u0435\u0442.\n" +
      "1 \u044f\u043d\u0432. 2026, \u0418\u0432\u0430\u043d \u043d\u0430\u043f\u0438\u0441\u0430\u043b:\n> \u0441\u0442\u0430\u0440\u043e\u0435\n";
    expect(hidden(text)).toEqual([
      "1 \u044f\u043d\u0432. 2026, \u0418\u0432\u0430\u043d \u043d\u0430\u043f\u0438\u0441\u0430\u043b:\n> \u0441\u0442\u0430\u0440\u043e\u0435\n",
    ]);
  });

  it("hides runs of > lines without an attribution, keeping text between them", () => {
    const text = "> a\n> b\nmy answer\n> c\nend";
    expect(hidden(text)).toEqual(["> a\n> b\n", "> c\n"]);
  });

  it("merges quote runs separated only by blank lines", () => {
    const text = "top\n> a\n\n> b\n";
    expect(hidden(text)).toEqual(["> a\n\n> b\n"]);
  });

  it("hides Outlook's Original Message block to the end", () => {
    const text = "New text.\n\n-----Original Message-----\nFrom: A\nSent: Monday\nSubject: x\n\nold body\n";
    expect(hidden(text)).toEqual(["-----Original Message-----\nFrom: A\nSent: Monday\nSubject: x\n\nold body\n"]);
  });

  it("hides Outlook's From / Sent header block to the end", () => {
    const text = "New text.\n\nFrom: Invented Person <a@example.org>\nSent: Monday, 1 January 2026\nTo: b@example.org\nSubject: x\n\nold\n";
    expect(hidden(text)).toEqual([
      "From: Invented Person <a@example.org>\nSent: Monday, 1 January 2026\nTo: b@example.org\nSubject: x\n\nold\n",
    ]);
  });

  it("keeps a From: line without a Sent: line", () => {
    expect(quoteRanges("From: the team\nWelcome aboard.\n")).toEqual([]);
  });

  it("handles CRLF line ends", () => {
    const text = "Reply.\r\n> old\r\n";
    expect(hidden(text)).toEqual(["> old\r\n"]);
  });

  it("hides nothing when everything would be hidden", () => {
    expect(quoteRanges("> a\n> b\n")).toEqual([]);
    expect(quoteRanges("On Mon, A wrote:\n> a\n")).toEqual([]);
    expect(quoteRanges("\n-----Original Message-----\nFrom: A\n")).toEqual([]);
  });

  it("returns nothing for text without quotes", () => {
    expect(quoteRanges("plain invented text\nsecond line")).toEqual([]);
    expect(quoteRanges("")).toEqual([]);
  });
});
