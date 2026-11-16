// Domain schemas and types for the taskboard. Wire contracts are plain zod
// schemas; a taskboard move between hosts reuses them unchanged.
import { z } from "zod";

export const JIRA_EDITIONS = ["cloud", "server"] as const;
export type JiraEdition = (typeof JIRA_EDITIONS)[number];

export const TASK_ORIGINS = ["local", "jira"] as const;
export type TaskOrigin = (typeof TASK_ORIGINS)[number];

export const ID_MAX = 100;
export const TITLE_MAX = 500;
export const DESCRIPTION_MAX = 20_000;
export const NAME_MAX = 120;
export const LABEL_MAX = 60;
export const LABELS_MAX = 20;
export const JQL_MAX = 4000;
export const URL_MAX = 2000;
export const EMAIL_MAX = 320;
export const CREDENTIAL_MAX = 1000;
export const ISSUE_KEY_MAX = 255;
export const COLUMNS_MAX = 50;
export const JIRA_PAGE_MAX = 50;
export const JIRA_FETCH_MAX = 200;

export const DEFAULT_COLUMN_NAMES = ["To do", "In progress", "Done"] as const;

/** A strict HTTPS origin: no userinfo, query or fragment. */
export function isHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname.length > 0 &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

/** Cloud sites are https://<site>.atlassian.net with no context path. */
export function isCloudBaseUrl(value: string): boolean {
  if (!isHttpsUrl(value)) return false;
  const url = new URL(value);
  const host = url.hostname.toLowerCase();
  return host.endsWith(".atlassian.net") && host !== "atlassian.net" && (url.pathname === "" || url.pathname === "/");
}

/** Truncates to max Unicode code points, host-free. */
export function boundedText(value: string, max: number): string {
  return Array.from(value).slice(0, max).join("");
}

/** Strips trailing slashes only: a Server context path like /jira is kept. */
export function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

export const idSchema = z.string().min(1).max(ID_MAX);
export const titleSchema = z.string().trim().min(1, "Title is required").max(TITLE_MAX);
export const nameSchema = z.string().trim().min(1, "Name is required").max(NAME_MAX);
export const baseUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(URL_MAX)
  .refine(isHttpsUrl, "Must be an HTTPS URL");
export const emailSchema = z.string().trim().email("Invalid email").max(EMAIL_MAX);
export const jqlSchema = z.string().max(JQL_MAX).default("");
export const projectKeySchema = z.string().trim().max(NAME_MAX).default("");
export const credentialSchema = z.string().min(1).max(CREDENTIAL_MAX);
export const issueKeySchema = z.string().trim().min(1).max(ISSUE_KEY_MAX);

export const boardSchema = z
  .object({
    id: idSchema,
    name: z.string().min(1).max(NAME_MAX),
    connectionId: idSchema.nullable(),
  })
  .strict();
export type Board = z.infer<typeof boardSchema>;

export const columnSchema = z
  .object({
    id: idSchema,
    boardId: idSchema,
    name: z.string().min(1).max(NAME_MAX),
    order: z.number().int().min(0),
  })
  .strict();
export type Column = z.infer<typeof columnSchema>;

export const taskSchema = z
  .object({
    id: idSchema,
    boardId: idSchema,
    title: z.string().min(1).max(TITLE_MAX),
    description: z.string().max(DESCRIPTION_MAX),
    status: idSchema,
    origin: z.enum(TASK_ORIGINS),
    originKey: z.string().max(ISSUE_KEY_MAX).nullable(),
    originUrl: z.string().max(URL_MAX).nullable(),
    labels: z.array(z.string().min(1).max(LABEL_MAX)).max(LABELS_MAX),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
    sortOrder: z.number().int(),
    inScope: z.boolean().optional(),
  })
  .strict();
export type Task = z.infer<typeof taskSchema>;

export const connectionSchema = z
  .object({
    id: idSchema,
    name: z.string().min(1).max(NAME_MAX),
    edition: z.enum(JIRA_EDITIONS),
    baseUrl: z.string().min(1).max(URL_MAX),
    email: z.string().max(EMAIL_MAX).nullable(),
    projectKey: z.string().max(NAME_MAX),
    jql: z.string().max(JQL_MAX),
    hasCredential: z.boolean(),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
  })
  .strict();
export type Connection = z.infer<typeof connectionSchema>;

export const boardViewSchema = boardSchema.extend({ columns: z.array(columnSchema).max(COLUMNS_MAX) });
export type BoardView = z.infer<typeof boardViewSchema>;

export const transitionSchema = z
  .object({ id: z.string().min(1).max(ID_MAX), name: z.string().min(1).max(NAME_MAX), toName: z.string().min(1).max(NAME_MAX) })
  .strict();
export type JiraTransition = z.infer<typeof transitionSchema>;

// ---- RPC input schemas ----

export const columnInputSchema = z
  .object({
    id: idSchema.optional(),
    name: nameSchema,
    order: z.number().int().min(0),
  })
  .strict();
export type ColumnInput = z.infer<typeof columnInputSchema>;

export const boardCreateInputSchema = z.object({ name: nameSchema }).strict();
export const boardUpdateInputSchema = z
  .object({
    boardId: idSchema,
    name: nameSchema,
    columns: z.array(columnInputSchema).min(1).max(COLUMNS_MAX),
  })
  .strict();

export const taskCreateInputSchema = z
  .object({
    boardId: idSchema,
    title: titleSchema,
    description: z.string().max(DESCRIPTION_MAX).optional(),
    status: idSchema.optional(),
  })
  .strict();

export const taskUpdateInputSchema = z
  .object({
    taskId: idSchema,
    title: titleSchema.optional(),
    description: z.string().max(DESCRIPTION_MAX).optional(),
  })
  .strict();

export const taskMoveInputSchema = z.object({ taskId: idSchema, status: idSchema }).strict();

export const connectionCreateInputSchema = z
  .object({
    name: nameSchema,
    edition: z.enum(JIRA_EDITIONS),
    baseUrl: baseUrlSchema,
    email: z.string().trim().max(EMAIL_MAX).optional(),
    projectKey: projectKeySchema,
    jql: jqlSchema,
    credential: credentialSchema,
  })
  .strict();

export const connectionUpdateInputSchema = z
  .object({
    connectionId: idSchema,
    name: nameSchema.optional(),
    edition: z.enum(JIRA_EDITIONS).optional(),
    baseUrl: baseUrlSchema.optional(),
    email: z.string().trim().max(EMAIL_MAX).nullable().optional(),
    projectKey: projectKeySchema.optional(),
    jql: jqlSchema.optional(),
    credential: credentialSchema.optional(),
  })
  .strict();

export type BoardCreateInput = z.infer<typeof boardCreateInputSchema>;
export type BoardUpdateInput = z.infer<typeof boardUpdateInputSchema>;
export type TaskCreateInput = z.infer<typeof taskCreateInputSchema>;
export type TaskUpdateInput = z.infer<typeof taskUpdateInputSchema>;
export type TaskMoveInput = z.infer<typeof taskMoveInputSchema>;
export type ConnectionCreateInput = z.infer<typeof connectionCreateInputSchema>;
export type ConnectionUpdateInput = z.infer<typeof connectionUpdateInputSchema>;
