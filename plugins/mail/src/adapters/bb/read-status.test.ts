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
let status: ReturnType<typeof createReadStatus>;

beforeEach(() => {
  store = new InMemoryMailStore();
  clock = new FixedClock(new Date("2026-11-20T10:00:00.000Z"));
  settings = { on: true, origin: "https://makosh.example.org", trackKey: TRACK, feedKey: FEED };
  asked = [];
  answers = [];
  lines = [];
  status = createReadStatus({
    store,
    clock,
    settings: () => settings,
    newId: () => "abcdefghijklmnop",
    log: (line) => lines.push(line),
    fetch: async (url, init) => {
      asked.push({ url, auth: init.headers.Authorization });
      const next = answers.shift() ?? { status: 200, body: { events: [], next: store.openCursor() } };
      if (next instanceof Error) throw next;
      return { status: next.status, json: async () => next.body };
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
      settings = { on: true, origin: "https://makosh.example.org", trackKey: TRACK, feedKey: FEED, ...change };
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
    answers.push({
      status: 200,
      body: { events: [{ seq: 7, token, at: "2026-11-20T09:30:00Z", kind: "mobile" }, { seq: 8, token: "zzzzzzzzzzzzzzzz.Nf8gINmCVZOx9whO", at: "2026-11-20T09:31:00Z", kind: "desktop" }], next: 8 },
    });
    expect(await status.poll()).toBe(1);
    expect(asked).toEqual([
      { url: "https://makosh.example.org/api/events?after=0&limit=500", auth: `Bearer ${FEED}` },
      { url: "https://makosh.example.org/api/events?after=8&limit=500", auth: `Bearer ${FEED}` },
    ]);
    expect(status.withMessages([{ id }, { id: "other" }])).toEqual([{ id, opens: { count: 1, lastAt: "2026-11-20T09:30:00.000Z" } }, { id: "other" }]);
    advance(4 * 60_000);
    expect(await status.poll()).toBe(0);
    expect(asked).toHaveLength(2);
    advance(60_000);
    await status.poll();
    expect(asked).toHaveLength(3);
  });

  it("a refusal, a broken answer or a network failure is one log line without a key, and the place read so far stays", async () => {
    store.setOpenCursor(5);
    answers.push({ status: 401, body: {} });
    await status.poll();
    advance(5 * 60_000);
    answers.push({ status: 200, body: "<html>" });
    await status.poll();
    advance(5 * 60_000);
    answers.push(new TypeError("fetch failed"));
    await status.poll();
    expect(lines).toEqual([
      "read statuses: the endpoint answered 401",
      "read statuses: the endpoint's answer was not understood",
      "read statuses: the endpoint could not be read (TypeError)",
    ]);
    expect(lines.join(" ")).not.toContain(FEED);
    expect(store.openCursor()).toBe(5);
  });

  it("does not ask the endpoint when read statuses are off", async () => {
    settings = { ...settings, on: false };
    expect(await status.poll()).toBe(0);
    expect(asked).toEqual([]);
  });
});
