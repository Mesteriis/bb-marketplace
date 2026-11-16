# Makosh Taskboard

A focused task board for [BB](https://github.com/get-bb/bb): persistent local
tasks plus Jira Cloud and Jira Server/Data Center issues, in one List and
Kanban view.

## What it does

- **Local task CRUD** — create, edit, move and delete tasks that persist in the
  plugin's SQLite database on the BB server.
- **Jira Cloud and Server/Data Center** — connect either edition. Cloud uses
  account email + API token over the v3 REST API (`/rest/api/3/search/jql`
  with `nextPageToken` pagination). Server/Data Center uses a personal access
  token over the v2 REST API (`/rest/api/2/search` with `startAt` pagination)
  and a configurable HTTPS URL that keeps its context path (for example
  `https://jira.example.com/jira`).
- **List and Kanban** — ordered columns, drag-and-drop and a keyboard-accessible
  status menu, and a details panel that becomes a full overlay on narrow
  panels.
- **Fetch issues** — imports a JQL result into the board as jira-origin tasks
  and appends a column for each Jira status. Local and Jira tasks coexist;
  every Jira task keeps its origin key.
- **Transitions** — move a Jira task through its real workflow. A transition
  Jira rejects rolls back the optimistic move.
- **Connections** — add, edit, test and delete connections. Credentials are
  write-only and never returned to the frontend.

## Architecture

The plugin follows `docs/architecture.md` at the repository root:

- `src/core` — domain types, ports and application logic; imports only `zod`
  and itself. The Jira REST client lives here and runs over `fetch`.
- `src/ui` — React components that take data and callbacks through props.
- `src/adapters/bb` — SQLite storage and AES-256-GCM credential storage.
- `server.ts` / `app.tsx` — BB entry points.

`tests/architecture.test.ts` enforces those import boundaries.

## Security

- Credentials (API token / PAT) are sealed with AES-256-GCM under a plugin
  vault key (a secret setting) and are never sent to the UI.
- Only HTTPS URLs are accepted.
- Every Jira request uses `redirect: error`, so the Authorization header is
  never forwarded to a redirect target.
- HTTP errors are sanitized to fixed text; no response body, URL path or header
  value is embedded in an error.

## Development

```sh
cd plugins/taskboard
npm install
npm run check   # typecheck + tests
npm run build   # bb plugin build
```

## Standalone browser demo (development)

The demo mounts the real `src/ui` against a synthetic in-memory API built on the
real core — no BB install, no credentials, no network.

```sh
cd plugins/taskboard
npm install
npm run build       # produces dist/app.css, which the demo reuses
npm run demo:build  # produces demo/demo.js
python3 -m http.server 4173
```

Open `http://localhost:4173/demo/`. It seeds a local "Product" board and a demo
Jira Cloud connection with three imported issues plus one local task on the
same board. Try the board selector, List/Board toggle, search and filters, a
task's details and Jira transitions, Board settings, and the connection
manager's Fetch/Test. Resize the window to check the narrow-panel overlay and
the dialog focus flow.

## Take into work

From a task's details, **Take into work** chooses an existing BB project plus a
start status and a completion target. Taskboard creates a worktree/branch and
a new agent thread with the task context (the project's existing provider and
model are kept), then opens that thread. The association is persisted in the
plugin database.

Completion is explicit: the agent calls the scoped `finish_work` tool (or you
press **Complete** in details). The task transitions to the completion target,
and an editable time-entry dialog opens with the elapsed duration prefilled.
**Confirm** submits a Jira worklog (Cloud or Server) or stores a local worklog
for local tasks; **Later** keeps the pending draft. Time is never auto-submitted,
and retries never duplicate threads, transitions or worklogs.

## License

[MIT](./LICENSE), adapted from the MIT-licensed Taskboard plugin by Mateo
Cerquetella (upstream commit 0ae0d539b3a46c1ffb158e119a7e3c23060f9a5b); see
[THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).
