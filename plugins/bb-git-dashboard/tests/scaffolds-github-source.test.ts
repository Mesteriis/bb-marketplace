import assert from "node:assert/strict";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { ScaffoldCache } from "../src/adapters/bb/scaffold-cache.ts";
import { githubTemplates } from "../src/adapters/bb/scaffold-source.ts";
import { memoryDb } from "./review-db.ts";

const shaA = "a".repeat(40);
const shaB = "b".repeat(40);
const token = "stand-token-not-a-secret";

/** A tar with one file under the archive's top folder. */
function archive(text: string) {
  const header = new Uint8Array(512);
  const name = "owner-templates-aaaaaaa/common/template.json";
  const body = new TextEncoder().encode(text);
  const put = (value: string, at: number) => header.set(new TextEncoder().encode(value), at);
  put(name, 0); put("0000644", 100); put("0000000", 108); put("0000000", 116);
  put(body.length.toString(8).padStart(11, "0"), 124); put("00000000000", 136); put("        ", 148); put("0", 156); put("ustar", 257); put("00", 263);
  put(header.reduce((total, byte) => total + byte, 0).toString(8).padStart(6, "0") + "\0 ", 148);
  const data = new Uint8Array(Math.ceil(body.length / 512) * 512); data.set(body);
  const all = new Uint8Array(512 + data.length + 1024); all.set(header); all.set(data, 512);
  return gzipSync(all);
}

/** GitHub as the tests set it: the branch's head, its ETag, the archives, and whether the limit is reached. */
function github() {
  const state = {head: shaA, limited: false, down: false, archives: {[shaA]: archive("{\"format\": 1}\n"), [shaB]: archive("{\"format\": 1, \"x\": 2}\n")} as Record<string, Uint8Array>};
  const seen: {url: string; authorization: string | null}[] = [];
  const send = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    const headers = new Headers(init.headers);
    seen.push({url, authorization: headers.get("authorization")});
    if (state.down) throw new TypeError("fetch failed");
    if (state.limited && !headers.get("authorization")) return new Response("{}", {status: 403, headers: {"x-ratelimit-remaining": "0"}});
    const branch = /\/repos\/([^/]+\/[^/]+)\/branches\/(.+)$/.exec(url);
    if (branch) {
      if (branch[1] !== "owner/templates") return new Response("{}", {status: 404});
      const etag = "W/\"" + state.head.slice(0, 4) + "\"";
      if (headers.get("if-none-match") === etag) return new Response(null, {status: 304});
      return new Response(JSON.stringify({commit: {sha: state.head, commit: {committer: {date: "2026-11-28T10:00:00Z"}}}}), {status: 200, headers: {etag}});
    }
    const tarball = /\/tarball\/([a-f0-9]{40})$/.exec(url);
    if (tarball) return new Response(null, {status: 302, headers: {location: "https://codeload.github.com/owner/templates/legacy.tar.gz/" + tarball[1]}});
    const sha = /legacy\.tar\.gz\/([a-f0-9]{40})$/.exec(url)?.[1];
    if (sha && state.archives[sha]) return new Response(Buffer.from(state.archives[sha]), {status: 200});
    return new Response("", {status: 404});
  }) as typeof fetch;
  return {state, seen, send};
}

function setup(options: {token?: string | null; repository?: string} = {}) {
  const forge = github();
  const cache = new ScaffoldCache(memoryDb());
  let now = Date.parse("2026-11-28T12:00:00Z");
  const settings = {repository: options.repository ?? "owner/templates", branch: "main"};
  const source = githubTemplates({send: forge.send, cache, settings: async () => settings, token: async () => options.token ?? null, now: () => now});
  return {forge, cache, source, settings, advance: (ms: number) => { now += ms; }};
}

test("the first check reads the branch and the archive of its head; the next one is a 304 and reads nothing more", async () => {
  const {forge, source} = setup();
  const first = await source.check("button");
  assert.deepEqual(first.state, {repository: "owner/templates", branch: "main", revision: {sha: shaA, committedAt: "2026-11-28T10:00:00.000Z"},
    checkedAt: "2026-11-28T12:00:00.000Z", error: null});
  assert.deepEqual(first.files?.map(file => file.path), ["common/template.json"]);
  assert.equal(forge.seen.length, 3);
  const again = await source.check("button");
  assert.equal(again.state.revision?.sha, shaA);
  assert.equal(forge.seen.length, 4);
  assert.match(forge.seen[3]!.url, /\/branches\/main$/);
});

test("a new head is read whole and replaces the revision; a broken archive keeps the revision held and says why", async () => {
  const {forge, source} = setup();
  await source.check("button");
  forge.state.head = shaB;
  assert.equal((await source.check("button")).state.revision?.sha, shaB);
  forge.state.head = shaA;
  forge.state.archives[shaA] = new Uint8Array([1, 2, 3]);
  const broken = await source.check("button");
  assert.equal(broken.state.revision?.sha, shaB);
  assert.deepEqual(broken.state.error, {code: "SCAFFOLDS_INVALID", detail: "the archive is not gzip"});
  assert.match(broken.files![0]!.text, /"x": 2/);
});

test("without the network the revision held is offered with the reason; with nothing held the list is empty", async () => {
  const {forge, source} = setup();
  forge.state.down = true;
  const nothing = await source.check("button");
  assert.deepEqual([nothing.state.revision, nothing.files, nothing.state.error?.code], [null, null, "PROVIDER_UNAVAILABLE"]);
  forge.state.down = false;
  await source.check("button");
  forge.state.down = true;
  const offline = await source.check("button");
  assert.deepEqual([offline.state.revision?.sha, offline.state.error?.code, offline.files?.length], [shaA, "PROVIDER_UNAVAILABLE", 1]);
});

test("opening the form checks at most once a minute; the button always checks", async () => {
  const {forge, source, advance} = setup();
  await source.check("open");
  await source.check("open");
  assert.equal(forge.seen.filter(item => item.url.includes("/branches/")).length, 1);
  advance(61_000);
  await source.check("open");
  await source.check("button");
  assert.equal(forge.seen.filter(item => item.url.includes("/branches/")).length, 3);
});

test("checks at the same time make one request", async () => {
  const {forge, source} = setup();
  await Promise.all([source.check("button"), source.check("open"), source.check("background")]);
  assert.equal(forge.seen.filter(item => item.url.includes("/branches/")).length, 1);
});

test("another repository or branch in the settings never reads the revision of the first", async () => {
  const {source, settings} = setup();
  await source.check("button");
  settings.repository = "other/templates";
  const other = await source.current();
  assert.deepEqual([other.state.repository, other.state.revision, other.files], ["other/templates", null, null]);
  const checked = await source.check("button");
  assert.deepEqual([checked.state.revision, checked.state.error?.code], [null, "NOT_FOUND"]);
  settings.repository = "owner/templates";
  settings.branch = "next";
  assert.equal((await source.current()).state.revision, null);
});

test("after GitHub's limit the token is used, and it is in no answer, no cache row and no error", async () => {
  const {forge, source, cache} = setup({token});
  forge.state.limited = true;
  const result = await source.check("button");
  assert.equal(result.state.revision?.sha, shaA);
  assert.ok(forge.seen.every(item => item.authorization === null || item.authorization === "Bearer " + token));
  assert.ok(forge.seen.every(item => /^https:\/\/(?:api|codeload)\.github\.com\//.test(item.url)));
  const row = cache.get("owner/templates", "main")!;
  assert.doesNotMatch(JSON.stringify({...row, archive: Buffer.from(row.archive).toString("latin1")}), new RegExp(token));
  assert.doesNotMatch(JSON.stringify(result.state), new RegExp(token));
  const noToken = setup();
  noToken.forge.state.limited = true;
  assert.equal((await noToken.source.check("button")).state.error?.code, "PROVIDER_RATE_LIMITED");
});

test("a setting that names no repository is an error of its own, and GitHub is not asked", async () => {
  const {forge, source} = setup({repository: "not a repository"});
  const result = await source.check("button");
  assert.deepEqual(result.state.error, {code: "INVALID_INPUT", detail: "the templates repository is not owner/name on GitHub, or the branch is not a branch name"});
  assert.equal(forge.seen.length, 0);
});
