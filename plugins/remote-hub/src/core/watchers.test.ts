import { describe, expect, it } from "vitest";
import { WATCH_TTL_MS, WatcherBook } from "./watchers.ts";

function setup() {
  let now = 1_000_000;
  const changes: string[] = [];
  const book = new WatcherBook({ now: () => now });
  book.onChange((key, watching) => changes.push(`${key}:${watching}`));
  return { book, changes, advance: (ms: number) => void (now += ms) };
}

describe("watchers: who is looking at a session's live view", () => {
  it("nobody watches until a visible view reports in", () => {
    const { book } = setup();
    expect(book.watching("g.1")).toBe(false);
    book.beat("g.1", "view-a", true);
    expect(book.watching("g.1")).toBe(true);
    expect(book.watching("g.2")).toBe(false);
  });

  it("a hidden tab does not count, and becoming visible again does", () => {
    const { book } = setup();
    book.beat("g.1", "a", false);
    expect(book.watching("g.1")).toBe(false);
    book.beat("g.1", "a", true);
    expect(book.watching("g.1")).toBe(true);
    book.beat("g.1", "a", false);
    expect(book.watching("g.1")).toBe(false);
  });

  it("a stale heartbeat is not watching: exactly at the limit still counts, one millisecond past does not", () => {
    const { book, advance } = setup();
    book.beat("g.1", "a", true);
    advance(WATCH_TTL_MS);
    expect(book.watching("g.1")).toBe(true);
    advance(1);
    expect(book.watching("g.1")).toBe(false);
  });

  it("D3: a report arriving after the previous one had expired first records the loss, then the gain, before any sweep", () => {
    let now = 1000;
    const book = new WatcherBook({ now: () => now });
    const heard: boolean[] = [];
    book.beat("s", "v", true);
    book.onChange((_k, w) => heard.push(w));
    now += WATCH_TTL_MS + 1; // expired, and no sweep has run
    book.beat("s", "v", true);
    expect(heard).toEqual([false, true]);
    expect(book.watching("s")).toBe(true);
    // A report that is still fresh when the next arrives is no change at all.
    now += 1000;
    book.beat("s", "v", true);
    expect(heard).toEqual([false, true]);
  });

  it("several views: the session is watched while any one of them is visible and fresh", () => {
    const { book, advance } = setup();
    book.beat("g.1", "a", true);
    advance(WATCH_TTL_MS - 1000);
    book.beat("g.1", "b", true);
    advance(2000); // a is stale now, b is not
    expect(book.watching("g.1")).toBe(true);
    book.remove("b");
    expect(book.watching("g.1")).toBe(false);
  });

  it("reports only the transitions: first watcher, last watcher gone (closed, hidden or stale), watcher back", () => {
    const { book, changes, advance } = setup();
    book.beat("g.1", "a", true);
    book.beat("g.1", "a", true);
    book.beat("g.1", "b", true);
    expect(changes).toEqual(["g.1:true"]);
    book.remove("a");
    expect(changes).toEqual(["g.1:true"]);
    book.remove("b");
    expect(changes).toEqual(["g.1:true", "g.1:false"]);
    book.beat("g.1", "c", true);
    advance(WATCH_TTL_MS + 1);
    book.sweep();
    expect(changes).toEqual(["g.1:true", "g.1:false", "g.1:true", "g.1:false"]);
    book.sweep();
    expect(changes).toHaveLength(4);
  });

  it("forgetting a session drops its views and reports it as no longer watched", () => {
    const { book, changes } = setup();
    book.beat("g.1", "a", true);
    book.forgetSession("g.1");
    expect(book.watching("g.1")).toBe(false);
    expect(changes).toEqual(["g.1:true", "g.1:false"]);
  });

  it("the number of views per session is bounded", () => {
    const { book } = setup();
    for (let i = 0; i < 40; i++) book.beat("g.1", `v${i}`, true);
    expect(book.viewCount("g.1")).toBeLessThanOrEqual(16);
  });
});
