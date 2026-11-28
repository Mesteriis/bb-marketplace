import assert from "node:assert/strict";
import { test } from "node:test";
import { buildScaffold, scaffoldIssues, type Scaffold } from "../src/core/scaffolds/model.ts";

const vue = "<template>\n  <p>{{ msg }} and {{count}}</p>\n</template>\n<script setup lang=\"ts\">\nconst msg = \"{{name}}\";\n</script>\n";
const base: Scaffold = {id: "fixture", title: "Fixture", description: "", params: [], files: []};
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]).toString("base64");

test("a verbatim file is written byte for byte, its path still takes values", () => {
  const scaffold = {...base, files: [{path: "src/frontend/{{name}}.vue", body: vue, verbatim: true}]};
  assert.deepEqual(scaffoldIssues(scaffold), []);
  const [file] = buildScaffold(scaffold, {name: "hello"}, {}).files.filter(item => item.path.endsWith(".vue"));
  assert.equal(file!.path, "src/frontend/hello.vue");
  assert.equal(file!.text, vue);
});

test("text with {{ that is no template value is refused with the reason: list it under verbatim", () => {
  const scaffold = {...base, files: [{path: "src/frontend/App.vue", body: vue}]};
  assert.deepEqual(scaffoldIssues(scaffold), ["The scaffold does not render: src/frontend/App.vue: \"{{ msg }}\" is no template value; list the file under verbatim, or write ${{ for an expression."]);
});

test("a binary file is copied as its bytes; executable or under scripts/ it is refused", () => {
  const scaffold = {...base, files: [{path: "src/frontend/public/icon.png", body: png, base64: true}]};
  const [file] = buildScaffold(scaffold, {}, {}).files.filter(item => item.path.endsWith(".png"));
  assert.deepEqual([file!.text, file!.base64, file!.executable], [png, true, false]);
  assert.deepEqual(scaffoldIssues({...base, files: [{path: "tool", body: png, base64: true, executable: true}]}),
    ["The scaffold does not render: tool: a binary file may not be executable."]);
  assert.deepEqual(scaffoldIssues({...base, files: [{path: "scripts/check", body: png, base64: true}]}),
    ["The scaffold does not render: scripts/check: a binary file may not be in scripts/."]);
  assert.deepEqual(scaffoldIssues({...base, files: [{path: "a.bin", body: "not base64!", base64: true}]}),
    ["The scaffold does not render: a.bin: the binary content is not base64."]);
});
