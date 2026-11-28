import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Run } from "../src/core/ci/model.ts";
import { filterLines } from "../src/core/ci/log.ts";
import { ciSummary, elapsed } from "../src/core/ci/summary.ts";

const run = (id: string, state: Run["state"], extra: Partial<Run> = {}): Run => ({
  id, number: 1, workflow: "CI", workflowId: "1", title: "", branch: "main", sha: null, event: "push",
  state, attempt: 1, createdAt: "2026-11-27T10:00:00Z", updatedAt: null, url: null, actor: null, ...extra,
});

describe("ciSummary", () => {
  it("counts running, queued (with stage waits) and failed runs and the success rate of finished ones", () => {
    const summary = ciSummary([run("1", "running"), run("2", "queued"), run("3", "waiting"), run("4", "failure"),
      run("5", "success"), run("6", "success"), run("7", "success"), run("8", "cancelled")]);
    assert.deepEqual(summary, {running: 1, queued: 2, failed: 1, successRate: 75, total: 8});
  });
  it("has no success rate before anything finished as success or failure", () => {
    assert.equal(ciSummary([run("1", "running"), run("2", "cancelled")]).successRate, null);
  });
});

describe("elapsed", () => {
  const now = Date.parse("2026-11-27T10:05:07Z");
  it("runs from the start to now while active", () => {
    assert.equal(elapsed(run("1", "running"), now), "5m 7s");
  });
  it("stops at the last update once finished", () => {
    assert.equal(elapsed(run("1", "success", {updatedAt: "2026-11-27T11:02:00Z"}), now), "1h 2m");
  });
  it("shows seconds alone under a minute and nothing for a broken date", () => {
    assert.equal(elapsed(run("1", "running", {createdAt: "2026-11-27T10:04:59Z"}), now), "8s");
    assert.equal(elapsed(run("1", "running", {createdAt: "not a date"}), now), null);
  });
  it("shows nothing for a finished run without an end", () => {
    assert.equal(elapsed(run("1", "failure"), now), null);
  });
});

describe("filterLines", () => {
  const lines = ["Setting up", "npm ERR! missing script", "Test passed", "error: Missing file"];
  it("keeps the numbers of lines containing every word, ignoring case", () => {
    assert.deepEqual(filterLines(lines, "missing"), [1, 3]);
    assert.deepEqual(filterLines(lines, "MISSING script"), [1]);
  });
  it("keeps every line for an empty filter and reads symbols literally", () => {
    assert.deepEqual(filterLines(lines, " "), [0, 1, 2, 3]);
    assert.deepEqual(filterLines(lines, "ERR!"), [1]);
    assert.deepEqual(filterLines(lines, ".*"), []);
  });
});

describe("elapsed of a re-run", () => {
  it("counts from the attempt's own start when the forge gives it", () => {
    const rerun = run("1", "success", {attempt: 2, createdAt: "2026-11-20T10:00:00Z", startedAt: "2026-11-27T10:00:00Z", updatedAt: "2026-11-27T10:04:00Z"});
    assert.equal(elapsed(rerun, Date.parse("2026-11-27T12:00:00Z")), "4m 0s");
  });
});

describe("runSeconds and jobSeconds", async () => {
  const { runSeconds, jobSeconds } = await import("../src/core/ci/summary.ts");
  const now = Date.parse("2026-11-27T10:05:07Z");
  const job = (extra: Partial<import("../src/core/ci/model.ts").Job>) => ({id: "j", name: "test", state: "success" as const, startedAt: null, completedAt: null, url: null, steps: [], ...extra});
  it("counts a run's seconds to now while active and to its last update once finished", () => {
    assert.equal(runSeconds(run("1", "running"), now), 307);
    assert.equal(runSeconds(run("1", "success", {updatedAt: "2026-11-27T10:02:14Z"}), now), 134);
    assert.equal(runSeconds(run("1", "failure"), now), null);
  });
  it("counts a job's seconds from its start to its end, or to now while it runs; none before it starts", () => {
    assert.equal(jobSeconds(job({startedAt: "2026-11-27T10:00:00Z", completedAt: "2026-11-27T10:00:42Z"}), now), 42);
    assert.equal(jobSeconds(job({state: "running", startedAt: "2026-11-27T10:05:00Z"}), now), 7);
    assert.equal(jobSeconds(job({state: "queued"}), now), null);
    assert.equal(jobSeconds(job({startedAt: "2026-11-27T10:00:00Z"}), now), null);
  });
});
