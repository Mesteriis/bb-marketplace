import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { PIXEL, createApp } from "../src/app.mjs";
import { OpenStore, signTokenId } from "../src/tracking.mjs";

const TRACK = "track-key-for-tests-0123456789abcdef";
const API = "api-key-for-tests-0123456789abcdefgh";
const ID = "abcdefghijklmnop";
const TOKEN = `${ID}.${signTokenId(TRACK, ID)}`;
let server;
let base;
let store;
let clock;

before(async () => {
  store = new OpenStore(null);
  clock = new Date("2026-11-20T10:00:00Z");
  server = createServer(
    createApp({
      trackKey: TRACK,
      apiKey: API,
      store,
      now: () => clock,
      catalog: { plugins: [{ id: "makosh-mail", name: "Makosh Mail", description: "Mail <b>inside</b> BB", author: "Mesteriis", own: true }, { id: "other", name: "Other", description: "Else", author: "Ann & Co", own: false }] },
      site: { origin: "https://makosh.example.org", contact: "owner@example.org", googleVerification: "abc123", googleVerificationFile: "google0123456789abcdef.html" },
    }),
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const events = async (query = "") => (await fetch(`${base}/api/events${query}`, { headers: { Authorization: `Bearer ${API}` } })).json();

test("the pages answer with what a reviewer looks for", async () => {
  const home = await fetch(`${base}/`);
  const html = await home.text();
  assert.equal(home.status, 200);
  assert.match(home.headers.get("content-security-policy"), /default-src 'none'/);
  assert.ok(html.includes('<meta name="google-site-verification" content="abc123">'));
  assert.ok(html.includes('href="/privacy"'));
  assert.ok(html.includes("Mail &lt;b&gt;inside&lt;/b&gt; BB"));
  assert.ok(html.includes("by Ann &amp; Co"));
  const privacy = await (await fetch(`${base}/privacy/`)).text();
  assert.ok(privacy.includes("Google API Services User Data Policy"));
  assert.ok(privacy.includes("Limited Use"));
  assert.ok(privacy.includes("mailto:owner@example.org"));
  const mail = await (await fetch(`${base}/mail`)).text();
  assert.ok(mail.includes("https://mail.google.com/"));
  assert.equal((await fetch(`${base}/terms`)).status, 200);
  assert.equal(await (await fetch(`${base}/google0123456789abcdef.html`)).text(), "google-site-verification: google0123456789abcdef.html");
  assert.equal((await fetch(`${base}/nope`)).status, 404);
  assert.equal((await fetch(`${base}/..%2f..%2fetc/passwd`)).status, 404);
  assert.equal((await fetch(`${base}/`, { method: "POST" })).status, 405);
  assert.equal(await (await fetch(`${base}/healthz`)).text(), "ok\n");
});

test("a signed token is recorded once with a coarse client kind; anything else gets the same image and no record", async () => {
  const good = await fetch(`${base}/o/${TOKEN}.gif`, { headers: { "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) Mobile/15E148", "X-Forwarded-For": "203.0.113.9" } });
  assert.equal(good.status, 200);
  assert.equal(good.headers.get("content-type"), "image/gif");
  assert.equal(good.headers.get("cache-control"), "no-store, private, max-age=0");
  assert.deepEqual(Buffer.from(await good.arrayBuffer()), PIXEL);
  for (const path of [`/o/${ID}.AAAAAAAAAAAAAAAA.gif`, "/o/whatever.gif", `/o/${TOKEN}x.gif`]) {
    const bad = await fetch(`${base}${path}`);
    assert.equal(bad.status, 200);
    assert.deepEqual(Buffer.from(await bad.arrayBuffer()), PIXEL);
  }
  await fetch(`${base}/o/${TOKEN}.gif`, { method: "HEAD" });
  assert.deepEqual(await events(), { events: [{ seq: 1, token: TOKEN, at: "2026-11-20T10:00:00.000Z", kind: "mobile" }], next: 1 });
  assert.equal(JSON.stringify(await events()).includes("203.0.113.9"), false);
});

test("the feed needs the key, pages after a number and refuses nonsense", async () => {
  assert.equal((await fetch(`${base}/api/events`)).status, 401);
  assert.equal((await fetch(`${base}/api/events`, { headers: { Authorization: `Bearer ${TRACK}` } })).status, 401);
  assert.equal((await fetch(`${base}/api/events?after=-1`, { headers: { Authorization: `Bearer ${API}` } })).status, 400);
  assert.equal((await fetch(`${base}/api/events?after=abc`, { headers: { Authorization: `Bearer ${API}` } })).status, 400);
  assert.deepEqual(await events("?after=1"), { events: [], next: 1 });
});
