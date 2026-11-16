import { describe, expect, it } from "vitest";
import { DomainError } from "./errors.ts";
import { base64, basicAuth, createJiraClient, type FetchLike } from "./jira.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function issue(key: string, summary: string, statusName: string) {
  return {
    key,
    fields: {
      summary,
      status: { name: statusName, id: "10000" },
      issuetype: { name: "Task" },
      labels: ["frontend"],
      assignee: { displayName: "Ann" },
    },
  };
}

const cloudAuth = { edition: "cloud" as const, baseUrl: "https://example.atlassian.net", authHeader: "Basic x" };
const serverAuth = { edition: "server" as const, baseUrl: "https://jira.example.com/context", authHeader: "Bearer tok" };

describe("base64 and basicAuth", () => {
  it("encodes UTF-8 to base64", () => {
    expect(base64(new TextEncoder().encode("user:pass"))).toBe("dXNlcjpwYXNz");
  });
  it("builds a Basic auth header", () => {
    expect(basicAuth("user", "pass")).toBe("Basic dXNlcjpwYXNz");
  });
});

describe("cloud pagination", () => {
  it("follows nextPageToken and stops when it is absent", async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const fetchFn: FetchLike = async (url, init) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      calls.push({ url, body });
      if (body.nextPageToken === "t2") {
        return jsonResponse({ issues: [issue("B-2", "Two", "In progress")], nextPageToken: null, total: 2 });
      }
      return jsonResponse({ issues: [issue("B-1", "One", "To do")], nextPageToken: "t2", total: 2 });
    };
    const client = createJiraClient(cloudAuth, fetchFn);
    const result = await client.listIssues("project = B", { maxResults: 10 });
    expect(result.issues.map((entry) => entry.key)).toEqual(["B-1", "B-2"]);
    expect(result.total).toBeNull();
    expect(result.truncated).toBe(false);
    expect(calls.length).toBe(2);
    expect(calls[0].url).toBe("https://example.atlassian.net/rest/api/3/search/jql");
    expect(calls[1].body.nextPageToken).toBe("t2");
  });
});

describe("server pagination", () => {
  it("follows startAt and stops at total", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchFn: FetchLike = async (url, init) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      bodies.push(body);
      if (body.startAt === 0) {
        return jsonResponse({ issues: [issue("S-1", "One", "To do"), issue("S-2", "Two", "To do")], startAt: 0, maxResults: 2, total: 3 });
      }
      return jsonResponse({ issues: [issue("S-3", "Three", "Done")], startAt: 2, maxResults: 2, total: 3 });
    };
    const client = createJiraClient(serverAuth, fetchFn);
    const result = await client.listIssues("project = S", { maxResults: 10 });
    expect(result.issues.map((entry) => entry.key)).toEqual(["S-1", "S-2", "S-3"]);
    expect(result.total).toBe(3);
    expect(bodies.map((body) => body.startAt)).toEqual([0, 2]);
  });
});

describe("redirect and error safety", () => {
  it("sends redirect: error so auth is never forwarded", async () => {
    const inits: RequestInit[] = [];
    const fetchFn: FetchLike = async (url, init) => {
      inits.push(init);
      throw new Error("unexpected redirect");
    };
    const client = createJiraClient(cloudAuth, fetchFn);
    await expect(client.myself()).rejects.toMatchObject({ kind: "network" });
    expect(inits.length).toBeGreaterThan(0);
    expect(inits.every((init) => init.redirect === "error")).toBe(true);
  });

  it("maps 401 to a sanitized auth error", async () => {
    const client = createJiraClient(cloudAuth, async () => jsonResponse({ message: "secret" }, 401));
    await expect(client.myself()).rejects.toMatchObject({ kind: "auth", message: "Authentication failed" });
  });

  it("never embeds the response body in an HTTP error", async () => {
    const client = createJiraClient(cloudAuth, async () => jsonResponse({ detail: "internal credentials" }, 500));
    const error = await client.myself().catch((value: unknown) => value) as DomainError;
    expect(error.kind).toBe("http");
    expect(error.message).toBe("Request failed (HTTP 500)");
    expect(error.message).not.toContain("credentials");
  });
});

describe("transitions", () => {
  it("lists transitions and applies one", async () => {
    const calls: { url: string; method: string; body: Record<string, unknown> }[] = [];
    const fetchFn: FetchLike = async (url, init) => {
      calls.push({ url, method: init.method ?? "GET", body: init.body ? JSON.parse(String(init.body)) : {} });
      if (init.method === "POST") return new Response(null, { status: 204 });
      return jsonResponse({ transitions: [{ id: "31", name: "Start", to: { name: "In progress" } }] });
    };
    const client = createJiraClient(serverAuth, fetchFn);
    const transitions = await client.getTransitions("S-1");
    expect(transitions).toEqual([{ id: "31", name: "Start", toName: "In progress" }]);
    await client.transition("S-1", "31");
    expect(calls[1].url).toBe("https://jira.example.com/context/rest/api/2/issue/S-1/transitions");
    expect(calls[1].method).toBe("POST");
    expect(calls[1].body).toEqual({ transition: { id: "31" } });
  });
});
