// Jira REST client for both Cloud and Server/Data Center. Runs over fetch
// (allowed in the core), so a Tauri webview can use the same module. Secrets
// never reach this module: the caller passes a prebuilt Authorization header.
//
// Redirect safety: every request uses redirect: "error", so fetch never
// follows a redirect and can therefore never forward the Authorization header
// to a different origin. Errors are sanitized to fixed strings; no response
// body, URL path or header value is ever embedded in an error.
//
// Imported values are bounded before they are returned, so a hostile or
// misconfigured Jira response can never fail the RPC output schemas.
import { DomainError } from "./errors.ts";
import {
  boundedText,
  DESCRIPTION_MAX,
  ID_MAX,
  ISSUE_KEY_MAX,
  JIRA_FETCH_MAX,
  JIRA_PAGE_MAX,
  LABELS_MAX,
  LABEL_MAX,
  NAME_MAX,
  TITLE_MAX,
  URL_MAX,
} from "./model.ts";

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Base64 of UTF-8 bytes, host-free (no node:btoa dependency). */
export function base64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += B64[b0 >> 2];
    out += B64[((b0 & 3) << 4) | (b1 === undefined ? 0 : b1 >> 4)];
    out += b1 === undefined ? "=" : B64[((b1 & 15) << 2) | (b2 === undefined ? 0 : b2 >> 6)];
    out += b2 === undefined ? "=" : B64[b2 & 63];
  }
  return out;
}

export function basicAuth(user: string, password: string): string {
  return "Basic " + base64(new TextEncoder().encode(user + ":" + password));
}

export interface JiraAuth {
  edition: "cloud" | "server";
  baseUrl: string;
  authHeader: string;
}

export interface JiraIssueSummary {
  key: string;
  summary: string;
  statusName: string;
  statusId: string;
  issueType: string;
  labels: string[];
  assignee: string | null;
  /** null when the generated browse link would exceed the schema limit. */
  url: string | null;
  description: string;
}

export interface JiraTransitionView {
  id: string;
  name: string;
  toName: string;
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

function apiPath(auth: JiraAuth, suffix: string): string {
  const version = auth.edition === "cloud" ? "3" : "2";
  return auth.baseUrl + "/rest/api/" + version + suffix;
}

async function requestJson(auth: JiraAuth, suffix: string, init: RequestInit, fetchFn: FetchLike): Promise<unknown> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    Authorization: auth.authHeader,
    ...((init.headers as Record<string, string> | undefined) ?? {}),
  };
  let response: Response;
  try {
    response = await fetchFn(apiPath(auth, suffix), {
      method: init.method ?? "GET",
      headers,
      body: init.body,
      redirect: "error",
      signal: init.signal,
    });
  } catch {
    throw new DomainError("network", "Could not reach the Jira server");
  }
  if (response.status === 401 || response.status === 403) {
    throw new DomainError("auth", "Authentication failed");
  }
  if (response.status === 404) {
    throw new DomainError("not_found", "Not found on the Jira server");
  }
  if (!response.ok) {
    throw new DomainError("http", "Request failed (HTTP " + response.status + ")");
  }
  if (response.status === 204) {
    return undefined;
  }
  try {
    return await response.json();
  } catch {
    throw new DomainError("http", "The Jira server returned an unexpected response");
  }
}

function textOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Jira timestamps: YYYY-MM-DDTHH:mm:ss.sss+0000 (millisecond, UTC). */
function jiraTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (value: number, width: number) => String(value).padStart(width, "0");
  return (
    date.getUTCFullYear() + "-" + pad(date.getUTCMonth() + 1, 2) + "-" + pad(date.getUTCDate(), 2) +
    "T" + pad(date.getUTCHours(), 2) + ":" + pad(date.getUTCMinutes(), 2) + ":" + pad(date.getUTCSeconds(), 2) +
    "." + pad(date.getUTCMilliseconds(), 3) + "+0000"
  );
}

/** Cloud v3 worklog comments are ADF documents. */
function adfComment(text: string): unknown {
  return { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text }] }] };
}

/** A non-empty, bounded string, or the fallback when it is empty. */
function bounded(value: unknown, max: number, fallback: string): string {
  const boundedValue = boundedText(textOf(value).trim(), max);
  return boundedValue === "" ? fallback : boundedValue;
}

/** ADF (Cloud) and plain-text (Server) descriptions to bounded plain text. */
function descriptionText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return boundedText(value.replace(/\u0000/g, ""), DESCRIPTION_MAX);
  if (typeof value === "object") return boundedText(adfToPlainText(value), DESCRIPTION_MAX);
  return "";
}

function adfToPlainText(doc: unknown): string {
  const parts: string[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (node === null || typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    const type = typeof obj.type === "string" ? obj.type : "";
    const isBlock =
      type === "paragraph" || type === "heading" || type === "listItem" || type === "bulletList" ||
      type === "orderedList" || type === "codeBlock" || type === "blockquote";
    if (typeof obj.text === "string") parts.push(obj.text);
    if (Array.isArray(obj.content)) for (const child of obj.content) visit(child);
    if (isBlock) parts.push("\n");
  };
  visit(doc);
  return parts.join("").replace(/\n{3,}/g, "\n\n").trim();
}

function labelList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const label = boundedText(item.trim(), LABEL_MAX);
    if (label === "") continue;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(label);
    if (out.length >= LABELS_MAX) break;
  }
  return out;
}

/** Never truncates a URL: returns the full link, or null when it is too long. */
function boundedUrl(value: string): string | null {
  return value.length > URL_MAX ? null : value;
}

function toSummary(raw: unknown, baseUrl: string): JiraIssueSummary | null {
  const issue = (raw ?? {}) as Record<string, unknown>;
  const fields = (issue.fields ?? {}) as Record<string, unknown>;
  const status = (fields.status ?? {}) as Record<string, unknown>;
  const issueType = (fields.issuetype ?? {}) as Record<string, unknown>;
  const assignee = (fields.assignee ?? null) as Record<string, unknown> | null;
  const key = bounded(issue.key, ISSUE_KEY_MAX, "").trim();
  const summary = bounded(fields.summary, TITLE_MAX, "").trim();
  // A remote entry with no key or no summary is malformed: skip it, never persist.
  if (key === "" || summary === "") return null;
  const statusName = bounded(status.name, NAME_MAX, "No status");
  const assigneeName = assignee === null ? "" : bounded(assignee.displayName, NAME_MAX, "").trim();
  return {
    key,
    summary,
    statusName,
    statusId: bounded(status.id, ID_MAX, ""),
    issueType: bounded(issueType.name, NAME_MAX, "Task"),
    labels: labelList(fields.labels),
    assignee: assigneeName === "" ? null : assigneeName,
    url: boundedUrl(baseUrl + "/browse/" + key),
    description: descriptionText(fields.description),
  };
}

interface SearchPage {
  issues: unknown[];
  total: number | null;
  nextPageToken: string | null;
}

async function searchPage(
  auth: JiraAuth,
  jql: string,
  maxResults: number,
  pageToken: string | null,
  startAt: number,
  fetchFn: FetchLike,
): Promise<SearchPage> {
  const fields = ["summary", "status", "issuetype", "labels", "assignee", "description"];
  const body =
    auth.edition === "cloud"
      ? { jql, maxResults, nextPageToken: pageToken ?? undefined, fields }
      : { jql, maxResults, startAt, fields };
  const suffix = auth.edition === "cloud" ? "/search/jql" : "/search";
  const raw = await requestJson(
    auth,
    suffix,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
    fetchFn,
  );
  const data = (raw ?? {}) as Record<string, unknown>;
  const issues = Array.isArray(data.issues) ? data.issues : [];
  // Cloud v3 has no overall total (only nextPageToken); Server v2 returns total.
  const total = auth.edition === "cloud" ? null : typeof data.total === "number" ? data.total : null;
  return {
    issues,
    total,
    nextPageToken: typeof data.nextPageToken === "string" ? data.nextPageToken : null,
  };
}

export interface JiraIssuePage {
  issues: JiraIssueSummary[];
  /** Overall match count when the server reports it (Server); null for Cloud. */
  total: number | null;
  /** True when the maxResults cap cut off more matches. */
  truncated: boolean;
}

export interface JiraWorklogInput {
  issueKey: string;
  timeSpentSeconds: number;
  comment: string;
  startedAtIso: string;
}

export interface JiraClient {
  readonly edition: "cloud" | "server";
  /** The authenticated user, to test a connection. */
  myself(): Promise<string>;
  /** All issues matching the JQL, up to maxResults (default JIRA_FETCH_MAX). */
  listIssues(jql: string, options?: { maxResults?: number }): Promise<JiraIssuePage>;
  getTransitions(issueKey: string): Promise<JiraTransitionView[]>;
  transition(issueKey: string, transitionId: string): Promise<void>;
  submitWorklog(input: JiraWorklogInput): Promise<{ id: string }>;
}

export function createJiraClient(auth: JiraAuth, fetchFn: FetchLike = fetch): JiraClient {
  return {
    edition: auth.edition,
    async myself() {
      const raw = await requestJson(auth, "/myself", {}, fetchFn);
      const data = (raw ?? {}) as Record<string, unknown>;
      return bounded(data.displayName, NAME_MAX, bounded(data.name, NAME_MAX, "authenticated"));
    },
    async listIssues(jql, options) {
      const maxResults = Math.max(1, Math.min(options?.maxResults ?? JIRA_FETCH_MAX, JIRA_FETCH_MAX));
      const pageSize = Math.min(JIRA_PAGE_MAX, maxResults);
      const out: JiraIssueSummary[] = [];
      let pageToken: string | null = null;
      let startAt = 0;
      let total: number | null = null;
      let truncated = false;
      for (;;) {
        const page = await searchPage(auth, jql, pageSize, pageToken, startAt, fetchFn);
        if (total === null) total = page.total;
        for (const issue of page.issues) {
          const summary = toSummary(issue, auth.baseUrl);
          if (summary !== null) out.push(summary);
        }
        const more =
          auth.edition === "cloud"
            ? page.nextPageToken !== null && page.issues.length > 0
            : page.total !== null
              ? page.total > startAt + page.issues.length
              : page.issues.length >= pageSize;
        if (out.length >= maxResults) {
          truncated = more;
          break;
        }
        if (!more) break;
        if (auth.edition === "cloud") pageToken = page.nextPageToken;
        else startAt += page.issues.length;
      }
      return { issues: out.slice(0, maxResults), total, truncated };
    },
    async getTransitions(issueKey) {
      const raw = await requestJson(auth, "/issue/" + encodeURIComponent(issueKey) + "/transitions", {}, fetchFn);
      const data = (raw ?? {}) as Record<string, unknown>;
      const transitions = Array.isArray(data.transitions) ? data.transitions : [];
      const out: JiraTransitionView[] = [];
      for (const rawTransition of transitions) {
        const t = (rawTransition ?? {}) as Record<string, unknown>;
        const to = (t.to ?? {}) as Record<string, unknown>;
        const id = bounded(t.id, ID_MAX, "").trim();
        if (id === "") continue;
        const toName = bounded(to.name, NAME_MAX, "").trim();
        const name = bounded(t.name, NAME_MAX, toName === "" ? "Transition" : toName).trim();
        out.push({ id, name, toName: toName === "" ? name : toName });
      }
      return out;
    },
    async transition(issueKey, transitionId) {
      await requestJson(
        auth,
        "/issue/" + encodeURIComponent(issueKey) + "/transitions",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ transition: { id: transitionId } }),
        },
        fetchFn,
      );
    },
    async submitWorklog(input) {
      const body: Record<string, unknown> = { timeSpentSeconds: input.timeSpentSeconds, started: jiraTimestamp(input.startedAtIso) };
      if (input.comment !== "") body.comment = auth.edition === "cloud" ? adfComment(input.comment) : input.comment;
      const raw = await requestJson(
        auth,
        "/issue/" + encodeURIComponent(input.issueKey) + "/worklog",
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
        fetchFn,
      );
      const data = (raw ?? {}) as Record<string, unknown>;
      const id = bounded(data.id, ID_MAX, "").trim();
      if (id === "") throw new DomainError("http", "The Jira server did not return a worklog id");
      return { id };
    },
  };
}
