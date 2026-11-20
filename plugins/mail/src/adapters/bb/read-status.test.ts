import { beforeEach, describe, expect, it } from "vitest";
import { FixedClock, InMemoryMailStore, makeFetchedMessage, makeStoredAccount } from "../../core/testing/fakes.ts";
import { createReadStatus, signedToken, type ReadStatusSettings } from "./read-status.ts";

const TRACK = "track-key-for-tests-0123456789abcdef";
const FEED = "feed-key-for-tests-0123456789abcdefg";
let store: InMemoryMailStore;
let clock: FixedClock;
const advance = (ms: number) => clock.set(new Date(clock.now().getTime() + ms));
let settings: ReadStatusSettings;
let asked: { url: string; auth: string | undefined }[];
let answers: ({ status: number; body: unknown } | Error)[];
let lines: string[];
let last: number;
const EPOCH = "epoch-one-0001";
const SCOPE = `https://makosh.example.org ${EPOCH}`;
let status: ReturnType<typeof createReadStatus>;

beforeEach(() => {
  store = new InMemoryMailStore();
  clock = new FixedClock(new Date("2026-11-20T10:00:00.000Z"));
  settings = { on: true, origin: "https://makosh.example.org", trackKey: TRACK, feedKey: FEED, exceptions: "" };
  asked = [];
  answers = [];
  lines = [];
  last = 0;
  status = createReadStatus({
    store,
    clock,
    settings: () => settings,
    newId: () => "abcdefghijklmnop",
    log: (line) => lines.push(line),
    fetch: async (url, init) => {
      asked.push({ url, auth: init.headers.Authorization });
      const cursor = store.openFeed().cursor;
      const next = answers.shift() ?? { status: 200, body: { events: [], next: cursor, epoch: EPOCH, last: Math.max(cursor, last) } };
      if (next instanceof Error) throw next;
      return { status: next.status, text: async () => (typeof next.body === "string" ? next.body : JSON.stringify(next.body)) };
    },
  });
});

describe("read statuses: the host side", () => {
  it("signs a token as the endpoint checks it and builds the image address", () => {
    // HMAC-SHA256("test-key", "abcdefghijklmnop"), base64url, first 16: checked with openssl.
    expect(signedToken("test-key", "abcdefghijklmnop")).toBe("abcdefghijklmnop.Nf8gINmCVZOx9whO");
    const issued = status.issue()!;
    expect(issued.token).toBe(signedToken(TRACK, "abcdefghijklmnop"));
    expect(issued.html).toContain(`src="https://makosh.example.org/o/${issued.token}.gif"`);
  });

  it("issues nothing when off, without both keys, or with an address that is not a plain https origin", () => {
    for (const change of [{ on: false }, { trackKey: "short" }, { feedKey: "" }, { origin: "http://makosh.example.org" }, { origin: "https://x.example.org/a" }]) {
      settings = { on: true, origin: "https://makosh.example.org", trackKey: TRACK, feedKey: FEED, exceptions: "", ...change };
      expect(status.issue(), JSON.stringify(change)).toBeNull();
      expect(status.ready()).toBe(false);
    }
  });

  it("polls past what was read, keeps opens of our tokens, shows them under the message, and waits five minutes", async () => {
    store.saveAccount(makeStoredAccount());
    store.upsertMessages("acc_1", "Sent", [makeFetchedMessage(1)]);
    const id = store.localFolderIndex("acc_1", "Sent", "1970-01-01T00:00:00.000Z")[0]!.id;
    const token = status.issue()!.token;
    store.saveSentTracking({ token, accountId: "acc_1", rfcMessageId: "<msg-1@example.org>", createdAt: "2026-11-20T09:00:00.000Z" });
    expect(status.withMessages([{ id }])).toEqual([{ id, opens: { count: 0, lastAt: null } }]);
    store.resetOpenFeed(SCOPE);
    answers.push({
      status: 200,
      body: { events: [{ seq: 7, token, at: "2026-11-20T09:30:00Z", kind: "mobile" }, { seq: 8, token: "zzzzzzzzzzzzzzzz.Nf8gINmCVZOx9whO", at: "2026-11-20T09:31:00Z", kind: "desktop" }], next: 8, epoch: EPOCH, last: 8 },
    });
    last = 8;
    expect(await status.poll()).toBe(1);
    expect(asked).toEqual([
      { url: "https://makosh.example.org/api/events?after=0&limit=500", auth: `Bearer ${FEED}` },
      { url: "https://makosh.example.org/api/events?after=8&limit=500", auth: `Bearer ${FEED}` },
    ]);
    expect(store.openFeed()).toEqual({ scope: SCOPE, cursor: 8 });
    expect(status.withMessages([{ id }, { id: "other" }])).toEqual([{ id, opens: { count: 1, lastAt: "2026-11-20T09:30:00.000Z" } }, { id: "other" }]);
    advance(4 * 60_000);
    expect(await status.poll()).toBe(0);
    expect(asked).toHaveLength(2);
    advance(60_000);
    await status.poll();
    expect(asked).toHaveLength(3);
  });

  it("the first poll ever notes which feed it reads and then reads it", async () => {
    await status.poll();
    expect(asked.map((ask) => ask.url.split("?")[1])).toEqual(["after=0&limit=500", "after=0&limit=500"]);
    expect(store.openFeed()).toEqual({ scope: SCOPE, cursor: 0 });
  });

  it("a refusal, a broken answer or a network failure is one log line without a key, and the place read so far stays", async () => {
    store.resetOpenFeed(SCOPE);
    store.setOpenCursor(5);
    last = 5;
    answers.push({ status: 401, body: {} });
    await status.poll();
    advance(5 * 60_000);
    answers.push({ status: 200, body: { events: "x" } });
    await status.poll();
    advance(5 * 60_000);
    answers.push(new TypeError("fetch failed"));
    await status.poll();
    expect(lines).toEqual([
      "read statuses: the endpoint answered 401",
      "read statuses: the endpoint's answer was not understood",
      "read statuses: the endpoint could not be read (TypeError)",
    ]);
    advance(5 * 60_000);
    answers.push({ status: 200, body: "<html>" });
    await status.poll();
    expect(lines.at(-1)).toBe("read statuses: the endpoint could not be read (SyntaxError)");
    expect(lines.join(" ")).not.toContain(FEED);
    expect(store.openFeed()).toEqual({ scope: SCOPE, cursor: 5 });
  });

  it("does not let an answer move the place further than its own events, or past what the endpoint has given", async () => {
    store.resetOpenFeed(SCOPE);
    store.setOpenCursor(5);
    const token = status.issue()!.token;
    for (const body of [
      { events: [], next: 9_000_000, epoch: EPOCH, last: 9_000_000 },
      { events: [{ seq: 6, token, at: "2026-11-20T09:30:00Z", kind: "mobile" }], next: 700, epoch: EPOCH, last: 700 },
      { events: [{ seq: 6, token, at: "2026-11-20T09:30:00Z", kind: "mobile" }], next: 6, epoch: EPOCH, last: 5 },
      "x".repeat(2_000_001),
    ]) {
      answers.push({ status: 200, body });
      await status.poll();
      advance(5 * 60_000);
      expect(store.openFeed().cursor, JSON.stringify(body).slice(0, 60)).toBe(5);
    }
    expect(lines).toHaveLength(4);
  });

  it("starts over when the endpoint is another one or its numbers began again, and reads the new feed in the same poll", async () => {
    store.saveAccount(makeStoredAccount());
    store.upsertMessages("acc_1", "Sent", [makeFetchedMessage(1)]);
    const id = store.localFolderIndex("acc_1", "Sent", "1970-01-01T00:00:00.000Z")[0]!.id;
    const token = status.issue()!.token;
    store.saveSentTracking({ token, accountId: "acc_1", rfcMessageId: "msg-1@example.org", createdAt: "2026-11-20T09:00:00.000Z" });
    store.resetOpenFeed(SCOPE);
    store.saveOpenEvents([{ seq: 11_000, token, at: "2026-11-01T00:00:00.000Z", kind: "desktop" }]);
    store.setOpenCursor(12_000);
    // The endpoint lost its data: a new store id, numbers from 1.
    answers.push({ status: 200, body: { events: [], next: 12_000, epoch: "epoch-two-0002", last: 1 } });
    answers.push({ status: 200, body: { events: [{ seq: 1, token, at: "2026-11-20T09:30:00Z", kind: "mobile" }], next: 1, epoch: "epoch-two-0002", last: 1 } });
    answers.push({ status: 200, body: { events: [], next: 1, epoch: "epoch-two-0002", last: 1 } });
    expect(await status.poll()).toBe(1);
    expect(asked.map((ask) => ask.url.split("?")[1])).toEqual(["after=12000&limit=500", "after=0&limit=500", "after=1&limit=500"]);
    expect(store.openFeed()).toEqual({ scope: "https://makosh.example.org epoch-two-0002", cursor: 1 });
    expect(status.withMessages([{ id }])).toEqual([{ id, opens: { count: 1, lastAt: "2026-11-20T09:30:00.000Z" } }]);
  });

  it("two polls at once are one poll", async () => {
    store.resetOpenFeed(SCOPE);
    await Promise.all([status.poll(), status.poll()]);
    expect(asked).toHaveLength(1);
  });

  it("issues nothing for a message with a recipient the owner excepted", () => {
    settings = { ...settings, exceptions: "boss@example.com, example.net" };
    expect(status.issue(["ann@example.com"])).not.toBeNull();
    expect(status.issue(["ann@example.com", "boss@example.com"])).toBeNull();
    expect(status.issue(["someone@example.net"])).toBeNull();
    // Still set up: the composer's box is offered.
    expect(status.ready()).toBe(true);
  });

  it("marks a conversation only when someone opened it, and lists what was opened and not answered for Today", () => {
    store.saveAccount(makeStoredAccount());
    store.upsertMessages("acc_1", "Sent", [
      makeFetchedMessage(1, { from: { name: null, address: "owner@example.org" }, to: [{ name: "Ann", address: "ann@example.com" }], subject: "Plan", date: "2026-11-19T09:00:00.000Z" }),
      makeFetchedMessage(2, { from: { name: null, address: "owner@example.org" }, subject: "Other", date: "2026-11-19T10:00:00.000Z" }),
    ]);
    const ids = store.localFolderIndex("acc_1", "Sent", "1970-01-01T00:00:00.000Z");
    const threadOf = (uid: number) => store.getMessage(ids.find((row) => row.uid === uid)!.id)!.threadId;
    const [t1, t2] = [signedToken(TRACK, "aaaaaaaaaaaaaaaaaaaa"), signedToken(TRACK, "bbbbbbbbbbbbbbbbbbbb")];
    store.saveSentTracking({ token: t1, accountId: "acc_1", rfcMessageId: "msg-1@example.org", createdAt: "2026-11-19T09:00:00.000Z" });
    store.saveSentTracking({ token: t2, accountId: "acc_1", rfcMessageId: "msg-2@example.org", createdAt: "2026-11-19T10:00:00.000Z" });
    store.saveOpenEvents([{ seq: 1, token: t1, at: "2026-11-19T12:00:00.000Z", kind: "mobile" }]);
    expect(status.withThreads([{ id: threadOf(1) }, { id: threadOf(2) }, { id: "none" }])).toEqual([
      { id: threadOf(1), opens: { count: 1, lastAt: "2026-11-19T12:00:00.000Z" } },
      { id: threadOf(2) },
      { id: "none" },
    ]);
    expect(status.unanswered()).toEqual([
      { accountId: "acc_1", threadId: threadOf(1), subject: "Plan", to: { name: "Ann", address: "ann@example.com" }, count: 1, lastAt: "2026-11-19T12:00:00.000Z" },
    ]);
    settings = { ...settings, on: false };
    expect(status.unanswered()).toEqual([]);
  });

  it("does not ask the endpoint when read statuses are off", async () => {
    settings = { ...settings, on: false };
    expect(await status.poll()).toBe(0);
    expect(asked).toEqual([]);
  });
});
