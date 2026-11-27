import test from "node:test";
import assert from "node:assert/strict";
import { workflowOf } from "../src/core/ci/dispatch.ts";

const workflows = [{id: "123", name: "CI", path: ".github/workflows/ci.yml"}, {id: "124", name: "Deploy", path: ".github/workflows/deploy.yml"}];

test("a run's workflow is found by id or, as GitHub and Gitea name it on runs, by path", () => {
  assert.equal(workflowOf(workflows, "124")?.name, "Deploy");
  assert.equal(workflowOf(workflows, ".github/workflows/deploy.yml")?.name, "Deploy");
  assert.equal(workflowOf(workflows, "nope"), undefined);
  assert.equal(workflowOf(workflows, null), undefined);
});
