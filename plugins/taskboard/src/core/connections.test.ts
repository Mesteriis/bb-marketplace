import { describe, expect, it } from "vitest";
import { createConnection, deleteConnection, listConnections, resolveJiraAuth, updateConnection } from "./connections.ts";
import { DomainError } from "./errors.ts";
import { createFakeClock, createFakeCredentials, createFakeId, createFakeStore } from "./testing/fakes.ts";

function deps() {
  return { store: createFakeStore(), credentials: createFakeCredentials(), idgen: createFakeId(), clock: createFakeClock() };
}

describe("connections", () => {
  it("stores a cloud connection with its email and no secret in the record", () => {
    const d = deps();
    const connection = createConnection(
      { name: "Cloud", edition: "cloud", baseUrl: "https://example.atlassian.net/", email: "me@example.com", projectKey: "B", jql: "", credential: "api-token" },
      d,
    );
    expect(connection.baseUrl).toBe("https://example.atlassian.net");
    expect(connection.email).toBe("me@example.com");
    expect(connection.hasCredential).toBe(true);
    expect(Object.hasOwn(connection, "credential")).toBe(false);
    expect(Object.hasOwn(connection, "apiToken")).toBe(false);
    expect(d.credentials.get(connection.id)).toBe("api-token");
  });

  it("drops the email for a server connection and keeps a context path", () => {
    const d = deps();
    const connection = createConnection(
      { name: "Server", edition: "server", baseUrl: "https://jira.example.com/jira/", projectKey: "", jql: "", credential: "pat" },
      d,
    );
    expect(connection.baseUrl).toBe("https://jira.example.com/jira");
    expect(connection.email).toBeNull();
  });

  it("resolves Basic auth for cloud and Bearer for server", () => {
    const d = deps();
    const cloud = createConnection(
      { name: "Cloud", edition: "cloud", baseUrl: "https://example.atlassian.net", email: "me@example.com", projectKey: "", jql: "", credential: "tok" },
      d,
    );
    const server = createConnection(
      { name: "Server", edition: "server", baseUrl: "https://jira.example.com", projectKey: "", jql: "", credential: "pat" },
      d,
    );
    expect(resolveJiraAuth(cloud.id, d).authHeader).toBe(basicHeader("me@example.com", "tok"));
    expect(resolveJiraAuth(server.id, d).authHeader).toBe("Bearer pat");
  });

  it("refuses auth when no credential is stored", () => {
    const d = deps();
    const connection = createConnection(
      { name: "Cloud", edition: "cloud", baseUrl: "https://example.atlassian.net", email: "me@example.com", projectKey: "", jql: "", credential: "tok" },
      d,
    );
    d.credentials.delete(connection.id);
    expect(() => resolveJiraAuth(connection.id, d)).toThrowError(/needs its credential/);
  });

  it("updates fields and optionally replaces the credential", () => {
    const d = deps();
    const connection = createConnection(
      { name: "Cloud", edition: "cloud", baseUrl: "https://example.atlassian.net", email: "me@example.com", projectKey: "", jql: "", credential: "old" },
      d,
    );
    const updated = updateConnection({ connectionId: connection.id, name: "Renamed" }, d);
    expect(updated.name).toBe("Renamed");
    expect(d.credentials.get(connection.id)).toBe("old");
    updateConnection({ connectionId: connection.id, credential: "new" }, d);
    expect(d.credentials.get(connection.id)).toBe("new");
  });

  it("deletes a connection and its credential", () => {
    const d = deps();
    const connection = createConnection(
      { name: "Cloud", edition: "cloud", baseUrl: "https://example.atlassian.net", email: "me@example.com", projectKey: "", jql: "", credential: "tok" },
      d,
    );
    deleteConnection(connection.id, d);
    expect(listConnections(d)).toHaveLength(0);
    expect(d.credentials.get(connection.id)).toBeNull();
  });
});

// Recomputes the expected Basic header without importing node:crypto in the test.
function basicHeader(user: string, pass: string): string {
  const bytes = new TextEncoder().encode(user + ":" + pass);
  return "Basic " + toBase64(bytes);
}

function toBase64(bytes: Uint8Array): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += chars[b0 >> 2];
    out += chars[((b0 & 3) << 4) | (b1 === undefined ? 0 : b1 >> 4)];
    out += b1 === undefined ? "=" : chars[((b1 & 15) << 2) | (b2 === undefined ? 0 : b2 >> 6)];
    out += b2 === undefined ? "=" : chars[b2 & 63];
  }
  return out;
}
