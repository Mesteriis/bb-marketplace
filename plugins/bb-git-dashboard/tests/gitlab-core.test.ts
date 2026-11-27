import test from "node:test";
import assert from "node:assert/strict";
import { gitlabState } from "../src/core/ci/state.ts";
import { cleanLog, errorLine } from "../src/core/ci/log.ts";
import { gitlabDispatchSpec } from "../src/core/ci/dispatch.ts";

test("GitLab pipeline and job statuses map to the common states", () => {
  for (const status of ["created", "waiting_for_resource", "preparing", "pending", "scheduled", "manual"]) assert.equal(gitlabState(status), "queued", status);
  assert.equal(gitlabState("running"), "running");
  assert.equal(gitlabState("success"), "success");
  assert.equal(gitlabState("failed"), "failure");
  assert.equal(gitlabState("canceled"), "cancelled");
  assert.equal(gitlabState("canceling"), "running");
  assert.equal(gitlabState("skipped"), "skipped");
  assert.equal(gitlabState("something-new"), "neutral");
});

test("GitLab trace section markers are removed and the job's own error is found", () => {
  const trace = "section_start:1700000000:step_script\r\u001b[0K\u001b[0K\u001b[36;1mExecuting \"step_script\"\u001b[0;m\n$ test -f src/greeting.txt\nERROR: greeting is missing\nsection_end:1700000001:step_script\r\u001b[0K\n\u001b[31;1mERROR: Job failed: exit code 1\n\u001b[0;m";
  const lines = cleanLog(trace).split("\n");
  assert.equal(lines[0], "Executing \"step_script\"");
  assert.equal(lines.some(line => line.startsWith("section_")), false);
  assert.equal(lines[errorLine(lines)!], "ERROR: greeting is missing");
  assert.equal(errorLine(["$ make", "ERROR: Job failed: exit code 2"]), 1);
});

test("the Run pipeline form comes from prefilled variables with descriptions", () => {
  const ci = {variables: {
    DEPLOY_ENV: {value: "staging", options: ["staging", "production"], description: "Where to deploy"},
    MESSAGE: {value: "hi", description: "Greeting"},
    INTERNAL: "not offered",
    PLAIN: {value: "x"},
  }, test: {script: ["true"]}};
  assert.deepEqual(gitlabDispatchSpec(ci), {dispatchable: true, inputs: [
    {name: "DEPLOY_ENV", description: "Where to deploy", required: false, type: "choice", default: "staging", options: ["staging", "production"]},
    {name: "MESSAGE", description: "Greeting", required: false, type: "string", default: "hi", options: []},
  ]});
  assert.deepEqual(gitlabDispatchSpec(null), {dispatchable: true, inputs: []});
});
