import test from "node:test";
import assert from "node:assert/strict";
import { gitlabState } from "../src/core/ci/state.ts";
import { cleanLog, errorLine } from "../src/core/ci/log.ts";
import { gitlabDispatchSpec } from "../src/core/ci/dispatch.ts";

test("GitLab pipeline and job statuses map to the common states", () => {
  for (const status of ["created", "waiting_for_resource", "preparing", "pending", "scheduled"]) assert.equal(gitlabState(status), "queued", status);
  // Waiting for someone to start a manual job (a deploy gate) is not a queue: the pipeline stopped there.
  assert.equal(gitlabState("manual"), "neutral");
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

test("a timestamped GitLab trace loses its stream prefixes, and an ERROR line without a colon is the error", () => {
  // As gitlab.com runners print it (live check of makosh-git-sandbox, pipeline 3123039777, job test [2]).
  const trace = [
    "2026-11-27T12:00:01.100000Z 01O $ if [ \"$OUTCOME\" = \"failure\" ] && [ \"$SHARD\" = \"2\" ]; then echo \"ERROR Sandbox failure requested\"; exit 1; fi",
    "2026-11-27T12:00:01.200000Z 01O ERROR Sandbox failure requested",
    "2026-11-27T12:00:01.300000Z 01E+continued on stderr",
    "2026-11-27T12:00:02.000000Z 00O ERROR: Job failed: exit code 1",
  ].join("\n");
  const lines = cleanLog(trace).split("\n");
  assert.deepEqual(lines.slice(1), ["ERROR Sandbox failure requested", "continued on stderr", "ERROR: Job failed: exit code 1"]);
  assert.equal(errorLine(lines), 1);
  // Text that only looks like a prefix keeps it when the line has no timestamp.
  assert.equal(cleanLog("01O is a fine word"), "01O is a fine word");
  // ERROR as part of a longer word is no marker.
  assert.equal(errorLine(["ERRORS: 0", "done"]), null);
});
