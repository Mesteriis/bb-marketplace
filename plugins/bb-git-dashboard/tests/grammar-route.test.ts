import assert from "node:assert/strict";
import { test } from "node:test";
import { grammarRoute } from "../src/adapters/bb/grammar-route.ts";

const ask = (id: string | undefined) => ({req: {query: (name: string) => name === "id" ? id : undefined}});

test("a known grammar comes back as JSON with its embedded languages, cached by the browser", async () => {
  const response = await grammarRoute()(ask("json"));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/json");
  assert.equal(response.headers.get("cache-control"), "private, max-age=86400");
  const body = await response.json() as {name: string}[];
  assert.deepEqual(body.map(grammar => grammar.name), ["json"]);
  const html = await (await grammarRoute()(ask("html"))).json() as {name: string}[];
  assert.ok(html.map(grammar => grammar.name).includes("javascript"));
});

test("an unknown or missing language is refused without loading anything", async () => {
  let loads = 0;
  const route = grammarRoute(async () => { loads++; return []; });
  assert.equal((await route(ask("../etc/passwd"))).status, 404);
  assert.equal((await route(ask(undefined))).status, 404);
  assert.equal((await route(ask("constructor"))).status, 404);
  assert.equal(loads, 0);
});

test("a grammar that fails to load is a 500 with a fixed message", async () => {
  const response = await grammarRoute(async () => { throw new Error("disk /secret/path"); })(ask("json"));
  assert.deepEqual([response.status, await response.text()], [500, "The grammar could not be loaded."]);
});
