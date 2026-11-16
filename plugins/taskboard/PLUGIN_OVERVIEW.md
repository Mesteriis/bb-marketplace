This experimental release adds a focused task board next to your threads:
keep persistent local tasks, connect Jira Cloud or Jira Server/Data Center,
and work both in one List and Kanban view.

## What you get

- A **Taskboard** page with a board selector, **List** and **Board** views,
  and a task details panel (full-width on narrow panels).
- **Local tasks**: create, edit, move and delete persistent tasks that stay on
  the BB server. Boards have ordered, editable columns.
- **Jira Cloud** and **Jira Server/Data Center** connections. Cloud uses
  account email + API token against an `https://<site>.atlassian.net` URL;
  Server uses a personal access token and a configurable HTTPS URL with a
  context path.
- **Fetch issues** loads all issues assigned to the authenticated Jira user
  across every project, paging through the complete result. No project or JQL
  is required at connection time; older saved project scopes are ignored.
  List and Kanban group issues by project key, with a project filter.
  Issues reassigned elsewhere disappear after refresh; their cached records,
  development runs and time history are preserved. Local tasks remain separate.
- **Transitions**: move a Jira task through its real workflow from the status
  menu or the transitions list in details. A rejected move rolls back the
  optimistic change.
- **Delete** removes the local copy only: for a Jira task it never touches the
  Jira issue; for a local task it is permanent (confirmed in the details
  panel).
- **Take into work**: from a task's details choose a BB project plus a start
  status and a completion target. Taskboard creates a worktree/branch and a new
  agent thread with the task context, then opens it. The run's association
  (task, project, environment, thread, branch, elapsed time) persists across
  restarts.
- **Explicit completion**: an agent finishes with the scoped `finish_work`
  tool, or you press Complete in details. The task transitions to the chosen
  next status and an editable time-entry dialog opens with the elapsed duration
  prefilled. Confirm submits a Jira Cloud/Server worklog (or stores a local
  worklog for local tasks); a dismissed dialog keeps the pending draft. Time is
  never auto-submitted.
- **Connections** manager: add, edit, test, delete and **Fetch** each
  connection (no pre-bound board required). Credentials are write-only and
  never sent to the frontend.
- **Search and filters** by text, project, origin, status and label in both views, and a
  **Board settings** editor for renaming and reordering columns.
- Imported Jira descriptions are shown read-only; Jira titles and bodies are
  never edited from the cache.

## What it costs

- A credential per connection (API token or PAT). Nothing is shared or
  uploaded beyond the Jira server you configure; only HTTPS URLs are accepted.

## Not yet

Creating Jira issues, attachments, or comments. The worktree branch is
named by BB; Taskboard records the actual branch and titles the thread with
the issue key.

## Source

Requires BB 0.49 or later. MIT licensed; adapted from MateoCerquetella's
MIT Taskboard plugin (upstream commit 0ae0d539b3a46c1ffb158e119a7e3c23060f9a5b).

## Direct time tracking and agent access

**Log time** on any task accepts seconds and a comment, without a development
run or status change. Confirm writes to Jira Cloud/Server or local storage.
**Refresh worklog history** lists entries recorded through Taskboard, not
pre-existing Jira worklogs. Failed and unknown results retain recovery controls.

Agents get `boards_list`, `tasks_list`, `worklog_prepare`, `worklog_submit`,
`worklogs_list` and `time_entries_by_task`. Preparation saves a draft using a
stable unique entryId; submission records authorized time. Reuse that ID for
retries; never blindly retry an unknown Jira result.
