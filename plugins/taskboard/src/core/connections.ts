// Jira connection lifecycle and auth resolution. The plain credential is
// handed to the CredentialStore exactly once and never returned; the public
// connection record carries only a hasCredential flag. A connection's origin
// (edition + normalized base URL) is immutable after create, so a cached
// board and its issue keys can never be mixed across sites or credentials.
import { DomainError } from "./errors.ts";
import { basicAuth, type JiraAuth } from "./jira.ts";
import {
  isCloudBaseUrl,
  isHttpsUrl,
  normalizeBaseUrl,
  type Connection,
  type ConnectionCreateInput,
  type ConnectionUpdateInput,
} from "./model.ts";
import type { Clock, CredentialStore, IdGenerator, TaskStore } from "./ports.ts";

export interface ConnectionDeps {
  store: TaskStore;
  credentials: CredentialStore;
  idgen: IdGenerator;
  clock: Clock;
}

export function listConnections(deps: ConnectionDeps): Connection[] {
  return deps.store.listConnections();
}

function validateBaseUrl(edition: "cloud" | "server", baseUrl: string): string {
  const normalized = normalizeBaseUrl(baseUrl);
  if (edition === "cloud") {
    if (!isCloudBaseUrl(normalized)) {
      throw new DomainError("invalid", "Cloud connections need an https://<site>.atlassian.net URL without a path");
    }
  } else if (!isHttpsUrl(normalized)) {
    throw new DomainError("invalid", "Must be an HTTPS URL");
  }
  return normalized;
}

export function createConnection(input: ConnectionCreateInput, deps: ConnectionDeps): Connection {
  const now = deps.clock.now().toISOString();
  const id = deps.idgen.newId();
  const edition = input.edition;
  const baseUrl = validateBaseUrl(edition, input.baseUrl);
  const email = edition === "cloud" ? (input.email ?? "").trim() : "";
  const connection: Connection = {
    id,
    name: input.name.trim(),
    edition,
    baseUrl,
    email: email === "" ? null : email,
    projectKey: input.projectKey.trim(),
    jql: input.jql,
    hasCredential: true,
    createdAt: now,
    updatedAt: now,
  };
  deps.store.saveConnection(connection);
  deps.credentials.put(id, input.credential);
  return connection;
}

export function updateConnection(input: ConnectionUpdateInput, deps: ConnectionDeps): Connection {
  const existing = deps.store.getConnection(input.connectionId);
  if (existing === null) throw new DomainError("not_found", "Connection not found");
  if (input.edition !== undefined && input.edition !== existing.edition) {
    throw new DomainError("conflict", "Edition cannot be changed; create a separate connection");
  }
  if (input.baseUrl !== undefined && normalizeBaseUrl(input.baseUrl) !== existing.baseUrl) {
    throw new DomainError("conflict", "Base URL cannot be changed; create a separate connection");
  }
  const edition = existing.edition;
  const email = input.email !== undefined ? input.email : existing.email;
  const connection: Connection = {
    ...existing,
    name: input.name !== undefined ? input.name.trim() : existing.name,
    edition,
    baseUrl: existing.baseUrl,
    email: edition === "cloud" ? (email ?? "").trim() || null : null,
    projectKey: input.projectKey !== undefined ? input.projectKey.trim() : existing.projectKey,
    jql: input.jql !== undefined ? input.jql : existing.jql,
    hasCredential: input.credential !== undefined ? true : existing.hasCredential,
    updatedAt: deps.clock.now().toISOString(),
  };
  deps.store.saveConnection(connection);
  if (input.credential !== undefined) deps.credentials.put(connection.id, input.credential);
  return connection;
}

export function deleteConnection(connectionId: string, deps: ConnectionDeps): void {
  deps.store.deleteConnection(connectionId);
  deps.credentials.delete(connectionId);
}

/** Builds the auth header for a connection, reading the secret server-side. */
export function resolveJiraAuth(connectionId: string, deps: ConnectionDeps): JiraAuth {
  const connection = deps.store.getConnection(connectionId);
  if (connection === null) throw new DomainError("not_found", "Connection not found");
  const secret = deps.credentials.get(connectionId);
  if (secret === null) throw new DomainError("credential_missing", "This connection needs its credential re-entered");
  const authHeader =
    connection.edition === "cloud" ? basicAuth(connection.email ?? "", secret) : "Bearer " + secret;
  return { edition: connection.edition, baseUrl: connection.baseUrl, authHeader };
}
