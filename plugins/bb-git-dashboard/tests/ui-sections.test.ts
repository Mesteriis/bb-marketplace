import test from "node:test";
import assert from "node:assert/strict";
import { sectionOf, sections } from "../src/ui/shell/sections.ts";

test("every place of the dashboard belongs to one section of the side column", () => {
  assert.equal(sectionOf(""), "overview");
  assert.equal(sectionOf("projects"), "projects");
  assert.equal(sectionOf("project/p-1"), "projects");
  assert.equal(sectionOf("c0ffee12"), "projects");
  assert.equal(sectionOf("c0ffee12/actions"), "projects");
  // A run is a CI/CD page; the templates stay in the copy's tab.
  assert.equal(sectionOf("c0ffee12/actions/42"), "ci");
  assert.equal(sectionOf("c0ffee12/actions/templates"), "projects");
  assert.equal(sectionOf("c0ffee12/review/src%2Fa.ts"), "projects");
  assert.equal(sectionOf("issue/acc-1/7/team/notes"), "projects");
  assert.equal(sectionOf("pr/acc-1/12/team/notes"), "inbox");
  assert.equal(sectionOf("inbox"), "inbox");
  assert.equal(sectionOf("ci"), "ci");
  assert.equal(sectionOf("reviews"), "reviews");
  assert.equal(sectionOf("catalog"), "catalog");
  assert.equal(sectionOf("connections"), "connections");
  assert.equal(sectionOf("remotes"), "connections");
});

test("the side column lists each section once, with its path", () => {
  assert.deepEqual(sections.map(section => [section.id, section.path]), [
    ["overview", ""], ["inbox", "inbox"], ["ci", "ci"], ["reviews", "reviews"], ["projects", "projects"], ["catalog", "catalog"],
  ]);
});

test("a review's view in words: each kind has its key, with its base, commit or range", async () => {
  const { targetWords } = await import("../src/core/code-review/target-words.ts");
  const { format } = await import("../src/core/i18n/language.ts");
  const { targetFromKey } = await import("../src/core/code-review/model.ts");
  const words = (key: string, language: "en" | "ru") => { const {key: k, values} = targetWords(targetFromKey(key)); return format(language, k, values); };
  assert.equal(words("uncommitted", "ru"), "Незакоммиченные изменения");
  assert.equal(words("uncommitted", "en"), "Uncommitted changes");
  assert.equal(words("branch:main", "ru"), "Коммиты ветки после main");
  assert.equal(words("commit:abcdef1234", "en"), "Commit abcdef1");
  assert.equal(words("range:v1..v2", "en"), "Range v1..v2");
});
