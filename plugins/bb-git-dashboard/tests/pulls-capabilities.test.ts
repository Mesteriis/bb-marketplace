import assert from "node:assert/strict";
import { test } from "node:test";
import { pullCapabilities, pullLimitation } from "../src/core/pulls/capabilities.ts";

test("each forge states which pull request writes it offers", () => {
  assert.equal(Object.values(pullCapabilities("github")).every(Boolean), true);
  assert.equal(Object.values(pullCapabilities("gitea")).every(Boolean), true);
  assert.deepEqual(Object.entries(pullCapabilities("gitlab")).filter(([, ok]) => !ok).map(([name]) => name), ["requestChanges"]);
  assert.deepEqual(Object.entries(pullCapabilities("azure")).filter(([, ok]) => !ok).map(([name]) => name), ["lineComment", "draft", "patch"]);
  assert.equal(pullLimitation("gitlab", "requestChanges"), "GitLab's API has no request-changes review; leave a comment or withhold approval.");
  assert.equal(pullLimitation("github", "merge"), null);
});
