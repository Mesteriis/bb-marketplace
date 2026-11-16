import { describe, expect, it } from "vitest";
import { createJiraClient, type FetchLike } from "./jira.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("Jira worklog", () => {
  it("a network failure is a network DomainError (ambiguous)", async () => {
    const fetchFn: FetchLike = async () => { throw new Error("connection reset"); };
    const client = createJiraClient({ edition: "cloud", baseUrl: "https://example.atlassian.net", authHeader: "Basic x" }, fetchFn);
    await expect(client.submitWorklog({ issueKey: "B-1", timeSpentSeconds: 3600, comment: "", startedAtIso: "2026-06-01T09:00:00.000Z" })).rejects.toMatchObject({ kind: "network" });
  });

  it("a 201 with a lost body is an http DomainError (ambiguous)", async () => {
    const fetchFn: FetchLike = async () => new Response(null, { status: 201 });
    const client = createJiraClient({ edition: "cloud", baseUrl: "https://example.atlassian.net", authHeader: "Basic x" }, fetchFn);
    await expect(client.submitWorklog({ issueKey: "B-1", timeSpentSeconds: 3600, comment: "", startedAtIso: "2026-06-01T09:00:00.000Z" })).rejects.toMatchObject({ kind: "http" });
  });

  it("POSTs a worklog with timeSpentSeconds and started", async () => {
    const calls: { url: string; method: string; body: Record<string, unknown> }[] = [];
    const fetchFn: FetchLike = async (url, init) => {
      calls.push({ url, method: init.method ?? "GET", body: init.body ? JSON.parse(String(init.body)) : {} });
      return jsonResponse({ id: "10001" }, 201);
    };
    const client = createJiraClient({ edition: "cloud", baseUrl: "https://example.atlassian.net", authHeader: "Basic x" }, fetchFn);
    const result = await client.submitWorklog({ issueKey: "B-1", timeSpentSeconds: 3600, comment: "worked", startedAtIso: "2026-06-01T09:00:00.000Z" });
    expect(result.id).toBe("10001");
    expect(calls[0].url).toBe("https://example.atlassian.net/rest/api/3/issue/B-1/worklog");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].body.timeSpentSeconds).toBe(3600);
    expect(calls[0].body.started).toBe("2026-06-01T09:00:00.000+0000");
    expect(calls[0].body.comment).toEqual({ type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "worked" }] }] });
  });
});
