import { describe, expect, it } from "vitest";
import { createBoard, createTask, listTasks, updateTask } from "./board.ts";
import { createConnection, updateConnection } from "./connections.ts";
import { rpcSchemas } from "./contract.ts";
import { createJiraClient, type FetchLike } from "./jira.ts";
import { fetchIssues, moveTask } from "./sync.ts";
import { createFakeClock, createFakeCredentials, createFakeId, createFakeStore } from "./testing/fakes.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function makeDeps(fetchFn: FetchLike) {
  const store = createFakeStore();
  const credentials = createFakeCredentials();
  const idgen = createFakeId();
  const clock = createFakeClock();
  const connDeps = { store, credentials, idgen, clock };
  return { store, credentials, connDeps, sync: { store, credentials, idgen, clock, fetchFn } };
}

describe("connection immutability and URL validation", () => {
  it("forbids changing the base URL after create", () => {
    const { connDeps } = makeDeps(async () => jsonResponse({}));
    const connection = createConnection(
      { name: "J", edition: "cloud", baseUrl: "https://example.atlassian.net", email: "m@e.com", projectKey: "", jql: "", credential: "tok" },
      connDeps,
    );
    expect(() => updateConnection({ connectionId: connection.id, baseUrl: "https://other.atlassian.net" }, connDeps)).toThrowError(/Base URL cannot be changed/);
    expect(() => updateConnection({ connectionId: connection.id, edition: "server" }, connDeps)).toThrowError(/Edition cannot be changed/);
  });

  it("rejects non-atlassian or pathed Cloud URLs and accepts a valid one", () => {
    const { connDeps } = makeDeps(async () => jsonResponse({}));
    expect(() =>
      createConnection({ name: "J", edition: "cloud", baseUrl: "https://jira.example.com", email: "m@e.com", projectKey: "", jql: "", credential: "t" }, connDeps),
    ).toThrowError(/atlassian\.net/);
    expect(() =>
      createConnection({ name: "J", edition: "cloud", baseUrl: "https://example.atlassian.net/jira", email: "m@e.com", projectKey: "", jql: "", credential: "t" }, connDeps),
    ).toThrowError(/atlassian\.net/);
    expect(() =>
      createConnection({ name: "J", edition: "cloud", baseUrl: "https://example.atlassian.net", email: "m@e.com", projectKey: "", jql: "", credential: "t" }, connDeps),
    ).not.toThrow();
  });

  it("accepts a Server URL with a context path but rejects userinfo", () => {
    const { connDeps } = makeDeps(async () => jsonResponse({}));
    expect(() =>
      createConnection({ name: "S", edition: "server", baseUrl: "https://jira.example.com/jira", projectKey: "", jql: "", credential: "pat" }, connDeps),
    ).not.toThrow();
    expect(() =>
      createConnection({ name: "S", edition: "server", baseUrl: "https://user:pass@jira.example.com", projectKey: "", jql: "", credential: "pat" }, connDeps),
    ).toThrowError(/HTTPS URL/);
  });
});

describe("Jira import bounds", () => {
  it("bounds labels, status names, transitions and ADF descriptions to the RPC schemas", async () => {
    const longLabel = "x".repeat(120);
    const longStatus = "Status-" + "y".repeat(200);
    const longTransitionName = "z".repeat(200);
    const adf = { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "Hello from ADF" }] }] };
    const client = createJiraClient(
      { edition: "cloud", baseUrl: "https://example.atlassian.net", authHeader: "Basic x" },
      async (url, init) => {
        if (url.includes("/search")) {
          return jsonResponse({
            issues: [{ key: "B-1", fields: { summary: "One", status: { name: longStatus, id: "1" }, issuetype: { name: "Task" }, labels: [longLabel, "ok"], assignee: null, description: adf } }],
            nextPageToken: null,
          });
        }
        if (url.includes("/transitions")) {
          return jsonResponse({ transitions: [{ id: "31", name: longTransitionName, to: { name: longTransitionName } }] });
        }
        return jsonResponse({ displayName: "User" });
      },
    );
    const page = await client.listIssues("project = B");
    expect(page.issues[0].labels.every((label) => label.length <= 60)).toBe(true);
    expect(page.issues[0].statusName.length).toBeLessThanOrEqual(120);
    expect(page.issues[0].description).toBe("Hello from ADF");
    const transitions = await client.getTransitions("B-1");
    expect(transitions[0].name.length).toBeLessThanOrEqual(120);
    expect(rpcSchemas.transitions_list.output.safeParse({ transitions }).success).toBe(true);
  });
});

describe("fetch scope and schema-safe import", () => {
  it("accepts an empty connection scope for assigned work", async () => {
    const { connDeps, sync } = makeDeps(async () => jsonResponse({ issues: [], nextPageToken: null }));
    const connection = createConnection(
      { name: "J", edition: "cloud", baseUrl: "https://example.atlassian.net", email: "m@e.com", projectKey: "", jql: "", credential: "tok" },
      connDeps,
    );
    await expect(fetchIssues(connection.id, sync)).resolves.toMatchObject({ imported: 0 });
  });

  it("imported tasks satisfy the tasks_list output schema", async () => {
    const { connDeps, store, sync } = makeDeps(async () =>
      jsonResponse({
        issues: [{ key: "B-1", fields: { summary: "One", status: { name: "To do", id: "1" }, issuetype: { name: "Task" }, labels: ["a".repeat(99)], assignee: null, description: "body" } }],
        nextPageToken: null,
      }),
    );
    const connection = createConnection(
      { name: "J", edition: "cloud", baseUrl: "https://example.atlassian.net", email: "m@e.com", projectKey: "B", jql: "", credential: "tok" },
      connDeps,
    );
    await fetchIssues(connection.id, sync);
    const board = store.listBoards()[0];
    const result = listTasks(board.id, sync);
    expect(rpcSchemas.tasks_list.output.safeParse(result).success).toBe(true);
  });
});

describe("read-only Jira tasks and case-insensitive transitions", () => {
  it("refuses to edit an imported Jira task", () => {
    const { connDeps, sync } = makeDeps(async () => jsonResponse({ issues: [], nextPageToken: null }));
    const board = createBoard("B", sync);
    const task = createTask({ boardId: board.id, title: "local" }, sync);
    // Turn it into a Jira task by rewriting its row.
    sync.store.saveTask({ ...task, origin: "jira", originKey: "B-9" });
    expect(() => updateTask({ taskId: task.id, title: "edited" }, sync)).toThrowError(/read-only/);
  });

  it("matches transitions by status name ignoring case", async () => {
    const posted: string[] = [];
    const { connDeps, store, sync } = makeDeps(async (url, init) => {
      const method = init.method ?? "GET";
      if (url.includes("/search")) {
        return jsonResponse({ issues: [{ key: "B-1", fields: { summary: "One", status: { name: "To do", id: "1" }, issuetype: { name: "Task" }, labels: [], assignee: null, description: "" } }], nextPageToken: null });
      }
      if (url.includes("/transitions") && method === "GET") {
        return jsonResponse({ transitions: [{ id: "11", name: "Start", to: { name: "IN PROGRESS" } }] });
      }
      if (url.includes("/transitions") && method === "POST") {
        posted.push("B-1");
        return new Response(null, { status: 204 });
      }
      throw new Error("unexpected " + url);
    });
    const connection = createConnection(
      { name: "J", edition: "cloud", baseUrl: "https://example.atlassian.net", email: "m@e.com", projectKey: "B", jql: "", credential: "tok" },
      connDeps,
    );
    await fetchIssues(connection.id, sync);
    const board = store.listBoards()[0];
    const { tasks, columns } = listTasks(board.id, sync);
    const inProgress = columns.find((column) => column.name.toLowerCase() === "in progress");
    await moveTask(tasks[0].id, inProgress!.id, sync);
    expect(posted).toEqual(["B-1"]);
  });
});

describe("Cloud pagination metadata", () => {
  it("reports a null total and truncated true at the cap", async () => {
    const issue = (key: string) => ({ key, fields: { summary: key, status: { name: "To do" }, issuetype: { name: "Task" }, labels: [], assignee: null } });
    const client = createJiraClient(
      { edition: "cloud", baseUrl: "https://example.atlassian.net", authHeader: "Basic x" },
      async (url, init) => {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        if (body.nextPageToken === "t2") {
          return jsonResponse({ issues: [issue("B-3")], nextPageToken: null });
        }
        return jsonResponse({ issues: [issue("B-1"), issue("B-2")], nextPageToken: "t2" });
      },
    );
    const page = await client.listIssues("project = B", { maxResults: 2 });
    expect(page.total).toBeNull();
    expect(page.truncated).toBe(true);
    expect(page.issues).toHaveLength(2);
  });
});
