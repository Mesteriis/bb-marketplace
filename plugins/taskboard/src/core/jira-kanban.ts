import { z } from "zod";
import { DomainError } from "./errors.ts";
import { requestJson, toSummary, type FetchLike, type JiraAuth } from "./jira.ts";

export const jiraProjectSchema = z.object({ key: z.string().min(1).max(200), name: z.string().min(1).max(500) });
export const jiraBoardSchema = z.object({ id: z.number().int().positive(), name: z.string().min(1).max(500) });
export const jiraColumnSchema = z.object({ name: z.string().min(1).max(500), statusIds: z.array(z.string().min(1).max(100)), min: z.number().optional(), max: z.number().optional() });
export type JiraKanbanColumn = z.infer<typeof jiraColumnSchema>;
export type JiraProject = z.infer<typeof jiraProjectSchema>;
export type JiraBoard = z.infer<typeof jiraBoardSchema>;
const pageSchema = z.object({ values: z.array(z.unknown()), isLast: z.boolean().optional(), total: z.number().optional() });

export function createJiraKanbanClient(auth: JiraAuth, fetchFn: FetchLike = fetch) {
  const get = (suffix: string, agile = true) => requestJson(auth, suffix, {}, fetchFn, agile ? "agile" : "platform");
  async function pages(path: string, agile = true): Promise<unknown[]> {
    const result: unknown[] = [];
    let startAt = 0;
    for (;;) {
      const page = pageSchema.parse(await get(path + (path.includes("?") ? "&" : "?") + "startAt=" + startAt + "&maxResults=50", agile));
      result.push(...page.values);
      startAt += page.values.length;
      if (page.isLast === true || (page.total !== undefined && startAt >= page.total) || (page.isLast === undefined && page.total === undefined && page.values.length < 50)) return result;
      if (page.values.length === 0) throw new DomainError("http", "Jira board pagination made no progress");
    }
  }
  return {
    async projects(): Promise<JiraProject[]> {
      const values = auth.edition === "cloud" ? await pages("/project/search", false) : z.array(z.unknown()).parse(await get("/project", false));
      return values.map(value => jiraProjectSchema.parse(value)).sort((a, b) => a.key.localeCompare(b.key));
    },
    async boards(projectKey: string): Promise<JiraBoard[]> {
      const values = await pages("/board?type=kanban&projectKeyOrId=" + encodeURIComponent(projectKey));
      return values.map(value => jiraBoardSchema.parse(value));
    },
    async columns(boardId: number): Promise<JiraKanbanColumn[]> {
      const raw = z.object({ columnConfig: z.object({ columns: z.array(z.object({ name: z.string(), statuses: z.array(z.object({ id: z.string() })), min: z.number().optional(), max: z.number().optional() })) }) }).parse(await get("/board/" + boardId + "/configuration"));
      return raw.columnConfig.columns.map(column => jiraColumnSchema.parse({ name: column.name, statusIds: column.statuses.map(s => s.id), ...(column.min !== undefined ? { min: column.min } : {}), ...(column.max !== undefined ? { max: column.max } : {}) }));
    },
    async issues(boardId: number, projectKey: string) {
      const issues = [];
      let startAt = 0;
      for (;;) {
        const raw = z.object({ issues: z.array(z.unknown()), total: z.number() }).parse(await get("/board/" + boardId + "/issue?startAt=" + startAt + "&maxResults=50&jql=" + encodeURIComponent("project = " + JSON.stringify(projectKey)) + "&fields=summary,status,issuetype,labels,assignee,description"));
        for (const value of raw.issues) {
          const issue = toSummary(value, auth.baseUrl);
          if (issue !== null) issues.push(issue);
        }
        startAt += raw.issues.length;
        if (startAt >= raw.total) return issues;
        if (raw.issues.length === 0) throw new DomainError("http", "Jira board issues pagination made no progress");
      }
    },
  };
}
