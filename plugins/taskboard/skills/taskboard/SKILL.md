---
name: taskboard
description: Makosh Taskboard — a local task board plus Jira Cloud and Server/Data Center issues, with List and Kanban views.
---

# Makosh Taskboard

A board for the owner's work: local tasks live next to issues fetched from
Jira Cloud or Jira Server/Data Center.

## What it is

- Local, persistent task CRUD. Every task carries an origin (local or jira)
  and, for Jira issues, an origin key such as PROJ-123.
- Boards have ordered columns. A board is either local-only or bound to one
  Jira connection; fetching issues creates or reuses that board and appends a
  column for each Jira status it meets.
- List and Kanban views, a task details panel, and optimistic moves that roll
  back when Jira rejects a transition.

## Connections

- Jira Cloud: account email + API token, an HTTPS *.atlassian.net URL.
- Jira Server / Data Center: a personal access token and a configurable HTTPS
  URL with a context path, for example https://jira.example.com/jira.
- Credentials are stored encrypted on the server and are never sent to the UI.

## Agent tool

When a task is taken into work, its thread gets a scoped `finish_work` tool.
Call it with a summary of what was delivered; it transitions the task and
creates a pending time entry for the owner to confirm. Idle or failed turns
never complete a task.

## Log time without a development run

Use `boards_list` and `tasks_list` to find a task's internal ID. Use
`worklog_prepare` with taskId, a unique entryId, durationSeconds and comment.
Reuse that entryId for retries. When the owner authorizes recording the time,
call `worklog_submit` with entryId, durationSeconds and comment. Preparation only
saves a draft; submit sends the worklog to Jira (or stores it locally).

Inspect `time_entries_by_task` before retrying. Never resend an unknown result
with a new ID: it may already exist in Jira. Ask the owner to reconcile through
Taskboard. `worklogs_list` shows work recorded through this plugin, not all Jira
history. `finish_work` remains specific to development completion.
