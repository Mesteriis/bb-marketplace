// Makosh Taskboard — BB frontend entry.
//
// Compiled by `bb plugin build` into dist/app.js. React and
// @get-bb/plugin-sdk/app are provided by the BB app at load time. This file
// is the BB adapter: it binds RPC into a plain TaskboardApi and hands it to
// the host-agnostic page in src/ui, which never calls the host.
import { useMemo } from "react";
import { definePluginApp, useBbNavigate, useRpc, type PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "./server.ts";
import type { Notify, TaskboardApi } from "./src/ui/api.ts";
import { TaskboardPage } from "./src/ui/taskboard-page.tsx";

function TaskboardPanel(_props: PluginNavPanelProps) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();

  const notify: Notify = useMemo(() => (kind, message) => {
    if (kind === "error") toast.error(message);
    else if (kind === "success") toast.success(message);
    else toast.info(message);
  }, []);

  const api: TaskboardApi = useMemo<TaskboardApi>(() => ({
    listBoards: () => rpc.call("boards_list", {}).then((result) => result.boards),
    listConnections: () => rpc.call("connections_list", {}).then((result) => result.connections),
    listTasks: (boardId) => rpc.call("tasks_list", { boardId }),
    createBoard: (name) => rpc.call("board_create", { name }).then((result) => result.board),
    updateBoard: (input) => rpc.call("board_update", input).then((result) => result.board),
    deleteBoard: (boardId) => rpc.call("board_delete", { boardId }).then(() => undefined),
    createTask: (input) => rpc.call("task_create", input).then((result) => result.task),
    updateTask: (input) => rpc.call("task_update", input).then((result) => result.task),
    moveTask: (taskId, status) => rpc.call("task_move", { taskId, status }).then((result) => result.task),
    deleteTask: (taskId) => rpc.call("task_delete", { taskId }).then(() => undefined),
    createConnection: (input) => rpc.call("connection_create", input).then((result) => result.connection),
    updateConnection: (input) => rpc.call("connection_update", input).then((result) => result.connection),
    deleteConnection: (connectionId) => rpc.call("connection_delete", { connectionId }).then(() => undefined),
    testConnection: (connectionId) => rpc.call("connection_test", { connectionId }).then(() => undefined),
    fetchIssues: (connectionId) => rpc.call("jira_fetch", { connectionId }),
    listTransitions: (connectionId, issueKey) => rpc.call("transitions_list", { connectionId, issueKey }).then((result) => result.transitions),
    applyTransition: (connectionId, issueKey, transitionId) =>
      rpc.call("jira_transition", { connectionId, issueKey, transitionId }).then((result) => result.task),
    listProjects: () => rpc.call("projects_list", {}).then((result) => result.projects),
    takeIntoWork: (input) => rpc.call("run_take", input).then((result) => result.run),
    cancelRun: (runId) => rpc.call("run_cancel", { runId }).then(() => undefined),
    listRuns: (taskId) => rpc.call("run_list", { taskId }).then((result) => result.runs),
    completeRun: (input) => rpc.call("run_complete", input).then((result) => result.timeEntry),
    updateTimeEntry: (input) => rpc.call("time_entry_update", input).then((result) => result.timeEntry),
    prepareWorklog: (input) => rpc.call("worklog_prepare", input).then((result) => result.timeEntry),
    listWorklogs: (taskId) => rpc.call("worklogs_list", { taskId }).then((result) => result.worklogs),
    submitTimeEntry: (input) => rpc.call("time_entry_submit", input).then((result) => result.worklog),
    listPendingTimeEntries: () => rpc.call("time_entries_pending", {}).then((result) => result.entries),
    listTimeEntriesByTask: (taskId) => rpc.call("time_entries_by_task", { taskId }).then((result) => result.entries),
    retryTimeEntry: (entryId) => rpc.call("time_entry_retry", { entryId }).then((result) => result.timeEntry),
    resolveTimeEntry: (input) => rpc.call("time_entry_resolve", input).then((result) => result.worklog),
  }), [rpc]);

  return <TaskboardPage api={api} notify={notify} openThread={(threadId) => navigate.toThread(threadId)} />;
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "taskboard",
    title: "Taskboard",
    icon: "LayoutGrid",
    path: "taskboard",
    component: TaskboardPanel,
  });
});
