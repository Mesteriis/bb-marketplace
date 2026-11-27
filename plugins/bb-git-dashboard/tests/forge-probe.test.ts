import test from "node:test";
import assert from "node:assert/strict";
import { probeForge } from "../src/adapters/bb/forge-probe.ts";

type Reply = Response | "timeout";
function server(routes: Record<string, () => Reply>) {
  const seen: {url: string; init?: RequestInit}[] = [];
  const send = (async (target: string | URL, init?: RequestInit) => {
    const url = String(target);
    seen.push({url, init});
    const reply = (routes[new URL(url).pathname] ?? (() => new Response("not found", {status: 404})))();
    if (reply === "timeout") throw new DOMException("timed out", "TimeoutError");
    return reply;
  }) as typeof fetch;
  return {send, seen};
}

test("a Gitea or Forgejo version endpoint identifies Gitea", async () => {
  for (const version of ["1.25.3", "28.2.0"]) {
    const {send} = server({"/api/v1/version": () => Response.json({version})});
    assert.equal(await probeForge("https://git.example.org", send), "gitea");
  }
});

test("a GitLab version endpoint identifies GitLab, signed in or not", async () => {
  const open = server({"/api/v4/version": () => Response.json({version: "17.0.0", revision: "abc"})});
  assert.equal(await probeForge("https://gitlab.example.org", open.send), "gitlab");
  const closed = server({"/api/v4/version": () => Response.json({message: "401 Unauthorized"}, {status: 401})});
  assert.equal(await probeForge("https://gitlab.example.org", closed.send), "gitlab");
});

test("redirects, HTML and oversized bodies identify nothing", async () => {
  const redirect = server({"/api/v1/version": () => new Response(null, {status: 302, headers: {location: "/login"}})});
  assert.equal(await probeForge("https://sso.example.org", redirect.send), null);
  const html = server({"/api/v1/version": () => new Response("<html>version</html>", {headers: {"content-type": "text/html"}})});
  assert.equal(await probeForge("https://site.example.org", html.send), null);
  const huge = server({"/api/v1/version": () => new Response(JSON.stringify({version: "1", pad: "x".repeat(100 * 1024)}))});
  assert.equal(await probeForge("https://big.example.org", huge.send), null);
});

test("a host that never answers is unreachable", async () => {
  const {send} = server({"/api/v1/version": () => "timeout", "/api/v4/version": () => "timeout"});
  assert.equal(await probeForge("https://gitlab.acme.example", send), "unreachable");
});

test("probes send no credentials and do not follow redirects", async () => {
  const {send, seen} = server({});
  await probeForge("https://git.example.org", send);
  assert.deepEqual(seen.map(call => call.url).sort(), ["https://git.example.org/api/v1/version", "https://git.example.org/api/v4/version"]);
  for (const call of seen) {
    assert.equal(call.init?.redirect, "manual");
    assert.equal(new Headers(call.init?.headers).get("authorization"), null);
    assert.equal(call.init?.credentials, "omit");
  }
});
