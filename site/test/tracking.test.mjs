import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { OpenStore, clientKind, sameSecret, signTokenId, validToken } from "../src/tracking.mjs";

const KEY = "test-key";
const ID = "abcdefghijklmnop";

test("a token is valid only with the signature of its id under the key", () => {
  // HMAC-SHA256("test-key", "abcdefghijklmnop") in base64url, first 16 characters.
  assert.equal(signTokenId(KEY, ID), "Nf8gINmCVZOx9whO");
  assert.equal(validToken(KEY, `${ID}.Nf8gINmCVZOx9whO`), `${ID}.Nf8gINmCVZOx9whO`);
  assert.equal(validToken("other-key", `${ID}.Nf8gINmCVZOx9whO`), null);
  assert.equal(validToken(KEY, `${ID}.Nf8gINmCVZOx9whP`), null);
  assert.equal(validToken(KEY, ID), null);
  assert.equal(validToken(KEY, `short.Nf8gINmCVZOx9whO`), null);
  assert.equal(validToken(KEY, `../../etc/passwd.Nf8gINmCVZOx9whO`), null);
});

test("secrets compare by value, whatever their lengths", () => {
  assert.equal(sameSecret("abc", "abc"), true);
  assert.equal(sameSecret("abc", "abcd"), false);
  assert.equal(sameSecret("", "abc"), false);
});

test("the kind of client is coarse and names mail services that fetch by themselves", () => {
  assert.equal(clientKind("Mozilla/5.0 (Windows NT 5.1; rv:11.0) Gecko Firefox/11.0 (via ggpht.com GoogleImageProxy)"), "gmail-proxy");
  assert.equal(clientKind("YahooMailProxy; https://help.yahoo.com/kb/yahoo-mail-proxy-SLN28749.html"), "yahoo-proxy");
  assert.equal(clientKind("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148"), "mobile");
  assert.equal(clientKind("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15"), "desktop");
  assert.equal(clientKind("curl/8.7.1"), "machine");
  assert.equal(clientKind("Mozilla/5.0"), "unknown");
  assert.equal(clientKind(undefined), "unknown");
});

test("opens are numbered, a quick repeat is one open, a reader pages after a number", () => {
  const store = new OpenStore(null);
  const at = (seconds) => new Date(Date.UTC(2026, 10, 20, 10, 0, seconds));
  assert.equal(store.record("t1", "desktop", at(0)), true);
  assert.equal(store.record("t1", "desktop", at(30)), false);
  assert.equal(store.record("t1", "mobile", at(31)), true);
  assert.equal(store.record("t1", "desktop", at(61)), true);
  assert.equal(store.record("t2", "desktop", at(62)), true);
  assert.deepEqual(store.after(0, 2), {
    events: [
      { seq: 1, token: "t1", at: "2026-11-20T10:00:00.000Z", kind: "desktop" },
      { seq: 2, token: "t1", at: "2026-11-20T10:00:31.000Z", kind: "mobile" },
    ],
    next: 2,
    epoch: store.epoch,
    last: 4,
  });
  assert.deepEqual(store.after(2).events.map((event) => event.seq), [3, 4]);
  assert.deepEqual(store.after(4), { events: [], next: 4, epoch: store.epoch, last: 4 });
});

test("one token is recorded 100 times at most", () => {
  const store = new OpenStore(null);
  let recorded = 0;
  for (let i = 0; i < 120; i++) if (store.record("t1", "desktop", new Date(Date.UTC(2026, 10, 20, 0, i * 2)))) recorded++;
  assert.equal(recorded, 100);
});

test("the file survives a restart, a torn line is skipped, 90 days are kept and numbers never go back", () => {
  const dir = mkdtempSync(join(tmpdir(), "makosh-site-"));
  const file = join(dir, "data", "opens.jsonl");
  try {
    const first = new OpenStore(file);
    first.record("old", "desktop", new Date("2026-08-01T00:00:00Z"));
    first.record("new", "desktop", new Date("2026-11-19T00:00:00Z"));
    writeFileSync(file, `${readFileSync(file, "utf8")}{"seq":3,"tok`);
    const second = new OpenStore(file);
    assert.equal(second.size, 2);
    assert.equal(second.prune(new Date("2026-11-20T00:00:00Z")), 1);
    assert.deepEqual(readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line).token), ["new"]);
    assert.equal(second.record("next", "mobile", new Date("2026-11-20T00:00:01Z")), true);
    assert.deepEqual(new OpenStore(file).after(0).events.map((event) => [event.seq, event.token]), [[2, "new"], [3, "next"]]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("numbers are never reused: not after everything was pruned and the server restarted, and a lost data file keeps the epoch and the count", () => {
  const dir = mkdtempSync(join(tmpdir(), "makosh-site-"));
  const file = join(dir, "opens.jsonl");
  try {
    const first = new OpenStore(file);
    first.record("a", "desktop", new Date("2026-01-01T00:00:00Z"));
    first.record("b", "desktop", new Date("2026-01-02T00:00:00Z"));
    assert.equal(first.prune(new Date("2026-11-20T00:00:00Z")), 2);
    const second = new OpenStore(file);
    assert.equal(second.epoch, first.epoch);
    second.record("c", "desktop", new Date("2026-11-20T00:00:01Z"));
    assert.deepEqual(second.after(2), { events: [{ seq: 3, token: "c", at: "2026-11-20T00:00:01.000Z", kind: "desktop" }], next: 3, epoch: first.epoch, last: 3 });
    second.prune(new Date("2027-11-20T00:00:00Z"));
    rmSync(file);
    const third = new OpenStore(file);
    third.record("d", "desktop", new Date("2027-11-20T00:00:01Z"));
    assert.deepEqual(third.after(0).events.map((event) => event.seq), [4]);
    // Both files gone: a new epoch, so a reader knows to start over.
    rmSync(file);
    rmSync(`${file}.state`);
    assert.notEqual(new OpenStore(file).epoch, first.epoch);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an append after a torn line starts a line of its own, and its number is not reused", () => {
  const dir = mkdtempSync(join(tmpdir(), "makosh-site-"));
  const file = join(dir, "opens.jsonl");
  try {
    const first = new OpenStore(file);
    first.record("a", "desktop", new Date("2026-11-20T00:00:00Z"));
    writeFileSync(file, `${readFileSync(file, "utf8")}{"seq":2,"tok`);
    const second = new OpenStore(file);
    second.record("b", "desktop", new Date("2026-11-20T00:00:01Z"));
    assert.deepEqual(new OpenStore(file).after(0).events.map((event) => [event.seq, event.token]), [[1, "a"], [2, "b"]]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a data file that cannot be written loses the open, not the server: nothing is kept, the number is not used, one log line", () => {
  const dir = mkdtempSync(join(tmpdir(), "makosh-site-"));
  const lines = [];
  try {
    // The "file" is a directory: every append fails.
    const store = new OpenStore(join(dir, "as-directory"), (line) => lines.push(line));
    mkdirSync(join(dir, "as-directory"));
    assert.equal(store.record("a", "desktop", new Date("2026-11-20T00:00:00Z")), false);
    assert.equal(store.record("b", "desktop", new Date("2026-11-20T00:00:01Z")), false);
    assert.equal(store.size, 0);
    assert.equal(store.after(0).last, 0);
    assert.deepEqual(lines, ["opens: the data file cannot be written (EISDIR)"]);
    assert.throws(() => store.checkWritable());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
