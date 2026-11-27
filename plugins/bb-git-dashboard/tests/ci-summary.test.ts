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
