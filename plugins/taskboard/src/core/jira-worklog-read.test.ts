import { expect, it } from "vitest";
import { createJiraClient } from "./jira.ts";

it("reads every Jira worklog page for remote verification", async () => {
  const paths: string[] = [];
  const client = createJiraClient({ edition: "server", baseUrl: "https://jira.example.com/jira", authHeader: "Bearer synthetic" }, async (url) => {
    paths.push(url);
    const second = url.includes("startAt=1");
    return new Response(JSON.stringify({ total: 2, worklogs: [{ id: second ? "w2" : "w1", timeSpentSeconds: 30, comment: second ? "agent check" : "UI check" }] }));
  });
  expect(await client.listWorklogs("TEST-67")).toEqual([{ id: "w1", durationSeconds: 30, comment: "UI check" }, { id: "w2", durationSeconds: 30, comment: "agent check" }]);
  expect(paths[1]).toContain("/rest/api/2/issue/TEST-67/worklog?startAt=1");
});

it("treats a rejected worklog HTTP 400 as a known validation failure", async () => {
  const client = createJiraClient({ edition: "server", baseUrl: "https://jira.example.com", authHeader: "Bearer synthetic" }, async () => new Response("{}", { status: 400 }));
  await expect(client.submitWorklog({ issueKey: "TEST-67", timeSpentSeconds: 30, comment: "test", startedAtIso: "2026-11-16T10:00:00.000Z" })).rejects.toMatchObject({ kind: "invalid" });
});
