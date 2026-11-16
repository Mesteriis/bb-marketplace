// The RPC wire contract: plain zod schemas. server.ts wraps them for BB RPC;
// another host wraps the same schemas for its own transport.
import { prepareWorklogSchema } from "./manual-worklogs.ts";
import { z } from "zod";
import { taskRunSchema, timeEntrySchema, worklogSchema } from "./lifecycle.ts";
import {
  boardCreateInputSchema,
  boardUpdateInputSchema,
  boardViewSchema,
  columnSchema,
  connectionCreateInputSchema,
  connectionSchema,
  connectionUpdateInputSchema,
  idSchema,
  issueKeySchema,
  taskCreateInputSchema,
  taskMoveInputSchema,
  taskSchema,
  taskUpdateInputSchema,
  transitionSchema,
} from "./model.ts";

export const rpcSchemas = {
  boards_list: {
    input: z.object({}).strict(),
    output: z.object({ boards: z.array(boardViewSchema) }).strict(),
  },
  tasks_list: {
    input: z.object({ boardId: idSchema }).strict(),
    output: z.object({ columns: z.array(columnSchema), tasks: z.array(taskSchema) }).strict(),
  },
  connections_list: {
    input: z.object({}).strict(),
    output: z.object({ connections: z.array(connectionSchema) }).strict(),
  },
  transitions_list: {
    input: z.object({ connectionId: idSchema, issueKey: issueKeySchema }).strict(),
    output: z.object({ transitions: z.array(transitionSchema) }).strict(),
  },
  board_create: {
    input: boardCreateInputSchema,
    output: z.object({ board: boardViewSchema }).strict(),
  },
  board_update: {
    input: boardUpdateInputSchema,
    output: z.object({ board: boardViewSchema }).strict(),
  },
  board_delete: {
    input: z.object({ boardId: idSchema }).strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  task_create: {
    input: taskCreateInputSchema,
    output: z.object({ task: taskSchema }).strict(),
  },
  task_update: {
    input: taskUpdateInputSchema,
    output: z.object({ task: taskSchema }).strict(),
  },
  task_move: {
    input: taskMoveInputSchema,
    output: z.object({ task: taskSchema }).strict(),
  },
  task_delete: {
    input: z.object({ taskId: idSchema }).strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  connection_create: {
    input: connectionCreateInputSchema,
    output: z.object({ connection: connectionSchema }).strict(),
  },
  connection_update: {
    input: connectionUpdateInputSchema,
    output: z.object({ connection: connectionSchema }).strict(),
  },
  connection_delete: {
    input: z.object({ connectionId: idSchema }).strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  connection_test: {
    input: z.object({ connectionId: idSchema }).strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  jira_fetch: {
    input: z.object({ connectionId: idSchema }).strict(),
    output: z
      .object({ imported: z.number().int().min(0), total: z.number().int().min(0).nullable(), truncated: z.boolean() })
      .strict(),
  },
  jira_transition: {
    input: z.object({ connectionId: idSchema, issueKey: issueKeySchema, transitionId: idSchema }).strict(),
    output: z.object({ task: taskSchema }).strict(),
  },
  projects_list: {
    input: z.object({}).strict(),
    output: z.object({ projects: z.array(z.object({ id: z.string().min(1), name: z.string().min(1) }).strict()) }).strict(),
  },
  run_take: {
    input: z.object({ taskId: idSchema, projectId: z.string().min(1), startStatusId: idSchema, nextStatusId: idSchema }).strict(),
    output: z.object({ run: taskRunSchema }).strict(),
  },
  run_list: {
    input: z.object({ taskId: idSchema }).strict(),
    output: z.object({ runs: z.array(taskRunSchema) }).strict(),
  },
  run_complete: {
    input: z.object({ runId: idSchema, deliveredSummary: z.string().max(4000).optional() }).strict(),
    output: z.object({ timeEntry: timeEntrySchema }).strict(),
  },
  worklog_prepare: {
    input: prepareWorklogSchema,
    output: z.object({ timeEntry: timeEntrySchema }).strict(),
  },
  time_entry_update: {
    input: z.object({ entryId: idSchema, durationSeconds: z.number().int().min(1).max(31_536_000), comment: z.string().max(4000) }).strict(),
    output: z.object({ timeEntry: timeEntrySchema }).strict(),
  },
  time_entry_submit: {
    input: z.object({ entryId: idSchema, durationSeconds: z.number().int().min(1).max(31_536_000), comment: z.string().max(4000) }).strict(),
    output: z.object({ worklog: worklogSchema }).strict(),
  },
  time_entries_pending: {
    input: z.object({}).strict(),
    output: z.object({ entries: z.array(timeEntrySchema) }).strict(),
  },
  jira_worklogs_list: {
    input: z.object({ taskId: idSchema }).strict(),
    output: z.object({ worklogs: z.array(z.object({ id: z.string(), durationSeconds: z.number(), comment: z.string() })) }).strict(),
  },
  worklogs_list: {
    input: z.object({ taskId: idSchema }).strict(),
    output: z.object({ worklogs: z.array(worklogSchema) }).strict(),
  },
  time_entries_by_task: {
    input: z.object({ taskId: idSchema }).strict(),
    output: z.object({ entries: z.array(timeEntrySchema) }).strict(),
  },
  time_entry_retry: {
    input: z.object({ entryId: idSchema }).strict(),
    output: z.object({ timeEntry: timeEntrySchema }).strict(),
  },
  time_entry_resolve: {
    input: z.object({ entryId: idSchema, remoteId: z.string().max(200).optional() }).strict(),
    output: z.object({ worklog: worklogSchema }).strict(),
  },
  run_cancel: {
    input: z.object({ runId: idSchema }).strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
} as const;
