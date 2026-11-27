import test from "node:test";
import assert from "node:assert/strict";
import { ciCapabilities, ciLimitation } from "../src/core/ci/capabilities.ts";
import { failureKey, newFailures } from "../src/core/ci/watch.ts";
import { ciAction, describeAction } from "../src/core/ci/actions.ts";
import type { Run } from "../src/core/ci/model.ts";

test("each forge states which CI operations it offers", () => {
  assert.deepEqual(ciCapabilities("github"), {dispatch: true, dispatchInputs: true, rerunFailed: true, rerunAll: true, cancel: true, liveLog: false});
  assert.deepEqual(ciCapabilities("azure"), {dispatch: true, dispatchInputs: false, rerunFailed: true, rerunAll: true, cancel: true, liveLog: true});
  assert.equal(ciCapabilities("gitlab").dispatch, false);
  assert.equal(ciLimitation("github", "liveLog"), "GitHub publishes a job log when the job ends.");
  assert.equal(ciLimitation("azure", "dispatchInputs"), "Azure runtime parameters are not supported; the pipeline runs with its defaults.");
  assert.equal(ciLimitation("gitea", "cancel"), null);
});

const run = (id: string, state: Run["state"], attempt = 1, updatedAt: string | null = null): Run => ({id, number: Number(id), workflow: "CI", workflowId: null, title: "", branch: "main",
  sha: null, event: "push", state, attempt, createdAt: "2026-11-27T10:00:00Z", updatedAt, url: null, actor: null});

test("the first look only records failures; later looks report each new failed attempt once", () => {
  const first = newFailures(null, [run("1", "failure"), run("2", "success")]);
  assert.deepEqual(first.failed, []);
  const second = newFailures(first.seen, [run("3", "failure"), run("1", "failure"), run("1", "failure", 2), run("4", "running")]);
  assert.deepEqual(second.failed.map(item => item.id + "#" + item.attempt), ["3#1", "1#2"]);
  assert.deepEqual(newFailures(second.seen, [run("3", "failure")]).failed, []);
  const many = Array.from({length: 300}, (_, i) => run(String(i), "failure"));
  assert.equal(newFailures([], many).seen.length, 200);
});

test("write actions are validated and described for confirmation", () => {
  assert.equal(ciAction.safeParse({kind: "rerun", runId: "9", failedOnly: true}).success, true);
  assert.equal(ciAction.safeParse({kind: "dispatch", workflowId: "ci.yml", ref: "main", inputs: {outcome: "x".repeat(5000)}}).success, false);
  assert.equal(ciAction.safeParse({kind: "dispatch", workflowId: "ci.yml", ref: "-oops", inputs: {}}).success, false);
  assert.deepEqual(describeAction({kind: "dispatch", workflowId: "ci.yml", ref: "main", inputs: {outcome: "failure", slow: "true"}}, "CI"),
    ["Run workflow CI on main", "outcome = failure", "slow = true"]);
  assert.deepEqual(describeAction({kind: "rerun", runId: "9", failedOnly: true}, "CI #7"), ["Re-run failed jobs of CI #7"]);
  assert.deepEqual(describeAction({kind: "rerun", runId: "9", failedOnly: false}, "CI #7"), ["Re-run all jobs of CI #7"]);
  assert.deepEqual(describeAction({kind: "cancel", runId: "9"}, "CI #7"), ["Cancel CI #7"]);
});

test("a retried run that fails again under the same id and attempt is a new failure", () => {
  const first = newFailures([], [run("501", "failure", 1, "2026-11-27T10:03:00Z")]);
  assert.equal(first.failed.length, 1);
  assert.equal(newFailures(first.seen, [run("501", "failure", 1, "2026-11-27T10:03:00Z")]).failed.length, 0);
  assert.equal(newFailures(first.seen, [run("501", "failure", 1, "2026-11-27T10:20:00Z")]).failed.length, 1);
  assert.equal(failureKey(run("501", "failure", 1, "2026-11-27T10:20:00Z")), "501#1#2026-11-27T10:20:00Z");
});
