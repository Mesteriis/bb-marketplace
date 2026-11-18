Makosh Taskboard combines persistent local tasks, Jira Cloud and Jira
Server/Data Center issues, development threads and time tracking.

## Assigned-task List

List is the default and the only general view across Jira projects. Fetch loads
all issues assigned to the authenticated user, paging through the full result.
No project or JQL is required at connection time; older scopes are ignored.
Search and filters cover project, origin, status and labels. Reassigned issues
are hidden after refresh; cached records, development runs and time history
remain intact. Jira descriptions and titles are read-only.

## Jira project Kanban

Board offers only projects with tasks assigned to you after the latest Fetch.
Select a project and a real Kanban board when several
exist. Names, order, status-ID mappings and WIP limits come from the board's
actual Jira configuration. Several statuses may share one column; Taskboard
never adds synthetic or other-project columns to this view.

Issues come from the selected board, scoped to the selected project, including
teammates' tasks. These do not enter the assigned-task List. Unmapped/backlog
statuses are reported without extra columns. Drag a card or select a destination
column, then choose an available Jira workflow transition.

## Local tasks and connections

Local tasks support create, edit, move and confirmed delete. Local boards retain
editable, ordered columns and List/Kanban. Narrow panels use a full-width task
details overlay; task cards support keyboard access.

Cloud connects to https://example.atlassian.net using email and API token.
Server/Data Center uses a personal access token and an HTTPS URL, including a
context path. Connections support add, edit, test, fetch and delete. Credentials
are encrypted on the server and never returned to the frontend. Deleting a
connection preserves its cached tasks and disables remote operations.

Deleting a Jira task deletes only its local copy, never the Jira issue.

## Development workflow

Take into work chooses a BB project and start/completion statuses. Taskboard
creates an owned worktree with an issue-key branch, opens an agent thread and
persists its association. Completion uses the thread-scoped finish_work tool or
the Complete action. Idle or failed turns never complete a task.

Explicit completion transitions the issue and opens an editable elapsed-time
draft. Time is submitted only on Confirm. Interrupted or ambiguous external
operations keep recovery state to avoid blind duplicate submissions.

## Direct time tracking and agent access

Log time on any task accepts seconds and a comment, without a development run
or status change. Confirm writes to Jira Cloud/Server or local storage. Worklog
history shows entries recorded through Taskboard, not pre-existing Jira entries.
Failed and unknown results retain owner recovery controls.

Agents have boards_list, tasks_list, worklog_prepare, worklog_submit,
worklogs_list and time_entries_by_task. Prepare saves a draft with a stable
unique entryId; submit records authorized time. Reuse that ID for retries and
never blindly repeat an unknown Jira result.
