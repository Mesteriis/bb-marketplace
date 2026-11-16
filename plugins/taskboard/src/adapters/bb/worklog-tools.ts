import { z } from "zod";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { listBoards, listTasks, listWorklogsForTask, prepareWorklog, rpcSchemas, submitTimeEntry, type LifecycleDeps } from "../../core/index.ts";

export function registerWorklogTools(bb: BbPluginApi, deps: LifecycleDeps): string[] {
  const worklogTools = ["boards_list", "tasks_list", "worklog_prepare", "worklog_submit", "worklogs_list", "time_entries_by_task"];
  const tools = [
    { name: "boards_list", description: "List Taskboard boards to discover task IDs." },
    { name: "tasks_list", description: "List tasks in a Taskboard board, including task IDs and Jira issue keys." },
    { name: "worklog_prepare", description: "Prepare a time entry without changing task status or logging time yet. Supply a unique entryId and reuse it for retries. durationSeconds is seconds; comment describes the work. Only submit when authorized by the owner." },
    { name: "worklog_submit", description: "Log the prepared time entry to Jira (or locally). Requires owner authorization. Never retry an unknown result with a new entry ID; inspect time_entries_by_task instead." },
    { name: "worklogs_list", description: "List worklogs recorded through Taskboard for a task." },
    { name: "time_entries_by_task", description: "Inspect pending, submitted, failed or unknown time submissions before any retry." },
  ];
  function register<S extends z.ZodType>(name: string, description: string, parameters: S, invoke: (input: z.infer<S>) => unknown) {
    bb.agents.registerTool({ name, description, parameters, async execute(input) {
      try { return JSON.stringify(await invoke(parameters.parse(input))); }
      catch (error) { return { content: [{ type: "text", text: error instanceof Error ? error.message : "Worklog operation failed" }], isError: true }; }
    } });
  }
  // Bind each schema to its handler before registration; host validation is
  // repeated here so direct adapter calls cannot bypass the wire contract.
  register("boards_list", tools[0].description, rpcSchemas.boards_list.input, () => ({ boards: listBoards(deps) }));
  register("tasks_list", tools[1].description, rpcSchemas.tasks_list.input, ({ boardId }) => listTasks(boardId, deps));
  register("worklog_prepare", tools[2].description, rpcSchemas.worklog_prepare.input.required({ entryId: true }), (input) => ({ timeEntry: prepareWorklog(input, deps) }));
  register("worklog_submit", tools[3].description, rpcSchemas.time_entry_submit.input, (input) => submitTimeEntry(input, deps));
  register("worklogs_list", tools[4].description, rpcSchemas.worklogs_list.input, ({ taskId }) => ({ worklogs: listWorklogsForTask(taskId, deps) }));
  register("time_entries_by_task", tools[5].description, rpcSchemas.time_entries_by_task.input, ({ taskId }) => ({ entries: deps.lifecycle.listTimeEntriesByTask(taskId) }));
  return worklogTools;
}
