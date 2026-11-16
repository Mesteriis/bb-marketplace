import { useEffect, useMemo, useRef } from "react";
import type { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../../../server.ts";
import type { TaskboardApi } from "../../ui/api.ts";

export type TaskboardRpc = ReturnType<typeof useRpc<typeof rpcContract>>;

// Host renders may replace the RPC wrapper. Consumers depend on this API's
// identity for loading; transport replacement alone must not reload their data.
export function useTaskboardApi(rpc: TaskboardRpc): TaskboardApi {
  const rpcRef = useRef(rpc);
  useEffect(() => { rpcRef.current = rpc; }, [rpc]);
  const api: TaskboardApi = useMemo<TaskboardApi>(() => ({
    jiraProjects: (connectionId) => rpcRef.current.call("jira_projects", { connectionId }).then(r => r.projects),
    jiraBoards: (connectionId, projectKey) => rpcRef.current.call("jira_boards", { connectionId, projectKey }).then(r => r.boards),
    jiraKanban: (connectionId, projectKey, jiraBoardId) => rpcRef.current.call("jira_kanban", { connectionId, projectKey, jiraBoardId }),
    listBoards: () => rpcRef.current.call("boards_list", {}).then((result) => result.boards),
    listConnections: () => rpcRef.current.call("connections_list", {}).then((result) => result.connections),
    listTasks: (boardId) => rpcRef.current.call("tasks_list", { boardId }),
    createBoard: (name) => rpcRef.current.call("board_create", { name }).then((result) => result.board),
    updateBoard: (input) => rpcRef.current.call("board_update", input).then((result) => result.board),
    deleteBoard: (boardId) => rpcRef.current.call("board_delete", { boardId }).then(() => undefined),
    createTask: (input) => rpcRef.current.call("task_create", input).then((result) => result.task),
    updateTask: (input) => rpcRef.current.call("task_update", input).then((result) => result.task),
    moveTask: (taskId, status) => rpcRef.current.call("task_move", { taskId, status }).then((result) => result.task),
    deleteTask: (taskId) => rpcRef.current.call("task_delete", { taskId }).then(() => undefined),
    createConnection: (input) => rpcRef.current.call("connection_create", input).then((result) => result.connection),
    updateConnection: (input) => rpcRef.current.call("connection_update", input).then((result) => result.connection),
    deleteConnection: (connectionId) => rpcRef.current.call("connection_delete", { connectionId }).then(() => undefined),
    testConnection: (connectionId) => rpcRef.current.call("connection_test", { connectionId }).then(() => undefined),
    fetchIssues: (connectionId) => rpcRef.current.call("jira_fetch", { connectionId }),
    listTransitions: (connectionId, issueKey) => rpcRef.current.call("transitions_list", { connectionId, issueKey }).then((result) => result.transitions),
    applyTransition: (connectionId, issueKey, transitionId) =>
      rpcRef.current.call("jira_transition", { connectionId, issueKey, transitionId }).then((result) => result.task),
    listProjects: () => rpcRef.current.call("projects_list", {}).then((result) => result.projects),
    takeIntoWork: (input) => rpcRef.current.call("run_take", input).then((result) => result.run),
    cancelRun: (runId) => rpcRef.current.call("run_cancel", { runId }).then(() => undefined),
    listRuns: (taskId) => rpcRef.current.call("run_list", { taskId }).then((result) => result.runs),
    completeRun: (input) => rpcRef.current.call("run_complete", input).then((result) => result.timeEntry),
    updateTimeEntry: (input) => rpcRef.current.call("time_entry_update", input).then((result) => result.timeEntry),
    prepareWorklog: (input) => rpcRef.current.call("worklog_prepare", input).then((result) => result.timeEntry),
    listWorklogs: (taskId) => rpcRef.current.call("worklogs_list", { taskId }).then((result) => result.worklogs),
    submitTimeEntry: (input) => rpcRef.current.call("time_entry_submit", input).then((result) => result.worklog),
    listPendingTimeEntries: () => rpcRef.current.call("time_entries_pending", {}).then((result) => result.entries),
    listTimeEntriesByTask: (taskId) => rpcRef.current.call("time_entries_by_task", { taskId }).then((result) => result.entries),
    retryTimeEntry: (entryId) => rpcRef.current.call("time_entry_retry", { entryId }).then((result) => result.timeEntry),
    resolveTimeEntry: (input) => rpcRef.current.call("time_entry_resolve", input).then((result) => result.worklog),
  }), []);
  return api;
}
