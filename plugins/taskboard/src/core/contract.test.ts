import { describe, expect, it } from "vitest";
import { rpcSchemas } from "./contract.ts";

describe("wire schemas", () => {
  it("accepts a valid Cloud connection", () => {
    const result = rpcSchemas.connection_create.input.safeParse({
      name: "J",
      edition: "cloud",
      baseUrl: "https://example.atlassian.net",
      email: "me@example.com",
      projectKey: "B",
      jql: "",
      credential: "tok",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a non-HTTPS base URL", () => {
    const result = rpcSchemas.connection_create.input.safeParse({
      name: "J",
      edition: "server",
      baseUrl: "http://jira.example.com",
      projectKey: "",
      jql: "",
      credential: "pat",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an empty task title", () => {
    const result = rpcSchemas.task_create.input.safeParse({ boardId: "b", title: "   " });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown edition", () => {
    const result = rpcSchemas.connection_create.input.safeParse({
      name: "J",
      edition: "other",
      baseUrl: "https://jira.example.com",
      credential: "t",
    });
    expect(result.success).toBe(false);
  });

  it("requires a credential on connection create", () => {
    const result = rpcSchemas.connection_create.input.safeParse({
      name: "J",
      edition: "cloud",
      baseUrl: "https://example.atlassian.net",
      email: "me@example.com",
    });
    expect(result.success).toBe(false);
  });
});
