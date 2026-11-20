# Makosh Mail: MCP for outside assistants — design

Date: 2026-11-20. Status: approved in advance (the owner, 2026-11-19:
"Завершай все что наметили"). The decisions below are the builder's and
are listed in the final report. Eighth of nine projects that bring
Superhuman Mail's features to Makosh Mail.

## Intent

Superhuman offers an MCP server so an assistant outside it (Claude
Desktop, ChatGPT, Cursor) can search and read the owner's mail. Makosh
Mail's mail reaches agents inside BB only (tools, the `bb makosh-mail`
command in an agent thread).

## Goals

- A local MCP server (stdio, one file, no dependencies) that an outside
  assistant on this computer starts. Tools: `mail_accounts`,
  `mail_search`, `mail_read` — the same answers BB's own agents get: only
  mail inside AI access, secrets hidden, text marked as untrusted, every
  call in the agent log.
- One switch, `mcpAccess`, off by default. Off: every tool answers that
  the owner has not allowed it.
- Mail settings → Agents shows how to connect: a button saves the server
  file, and the block to paste into the assistant's MCP settings is shown
  with the saved path.

## Non-goals

- Writing: no proposing, sending, archiving or labelling from outside BB.
  A proposal needs BB's card and the owner's Send; there is no thread to
  show it in.
- A network endpoint (HTTP, a tunnel, OAuth): stdio on this computer only.
- Remote assistants (a web chat that cannot start a local program).

## Anti-goals

- A path around AI access, redaction or the log: the server has no access
  of its own; it only runs `bb makosh-mail … --assistant --json`, and that
  mode goes through the same functions as agent tools.
- Mail text treated as instructions: every text field is returned inside
  the same untrusted-data wording the tools use.
- A secret in the file or its configuration: the file holds no token; it
  works only where `bb` works, as the owner's user.

## How

- **CLI.** `bb makosh-mail accounts|search|read` gain `--assistant`. With
  it the call is an outside assistant's: refused unless `mcpAccess` is on;
  search and read go through `agentSearch` / the agent read (scoped,
  redacted, screened), logged with the actor `mcp`. Without the flag
  nothing changes.
- **Server file** `makosh-mail-mcp.mjs` (Node 18+, standard library
  only): MCP over stdio (JSON-RPC 2.0, newline-delimited): `initialize`,
  `notifications/initialized`, `ping`, `tools/list`, `tools/call`. A tool
  call runs the `bb` command with arguments passed as an argument array
  (never through a shell), a 30-second limit and a 1 MB output limit, and
  returns the JSON as text content; a failure returns `isError` with the
  command's message. The file's text lives in the plugin
  (`src/core/mcp-server-source.ts`) and is saved by the settings page.
- **Limits.** Search: query at most 500 characters, at most 20 hits. Read:
  one message id. 60 calls an hour across the three tools (counted by the
  plugin while BB runs).

## The limit to state plainly

An assistant that can run commands on this computer by itself can call
`bb` without the flag, as the owner could. `mcpAccess` decides what the
MCP server offers; it is not a barrier against a program with a shell.

## Testing

The server file as a child process speaking MCP against a fake `bb` on
PATH (initialize, list, a call, an unknown tool, a failing command, bad
JSON, the argument array); the CLI mode (off by default, scope and
redaction as agents, the `mcp` log rows, the hourly limit); the settings
block.
