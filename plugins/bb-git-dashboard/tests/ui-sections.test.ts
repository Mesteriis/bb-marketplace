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
