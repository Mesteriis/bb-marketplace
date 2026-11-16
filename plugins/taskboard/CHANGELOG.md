# Changelog

## Unreleased

- Stop reloads caused by host RPC wrapper replacement or opening task details; limit project choices to assigned work.

- Require project selection in Jira Kanban; use real board columns, status mappings and board issues. Keep cross-project assigned tasks in List only.

- Add read-only Jira worklog verification and classify HTTP 400/422 rejections as known validation failures.

- Add direct task time logging and Taskboard worklog history, plus agent discovery, prepare and submit tools.

- Fetch all issues assigned to the authenticated Jira user across projects, without project/JQL setup or the former 200-issue cap.
- Group List and Kanban by project and add project filtering; preserve cached history when issues are reassigned.
- Keep task titles readable in the narrow List layout.
