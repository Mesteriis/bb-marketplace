import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const script = join(dirname(fileURLToPath(import.meta.url)), "check-manifests.mjs");

/** Runs the checker on a throw-away tree that holds only an mcp-collection; the plugin problems it also prints are ignored. */
function checkCollection(files) {
  const root = mkdtempSync(join(tmpdir(), "check-manifests-"));
  writeFileSync(join(root, "subtrees.json"), JSON.stringify({ plugins: [] }));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  const run = spawnSync(process.execPath, [script, root], { encoding: "utf8" });
  return run.stderr;
}

test("a non-object index entry gets one short message with its position", () => {
  const out = checkCollection({ "mcp-collection/index.json": JSON.stringify({ servers: [null, "x", ["y"]] }) });
  for (const position of [1, 2, 3]) {
    assert.match(out, new RegExp(`mcp-collection/index.json \\(entry #${position}\\): must be an object with string name, version and path`));
  }
});

test("an entry with a non-string field says which fields", () => {
  const out = checkCollection({ "mcp-collection/index.json": JSON.stringify({ servers: [{ name: "a/b", version: 1, path: "p" }] }) });
  assert.match(out, /mcp-collection\/index.json \(a\/b\): name, version and path must all be strings/);
});

test("a non-object entry.json is one clear problem, not a list of missing fields", () => {
  const out = checkCollection({
    "mcp-collection/index.json": JSON.stringify({ servers: [{ name: "a/b", version: "1.0.0", path: "mcp-collection/a-b" }] }),
    "mcp-collection/a-b/server.json": "{}",
    "mcp-collection/a-b/review.md": "ok",
    "mcp-collection/a-b/entry.json": "[]",
  });
  assert.match(out, /mcp-collection\/index.json \(a\/b\): entry.json must be a JSON object/);
  assert.doesNotMatch(out, /entry.json: name must be a string/);
});
