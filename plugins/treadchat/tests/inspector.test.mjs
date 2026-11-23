import test from "node:test";
import assert from "node:assert/strict";
import { activity } from "../src/core/activity.ts";
import { inspectorActivity } from "../src/core/inspector.ts";

const inspect = events => inspectorActivity(events.flatMap(event => activity(event) ?? []));

const item = (seq, data) => ({ seq, type: "item/completed", createdAt: 100, data: {item: data} });

test("inspector keeps the latest source per changed file and explicit agent decisions", () => {
  const change = (seq, status, ...paths) => item(seq, {type: "fileChange", status, changes: paths.map(path => ({path}))});
  assert.deepEqual(inspect([
    change(15, "completed", "one.ts"),
    item(13, {type:"agentMessage",text:"Fixed one thing."}),
    item(7, {type:"agentMessage",text:"**Решение:** Используем штатный ввод.\nПричина ниже."}),
    change(20, "failed", "other.ts"),
    change(10, "completed", "one.ts", "two.ts"),
    item(22, {type:"commandExecution",command:"npm run check",exitCode:0}),
  ]), {
    decisions: [{seq:7, title:"Используем штатный ввод."}],
    artifacts: [{seq:15, title:"one.ts"},{seq:10,title:"two.ts"}],
    check: {seq:22,title:"Проверка · код выхода 0"},
  });
});

test("inspector bounds lists and preserves the newest source", () => {
  const events = Array.from({length:10}, (_, i) => item(i + 1, {type:"agentMessage",text:"Decision: Choice " + (i + 1)}));
  assert.deepEqual(inspect(events).decisions, [
    {seq:10,title:"Choice 10"}, {seq:9,title:"Choice 9"}, {seq:8,title:"Choice 8"}, {seq:7,title:"Choice 7"},
  ]);
});
