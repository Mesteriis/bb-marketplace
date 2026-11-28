import test from "node:test";
import assert from "node:assert/strict";
import { gitlabJobState, gitlabState } from "../src/core/ci/state.ts";
import { isActive } from "../src/core/ci/model.ts";
import { stateText } from "../src/ui/ci/ci-api.ts";
import { format } from "../src/core/i18n/language.ts";
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
  // A timestamped line from another runner that only starts like a stream prefix keeps its text.
  assert.equal(cleanLog("2026-11-27T12:00:01.100000Z 0aEnd of output"), "0aEnd of output");
  // ERROR as part of a longer word is no marker.
  assert.equal(errorLine(["ERRORS: 0", "done"]), null);
});

test("a GitLab job of a stage not reached yet waits for it; a created pipeline is queued", () => {
  // Live check: during a retry the manual deploy job is "created" until the test stage ends.
  assert.equal(gitlabJobState("created"), "waiting");
  assert.equal(gitlabJobState("manual"), "neutral");
  assert.equal(gitlabJobState("failed"), "failure");
  assert.equal(gitlabState("created"), "queued");
  assert.equal(isActive("waiting"), true);
  assert.equal(isActive("queued"), true);
  assert.equal(isActive("neutral"), false);
  const run = {id: "1", number: 1, workflow: "Pipeline", workflowId: "pipeline", title: "main", branch: "main", sha: null, event: null,
    state: "waiting" as const, attempt: 1, createdAt: "2026-11-27T10:00:00Z", updatedAt: "2026-11-27T10:00:00Z", url: null, actor: null};
  const en = (key: Parameters<typeof format>[1], values?: Parameters<typeof format>[2]) => format("en", key, values);
  const ru = (key: Parameters<typeof format>[1], values?: Parameters<typeof format>[2]) => format("ru", key, values);
  // A stage wait is not "queued": it is waiting for the earlier stage, in the words of each language.
  assert.equal(stateText(en, run, Date.parse("2026-11-27T10:30:00Z")), "waiting for a stage");
  assert.equal(stateText(ru, run, Date.parse("2026-11-27T10:30:00Z")), "ждёт стадию");
  // A queued run says how long the forge has kept it.
  assert.equal(stateText(ru, {...run, state: "queued"}, Date.parse("2026-11-27T10:30:00Z")), "в очереди 30 мин");
});
