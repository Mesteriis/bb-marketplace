import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateSubtrees } from "./check-subtrees.mjs";
function fixture(t, edit = () => {}) {
  const root = mkdtempSync(join(tmpdir(), "subtrees-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const plugin = { id: "example", prefix: "plugins/example", upstream: "https://github.com/author/plugin.git", fork: "https://github.com/Mesteriis/plugin.git", branch: "marketplace/example", commit: "a".repeat(40), remote: "plugin-example", upstreamRemote: "upstream-example" };
  const registry = { schemaVersion: 1, plugins: [plugin] };
  const catalog = { plugins: [{ source: { git: { url: "https://github.com/Mesteriis/bb-marketplace.git", subdir: "plugins/example", ref: "main" } } }] };
  edit(registry, catalog);
  mkdirSync(join(root, "plugins/example"), { recursive: true });
  writeFileSync(join(root, "plugins/example/package.json"), "{}");
  writeFileSync(join(root, "subtrees.json"), JSON.stringify(registry));
  writeFileSync(join(root, "marketplace.json"), JSON.stringify(catalog));
  return root;
}
test("accepts an independent fork and aggregate source", t => assert.deepEqual(validateSubtrees(fixture(t)), []));
test("rejects duplicate subtrees and remotes", t => {
  const errors = validateSubtrees(fixture(t, r => r.plugins.push({ ...r.plugins[0] })));
  assert.deepEqual(errors, ["duplicate subtree: example", "invalid or duplicate remote: plugin-example", "invalid or duplicate remote: upstream-example"]);
});
test("rejects a source outside the maintained aggregate", t => {
  const root = fixture(t, (_, c) => c.plugins[0].source.git.url = "https://github.com/author/plugin.git");
  assert.deepEqual(validateSubtrees(root), ["missing maintained catalog source: example"]);
});
test("rejects traversal and a fork owned by another account", t => {
  const root = fixture(t, r => { r.plugins[0].prefix = "../example"; r.plugins[0].fork = "https://github.com/author/plugin.git"; });
  assert.deepEqual(validateSubtrees(root), ["invalid prefix: example", "invalid maintained fork: example", "missing package: example", "missing maintained catalog source: example"]);
});
