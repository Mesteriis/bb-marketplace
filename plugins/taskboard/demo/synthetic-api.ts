// Builds a TaskboardApi from the real core, wired to in-memory fakes and a
// canned Jira fetch. The real src/ui runs against this, so pointer and
// keyboard flows exercise the actual logic (no UI mock). Dev-only.
import {
  prepareWorklog,
  applyTransition,
  createBoard,
  createConnection,
  createTask,
  deleteBoard,
  deleteConnection,
  deleteTask,
  fetchIssues,
  jiraClientFor,
  listBoards,
  listConnections,
  listTasks,
  moveTask,
  updateBoard,
  updateConnection,
  updateTask,
  cancelRun,
  completeRun,
  listPendingTimeEntries,
  listRunsForTask,
  submitTimeEntry,
  takeIntoWork,
  resolveTimeEntry,
  retryTimeEntry,
  updateTimeEntry,
  type FetchLike,
  type LifecycleDeps,
} from "../src/core/index.ts";
import { createFakeClock, createFakeCredentials, createFakeId, createFakeLifecycleStore, createFakeProjects, createFakeRunSpawner, createFakeStore, createFakeWorklogSink } from "../src/core/testing/fakes.ts";
import type { TaskboardApi } from "../src/ui/api.ts";

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

function issue(key: string, summary: string, statusName: string, labels: string[], description: string) {
  return { key, fields: { summary, status: { name: statusName, id: "1" }, issuetype: { name: "Task" }, labels, assignee: { displayName: "Demo User" }, description } };
}

function demoJiraFetch(): FetchLike {
  return async (url, init) => {
    const method = init.method ?? "GET";
    if (url.includes("/myself")) return json({ displayName: "Demo User" });
    if (url.includes("/search")) {
      return json({
        issues: [
          issue("DEMO-101", "Ship mobile onboarding", "To do", ["mobile", "growth"], "Onboard new users in three clear steps."),
          issue("DEMO-102", "Migrate auth to OIDC", "In progress", ["security"], "Replace the legacy session store with OIDC."),
          issue("API-201", "Improve API error handling", "To do", ["platform"], "Return actionable errors to API clients."),
          issue("DEMO-103", "Deprecate legacy API", "Done", ["platform"], "Mark the v1 endpoints deprecated and document the migration."),
        ],
        nextPageToken: null,
      });
    }
    if (url.includes("/transitions") && method === "GET") {
      return json({ transitions: [
        { id: "11", name: "Start", to: { name: "In progress" } },
        { id: "21", name: "Complete", to: { name: "Done" } },
        { id: "31", name: "Reopen", to: { name: "To do" } },
      ] });
    }
    if (url.includes("/transitions") && method === "POST") return new Response(null, { status: 204 });
    throw new Error("unexpected " + url);
  };
}

export async function buildDemoApi(): Promise<TaskboardApi> {
  const store = createFakeStore();
  const credentials = createFakeCredentials();
  const idgen = createFakeId();
  const clock = createFakeClock(new Date("2026-06-01T09:00:00.000Z"));
  const boardDeps = { store, idgen, clock };
  const connectionDeps = { store, credentials, idgen, clock };
  const fetchFn = demoJiraFetch();
  const syncDeps = { store, credentials, idgen, clock, fetchFn };
  const lifecycleDeps: LifecycleDeps = {
    store,
    lifecycle: createFakeLifecycleStore(),
    projects: createFakeProjects(["Demo Project"]),
    runSpawner: createFakeRunSpawner(),
    worklogs: createFakeWorklogSink(),
    credentials,
    clock,
    idgen,
    fetchFn,
  };

  // Seed a local board.
  const local = createBoard("Product", boardDeps);
  createTask({ boardId: local.id, title: "Write the launch blog post", description: "Draft, review and ship before Friday.", status: local.columns[1].id }, boardDeps);
  createTask({ boardId: local.id, title: "Fix checkout race condition", description: "", status: local.columns[0].id }, boardDeps);

  // Seed a Cloud connection and import its canned issues.
  const connection = createConnection({ name: "Atlassian Cloud (demo)", edition: "cloud", baseUrl: "https://demo.atlassian.net", email: "you@example.com", projectKey: "DEMO", jql: "", credential: "demo-token" }, connectionDeps);
  await fetchIssues(connection.id, syncDeps);
  const jiraBoard = store.listBoards().find((board) => board.connectionId === connection.id);
  if (jiraBoard !== undefined) {
    const jiraColumns = store.listColumns(jiraBoard.id);
    createTask({ boardId: jiraBoard.id, title: "Team follow-up on the demo", description: "A local task living on the same board as the imported Jira issues.", status: jiraColumns[0]?.id }, boardDeps);
  }

  return {
    listBoards: () => Promise.resolve(listBoards(boardDeps)),
    listConnections: () => Promise.resolve(listConnections(connectionDeps)),
    listTasks: (boardId) => Promise.resolve(listTasks(boardId, boardDeps)),
    createBoard: (name) => Promise.resolve(createBoard(name, boardDeps)),
    updateBoard: (input) => Promise.resolve(updateBoard(input, boardDeps)),
    deleteBoard: (id) => { deleteBoard(id, boardDeps); return Promise.resolve(); },
    createTask: (input) => Promise.resolve(createTask(input, boardDeps)),
    updateTask: (input) => Promise.resolve(updateTask(input, boardDeps)),
    moveTask: (taskId, status) => moveTask(taskId, status, syncDeps),
    deleteTask: (id) => { deleteTask(id, boardDeps); return Promise.resolve(); },
    createConnection: (input) => Promise.resolve(createConnection(input, connectionDeps)),
    updateConnection: (input) => Promise.resolve(updateConnection(input, connectionDeps)),
    deleteConnection: (id) => { deleteConnection(id, connectionDeps); return Promise.resolve(); },
    testConnection: async (id) => { await jiraClientFor(id, syncDeps).myself(); },
    fetchIssues: (id) => fetchIssues(id, syncDeps),
    listTransitions: (connectionId, issueKey) => jiraClientFor(connectionId, syncDeps).getTransitions(issueKey),
    applyTransition: (connectionId, issueKey, transitionId) => applyTransition(connectionId, issueKey, transitionId, syncDeps),
    listProjects: () => lifecycleDeps.projects.listProjects(),
    takeIntoWork: (input) => takeIntoWork(input, lifecycleDeps),
    cancelRun: (runId) => { cancelRun(runId, lifecycleDeps); return Promise.resolve(); },
    listRuns: (taskId) => Promise.resolve(listRunsForTask(taskId, lifecycleDeps)),
    completeRun: (input) => completeRun(input, lifecycleDeps),
    updateTimeEntry: (input) => Promise.resolve(updateTimeEntry(input, lifecycleDeps)),
    prepareWorklog: (input) => Promise.resolve(prepareWorklog(input, lifecycleDeps)),
    listWorklogs: (taskId) => Promise.resolve(lifecycleDeps.lifecycle.listWorklogsForTask(taskId)),
    submitTimeEntry: (input) => submitTimeEntry(input, lifecycleDeps),
    listPendingTimeEntries: () => Promise.resolve(listPendingTimeEntries(lifecycleDeps)),
    listTimeEntriesByTask: (taskId) => Promise.resolve(lifecycleDeps.lifecycle.listTimeEntriesByTask(taskId)),
    retryTimeEntry: (entryId) => Promise.resolve(retryTimeEntry(entryId, lifecycleDeps)),
    resolveTimeEntry: (input) => Promise.resolve(resolveTimeEntry(input, lifecycleDeps)),
  };
}
