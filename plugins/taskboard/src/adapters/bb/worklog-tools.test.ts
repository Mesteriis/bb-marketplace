import { expect, it } from "vitest";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createBoard, createTask, type LifecycleDeps } from "../../core/index.ts";
import { createFakeClock, createFakeCredentials, createFakeId, createFakeLifecycleStore, createFakeProjects, createFakeRunSpawner, createFakeStore, createFakeWorklogSink } from "../../core/testing/fakes.ts";
import { registerWorklogTools } from "./worklog-tools.ts";

it("agent tools discover tasks and log one validated time entry", async () => {
  const deps: LifecycleDeps = { store: createFakeStore(), lifecycle: createFakeLifecycleStore(), clock: createFakeClock(), idgen: createFakeId(), credentials: createFakeCredentials(), projects: createFakeProjects(), runSpawner: createFakeRunSpawner(), worklogs: createFakeWorklogSink() };
  const handlers = new Map<string, (input: unknown) => Promise<unknown>>();
  const bb = { agents: { registerTool: (tool: { name: string; execute: (input: unknown) => Promise<unknown> }) => handlers.set(tool.name, tool.execute) } } as unknown as BbPluginApi;
  const names = registerWorklogTools(bb, deps);
  expect(names).toEqual(["boards_list", "tasks_list", "worklog_prepare", "worklog_submit", "worklogs_list", "time_entries_by_task"]);
  const board = createBoard("Test", deps);
  const task = createTask({ boardId: board.id, title: "Investigate" }, deps);
  expect(JSON.parse(await handlers.get("tasks_list")!({ boardId: board.id }) as string).tasks[0].id).toBe(task.id);
  expect(await handlers.get("worklog_prepare")!({ taskId: task.id, durationSeconds: 600, comment: "Checked" })).toMatchObject({ isError: true });
  await handlers.get("worklog_prepare")!({ taskId: task.id, entryId: "agent-entry", durationSeconds: 600, comment: "Checked" });
  const input = { entryId: "agent-entry", durationSeconds: 600, comment: "Checked" };
  expect(JSON.parse(await handlers.get("worklog_submit")!(input) as string).durationSeconds).toBe(600);
  expect(await handlers.get("worklog_submit")!(input)).toMatchObject({ isError: true });
  expect(deps.lifecycle.listWorklogsForTask(task.id)).toHaveLength(1);
});
