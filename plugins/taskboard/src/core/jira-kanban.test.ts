import { expect, it } from "vitest";
import { createJiraKanbanClient } from "./jira-kanban.ts";

it("uses the real board column order and status IDs, not issue status names", async () => {
  const paths: string[] = [];
  const client = createJiraKanbanClient({ edition: "server", baseUrl: "https://jira.example.com/jira", authHeader: "Bearer synthetic" }, async (url) => {
    paths.push(url);
    const config = { id: 7, name: "Delivery", columnConfig: { columns: [
      { name: "Ready", statuses: [{ id: "10" }, { id: "11" }] },
      { name: "Doing", statuses: [{ id: "20" }], max: 4 },
      { name: "Done", statuses: [{ id: "30" }] },
    ] } };
    return new Response(JSON.stringify(url.includes("configuration") ? config : { values: [{ id: 7, name: "Delivery", type: "kanban" }], isLast: true }));
  });
  expect(await client.boards("WEB")).toEqual([{ id: 7, name: "Delivery" }]);
  const columns = await client.columns(7);
  expect(columns.map(c => c.name)).toEqual(["Ready", "Doing", "Done"]);
  expect(columns[0].statusIds).toEqual(["10", "11"]);
  expect(columns[1].max).toBe(4);
  expect(paths[0]).toContain('/jira/rest/agile/1.0/board?');
  expect(paths[0]).toContain('projectKeyOrId=WEB');
});

import { listAssignedJiraProjects, fetchIssues } from "./sync.ts";
import { createConnection } from "./connections.ts";
import { createFakeClock, createFakeCredentials, createFakeId, createFakeStore } from "./testing/fakes.ts";

it("offers only projects with assigned tasks, excluding cached teammate issues", async () => {
  const deps = { store: createFakeStore(), credentials: createFakeCredentials(), idgen: createFakeId(), clock: createFakeClock(), fetchFn: async (url: string) => new Response(JSON.stringify(url.includes("/project/search") ? { values: [{ key: "WEB", name: "Website" }, { key: "API", name: "Backend" }, { key: "OTHER", name: "Other" }], isLast: true } : { issues: [{ key: "WEB-1", fields: { summary: "Mine" } }, { key: "API-1", fields: { summary: "Mine too" } }], nextPageToken: null })) };
  const connection = createConnection({ name: "Jira", edition: "cloud", baseUrl: "https://example.atlassian.net", email: "demo@example.com", projectKey: "", jql: "", credential: "synthetic" }, deps);
  await fetchIssues(connection.id, deps);
  const board = deps.store.listBoards()[0];
  const task = deps.store.listTasks(board.id)[0];
  deps.store.saveTask({ ...task, id: "teammate", originKey: "OTHER-1", inScope: false });
  expect(await listAssignedJiraProjects(connection.id, deps)).toEqual([{ key: "API", name: "Backend" }, { key: "WEB", name: "Website" }]);
});
