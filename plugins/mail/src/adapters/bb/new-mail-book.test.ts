import { describe, expect, it } from "vitest";
import { NEW_MAIL_BOOK_SIZE, NEW_MAIL_TTL_MS, NewMailBook } from "./new-mail-book.ts";

function setup() {
  let now = Date.parse("2026-11-16T10:00:00.000Z");
  let counter = 0;
  const book = new NewMailBook({ now: () => new Date(now) }, () => `token-${++counter}`);
  return { book, advance: (ms: number) => (now += ms) };
}

describe("NewMailBook", () => {
  it("returns the ids of a live token and null for an unknown one", () => {
    const { book } = setup();
    const token = book.put(["msg_1", "msg_2"]);
    expect(book.get(token)).toEqual(["msg_1", "msg_2"]);
    expect(book.get("token-unknown")).toBeNull();
  });

  it("forgets a token after ten minutes", () => {
    const { book, advance } = setup();
    const token = book.put(["msg_1"]);
    advance(NEW_MAIL_TTL_MS - 1);
    expect(book.get(token)).toEqual(["msg_1"]);
    advance(1);
    expect(book.get(token)).toBeNull();
  });

  it("keeps at most 20 entries, dropping the oldest", () => {
    const { book } = setup();
    const tokens = Array.from({ length: NEW_MAIL_BOOK_SIZE + 1 }, (_, i) => book.put([`msg_${i}`]));
    expect(book.get(tokens[0]!)).toBeNull();
    expect(book.get(tokens[1]!)).toEqual(["msg_1"]);
    expect(book.get(tokens[NEW_MAIL_BOOK_SIZE]!)).toEqual([`msg_${NEW_MAIL_BOOK_SIZE}`]);
  });

  it("never reuses a live token and hands out copies", () => {
    let calls = 0;
    const book = new NewMailBook({ now: () => new Date() }, () => (calls++ < 2 ? "same" : `t${calls}`));
    const first = book.put(["a"]);
    const second = book.put(["b"]);
    expect(first).not.toBe(second);
    book.get(first)?.push("x");
    expect(book.get(first)).toEqual(["a"]);
  });
});
