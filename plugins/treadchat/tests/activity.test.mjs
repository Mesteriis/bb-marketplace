import test from "node:test";
import assert from "node:assert/strict";
import { activity, viewedThrough } from "../src/core/activity.ts";

const base = { seq: 29, createdAt: 100 };

test("a message reporting success remains an agent statement", () => {
  const result = activity({ ...base, type: "item/completed", data: {
    item: { type: "agentMessage", text: "All tests passed." },
  } });
  assert.equal(result.kind, "agent");
  assert.equal(result.detail, "All tests passed.");
});

test("a recorded exit code is distinct from chat and routine commands are omitted", () => {
  const run = (command, exitCode) => activity({ ...base, type: "item/completed", data: {
    item: { type: "commandExecution", command, exitCode },
  } });
  assert.equal(run("npm run check", 0).title, "Проверка · код выхода 0");
  assert.equal(run("npm run check", 2).title, "Команда завершилась с кодом 2");
  assert.equal(run("rg TODO", 0), null);
  assert.equal(run("npm run check"), null);
});

test("hidden reasoning is absent from the overview", () => {
  assert.equal(activity({ ...base, type: "item/completed", data: {
    item: { type: "reasoning", content: ["private"] },
  } }), null);
});

test("acknowledgement cannot skip a fetched but undisplayed event", () => {
  assert.equal(viewedThrough(15, [{seq: 19}, {seq: 21}]), 21);
  assert.equal(viewedThrough(21, [{seq: 19}]), 21);
  assert.equal(viewedThrough(21, []), 21);
});

test("BB normalizes a legacy plan into planSteps; the overview displays the active step", () => {
  const result = activity({ ...base, type: "item/completed", data: {
    item: { type: "planSteps", steps: [
      { step: "Inspect", status: "completed" },
      { step: "Verify", status: "active" },
      { step: "Deliver", status: "pending" },
    ] },
  } });
  assert.equal(result.kind, "plan");
  assert.equal(result.detail, "Verify");
});
