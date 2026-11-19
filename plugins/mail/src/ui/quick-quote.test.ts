// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { selectedQuote } from "./quick-quote.ts";

afterEach(() => {
  document.body.innerHTML = "";
  document.getSelection()?.removeAllRanges();
});

function page() {
  document.body.innerHTML = `
    <article data-message-id="m-1"><p id="a">First message says hello there.</p></article>
    <article data-message-id="m-2"><p id="b">Second message says goodbye.</p></article>`;
}

function select(startId: string, start: number, endId: string, end: number) {
  const range = document.createRange();
  range.setStart(document.getElementById(startId)!.firstChild!, start);
  range.setEnd(document.getElementById(endId)!.firstChild!, end);
  const selection = document.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
}

describe("selectedQuote", () => {
  it("returns the text selected inside the message", () => {
    page();
    select("a", 6, "a", 30);
    expect(selectedQuote(document, "m-1")).toBe("message says hello there");
  });

  it("returns nothing for another message, for a selection across two messages, or for none", () => {
    page();
    select("a", 6, "a", 13);
    expect(selectedQuote(document, "m-2")).toBeNull();
    select("a", 6, "b", 6);
    expect(selectedQuote(document, "m-1")).toBeNull();
    expect(selectedQuote(document, "m-2")).toBeNull();
    document.getSelection()!.removeAllRanges();
    expect(selectedQuote(document, "m-1")).toBeNull();
    expect(selectedQuote(document, "m-9")).toBeNull();
  });

  it("returns nothing for white space only, and cuts a very long selection at 20 000 characters", () => {
    document.body.innerHTML = `<article data-message-id="m-1"><p id="a">   </p><p id="c">${"x".repeat(20_500)}</p></article>`;
    select("a", 0, "a", 3);
    expect(selectedQuote(document, "m-1")).toBeNull();
    select("c", 0, "c", 20_500);
    expect(selectedQuote(document, "m-1")).toHaveLength(20_000);
  });

  it("ignores a selection in the message's header, and forgets a frame's selection once it was used", () => {
    document.body.innerHTML = `<article data-message-id="m-1"><button data-mail-message-toggle=""><span id="h">Ada Lovelace</span></button><iframe></iframe></article>`;
    select("h", 0, "h", 3);
    expect(selectedQuote(document, "m-1")).toBeNull();
    document.getSelection()!.removeAllRanges();
    const inner = document.querySelector("iframe")!.contentDocument!;
    inner.body.innerHTML = `<p id="x">Inside the frame text.</p>`;
    const range = inner.createRange();
    range.setStart(inner.getElementById("x")!.firstChild!, 0);
    range.setEnd(inner.getElementById("x")!.firstChild!, 6);
    inner.getSelection()!.addRange(range);
    expect(selectedQuote(document, "m-1")).toBe("Inside");
    expect(selectedQuote(document, "m-1")).toBeNull();
  });

  it("reads the selection of the message's own frame", () => {
    document.body.innerHTML = `<article data-message-id="m-1"><iframe></iframe></article>`;
    const frame = document.querySelector("iframe")!;
    const inner = frame.contentDocument!;
    inner.body.innerHTML = `<p id="x">Inside the frame text.</p>`;
    const range = inner.createRange();
    range.setStart(inner.getElementById("x")!.firstChild!, 7);
    range.setEnd(inner.getElementById("x")!.firstChild!, 16);
    inner.getSelection()!.addRange(range);
    expect(selectedQuote(document, "m-1")).toBe("the frame");
  });
});
