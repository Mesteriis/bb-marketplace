import assert from "node:assert/strict";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { fetchBranch, fetchTarball, withLimit } from "../src/adapters/bb/scaffold-github.ts";

const sha = "0123456789abcdef0123456789abcdef01234567";
const token = "stand-token-not-a-secret";
type Seen = {url: string; authorization: string | null; ifNoneMatch: string | null; redirect: RequestRedirect | undefined};

/** A fetch that answers from a list of handlers by URL and records what was asked. */
function fake(routes: Record<string, (init: RequestInit) => Response>) {
  const seen: Seen[] = [];
  const send = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    const headers = new Headers(init.headers);
    seen.push({url, authorization: headers.get("authorization"), ifNoneMatch: headers.get("if-none-match"), redirect: init.redirect});
    const route = routes[url];
    if (!route) throw new TypeError("fetch failed");
    return route(init);
  }) as typeof fetch;
  return {send, seen};
}
const branchBody = JSON.stringify({name: "main", commit: {sha, commit: {committer: {date: "2026-11-28T11:03:48Z"}}}});
const branchUrl = "https://api.github.com/repos/owner/templates/branches/main";

test("the branch is read with its ETag; the same ETag again is a 304 and nothing changes", async () => {
  const {send, seen} = fake({[branchUrl]: init => new Headers(init.headers).get("if-none-match") === "W/\"e1\""
    ? new Response(null, {status: 304}) : new Response(branchBody, {status: 200, headers: {etag: "W/\"e1\""}})});
  assert.deepEqual(await fetchBranch(send, {repository: "owner/templates", branch: "main"}, null),
    {changed: true, sha, committedAt: "2026-11-28T11:03:48.000Z", etag: "W/\"e1\""});
  assert.deepEqual(await fetchBranch(send, {repository: "owner/templates", branch: "main"}, "W/\"e1\""), {changed: false});
  assert.deepEqual(seen.map(item => [item.authorization, item.ifNoneMatch, item.redirect]), [[null, null, "manual"], [null, "W/\"e1\"", "manual"]]);
});

test("the tarball of the sha follows one redirect to codeload only, and its bytes are unpacked in memory", async () => {
  const tar = new Uint8Array(1024);
  const codeload = "https://codeload.github.com/owner/templates/legacy.tar.gz/" + sha;
  const {send, seen} = fake({
    ["https://api.github.com/repos/owner/templates/tarball/" + sha]: () => new Response(null, {status: 302, headers: {location: codeload}}),
    [codeload]: () => new Response(gzipSync(tar), {status: 200}),
  });
  assert.deepEqual(Buffer.from((await fetchTarball(send, {repository: "owner/templates", sha})).archive), gzipSync(tar));
  assert.deepEqual(seen.map(item => item.url), ["https://api.github.com/repos/owner/templates/tarball/" + sha, codeload]);
  const elsewhere = fake({["https://api.github.com/repos/owner/templates/tarball/" + sha]: () =>
    new Response(null, {status: 302, headers: {location: "https://example.invalid/archive.tgz"}})});
  await assert.rejects(fetchTarball(elsewhere.send, {repository: "owner/templates", sha}),
    {message: "PROVIDER_REJECTED", detail: "GitHub sent the archive to example.invalid, which is not codeload.github.com"});
  assert.equal(elsewhere.seen.length, 1);
});

test("an archive over 5 MB compressed is refused while it arrives", async () => {
  const codeload = "https://codeload.github.com/owner/templates/legacy.tar.gz/" + sha;
  let pulled = 0;
  const huge = new ReadableStream<Uint8Array>({pull(controller) { pulled++; controller.enqueue(new Uint8Array(1024 * 1024)); }});
  const {send} = fake({
    ["https://api.github.com/repos/owner/templates/tarball/" + sha]: () => new Response(null, {status: 302, headers: {location: codeload}}),
    [codeload]: () => new Response(huge, {status: 200}),
  });
  await assert.rejects(fetchTarball(send, {repository: "owner/templates", sha}), {message: "SCAFFOLDS_INVALID", detail: "the archive is over 5 MB"});
  assert.ok(pulled <= 7, "stopped reading at the limit, read " + pulled + " MB");
});

test("the token is used only after GitHub's limit, only towards api.github.com and codeload, and never in errors", async () => {
  const limited = () => new Response("{\"message\":\"API rate limit exceeded\"}", {status: 403, headers: {"x-ratelimit-remaining": "0", "x-ratelimit-reset": "1"}});
  let calls = 0;
  const {send, seen} = fake({[branchUrl]: init => ++calls === 1 ? limited()
    : new Headers(init.headers).get("authorization") === "Bearer " + token ? new Response(branchBody, {status: 200}) : limited()});
  const result = await withLimit(async auth => fetchBranch(send, {repository: "owner/templates", branch: "main"}, null, auth), async () => token);
  assert.equal(result.used, "token");
  assert.deepEqual(seen.map(item => item.authorization), [null, "Bearer " + token]);

  // No token: the limit is the answer, without retrying.
  const alone = fake({[branchUrl]: limited});
  await assert.rejects(withLimit(auth => fetchBranch(alone.send, {repository: "owner/templates", branch: "main"}, null, auth), async () => null),
    {message: "PROVIDER_RATE_LIMITED"});
  assert.equal(alone.seen.length, 1);

  // A redirect elsewhere with the token on: refused before anything is sent there, and the error does not carry it.
  const codeload = "https://example.invalid/legacy.tar.gz";
  const away = fake({["https://api.github.com/repos/owner/templates/tarball/" + sha]: () => new Response(null, {status: 302, headers: {location: codeload}})});
  const failure = await fetchTarball(away.send, {repository: "owner/templates", sha}, token).then(() => assert.fail("refused"), (error: unknown) => error as Error & {detail: string});
  assert.equal(away.seen.length, 1);
  assert.doesNotMatch(JSON.stringify({message: failure.message, detail: failure.detail, stack: failure.stack}), new RegExp(token));
});

test("a repository or branch that is not there, a moved repository and an unreachable GitHub are told apart", async () => {
  const at = (status: number, headers: Record<string, string> = {}) => fake({[branchUrl]: () => new Response("{}", {status, headers})}).send;
  const branch = {repository: "owner/templates", branch: "main"};
  await assert.rejects(fetchBranch(at(404), branch, null), {message: "NOT_FOUND", detail: "owner/templates has no branch main on GitHub, or the repository is private"});
  await assert.rejects(fetchBranch(at(301, {location: "https://api.github.com/repositories/1"}), branch, null),
    {message: "NOT_FOUND", detail: "owner/templates moved on GitHub: set the templates repository to its new name"});
  await assert.rejects(fetchBranch(fake({}).send, branch, null), {message: "PROVIDER_UNAVAILABLE"});
  await assert.rejects(fetchBranch(at(200), branch, null), {message: "PROVIDER_REJECTED", detail: "GitHub's answer for branch main has no commit"});
  assert.throws(() => fetchBranch(at(200), {repository: "owner/../x", branch: "main"}, null), {message: "INVALID_INPUT"});
  assert.throws(() => fetchBranch(at(200), {repository: "owner/templates", branch: "../main"}, null), {message: "INVALID_INPUT"});
});
