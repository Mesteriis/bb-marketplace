import { expect, it } from "vitest";
import { createJiraClient } from "./jira.ts";
import { groupTasksByProject, projectKeyForTask } from "./projects.ts";
import { defaultJql } from "./sync.ts";

it("fetches assigned work across projects even for existing scoped connections", () => {
  expect(defaultJql({ projectKey: "OLD", jql: "project = OLD" })).toBe(
    "assignee = currentUser() ORDER BY project ASC, updated DESC",
  );
});

it.each(["cloud", "server"] as const)("loads assigned %s issues beyond the former 200 issue cap", async (edition) => {
  const client = createJiraClient({ edition, baseUrl: "https://example.atlassian.net", authHeader: "Basic synthetic" }, async (_url, init) => {
    const body = JSON.parse(String(init.body));
    const page = edition === "cloud" ? Number(body.nextPageToken ?? 0) : body.startAt / 50;
    return new Response(JSON.stringify({
      issues: Array.from({ length: 50 }, (_, i) => ({ key: `P-${page * 50 + i + 1}`, fields: { summary: "Assigned" } })),
      nextPageToken: page < 4 ? String(page + 1) : null,
      total: 250,
    }), { status: 200 });
  });
  const result = await client.listIssues("assignee = currentUser()");
  expect(result.issues).toHaveLength(250);
  expect(result.truncated).toBe(false);
});

it("groups issue keys by project and keeps local work separate", () => {
  const tasks = [
    { origin: "jira" as const, originKey: "WEB-2" },
    { origin: "local" as const, originKey: null },
    { origin: "jira" as const, originKey: "API-1" },
  ];
  expect(projectKeyForTask(tasks[0])).toBe("WEB");
  expect(groupTasksByProject(tasks).map((group) => group.project)).toEqual(["API", "WEB", "Local tasks"]);
});

it("refuses a repeated Cloud pagination token instead of hanging", async () => {
  const client = createJiraClient({ edition: "cloud", baseUrl: "https://example.atlassian.net", authHeader: "Basic synthetic" }, async () => new Response(JSON.stringify({
    issues: [{ key: "P-1", fields: { summary: "Assigned" } }], nextPageToken: "same",
  }), { status: 200 }));
  await expect(client.listIssues("assignee = currentUser()")).rejects.toThrow(/pagination/i);
});

it("refuses Server pagination that reports more results but makes no progress", async () => {
  const client = createJiraClient({ edition: "server", baseUrl: "https://jira.example.com", authHeader: "Bearer synthetic" }, async () => new Response(JSON.stringify({
    issues: [], total: 5,
  }), { status: 200 }));
  await expect(client.listIssues("assignee = currentUser()")).rejects.toThrow(/pagination/i);
});
