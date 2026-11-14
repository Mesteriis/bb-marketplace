# Architecture

This repository holds the Makosh plugins for [BB](https://github.com/get-bb/bb).
Each plugin is a self-contained directory under `plugins/`, with its own
`package.json` and lockfile, because BB installs a plugin by running
`npm install` and a build inside that directory.

## A plugin must outlive its host

BB is the host today. A Tauri shell is the planned next one. A plugin must move
between hosts by replacing adapters, not by being rewritten, so every plugin
keeps host code at the edge.

| Layer | Path | Holds | May import |
| --- | --- | --- | --- |
| Core | `src/core/` | Domain types, ports (interfaces), application logic | `zod`, itself |
| UI | `src/ui/` | React components that take data and callbacks through props | `react`, the core, the vendored design system (`@/components`, `@/lib`, `@/hooks`) |
| Adapters | `src/adapters/<host>/` | One host's implementations of the core's ports | anything |
| Entry points | `server.ts`, `app.tsx` | Composition: build adapters, expose the core, mount the UI | anything |

Rules:

- The core reaches the outside world only through a port it declares. Storage,
  secrets, network sockets, the clock, and the AI assistant are all ports.
- The core does not import `node:` modules. Code that needs a raw TCP socket
  (IMAP, SMTP) sits behind a port, because a Tauri webview has no Node: there
  the adapter is a Rust command. Protocols that run over `fetch` (Gmail API,
  Microsoft Graph, JMAP) can live in the core's own modules.
- The UI never calls the host. A host entry point fetches data and passes it
  down; user actions go back up through callbacks.
- Wire contracts are plain `zod` schemas in the core. `server.ts` wraps them
  for BB RPC; another host wraps the same schemas for its own transport.
- `components/ui/` is the design-system seam. It is vendored BB source today,
  and another host swaps it for components with the same exports.

`tests/architecture.test.ts` in each plugin enforces the import columns above
and fails the build on a violation.

## What changes when the host changes

| Concern | BB | Tauri |
| --- | --- | --- |
| Backend process | `server.ts` in the BB server (Node) | Rust commands, or a Node sidecar |
| Front end | `app.tsx` registered with `definePluginApp` | A React root in the webview |
| Core ↔ UI transport | BB RPC and realtime | `invoke` and events |
| Storage | `bb.storage` (key-value, SQLite) | Tauri store and SQL plugins |
| Secrets | BB secret settings | OS keychain |
| AI assistant | BB threads, agent tools, skills | The shell's own agent bridge |

Only the first two rows of the layer table are shared code. Everything in this
table is an adapter.

## Sharing code between plugins

Plugins do not import each other's files, and there is no npm workspace at the
repository root: a workspace would change how `npm install` behaves inside a
plugin directory and break BB's Git installs. Code that two plugins need is
published as an npm package and listed in each plugin's `dependencies`.

## Names

| Thing | Convention | Mail plugin |
| --- | --- | --- |
| Directory | `plugins/<name>` | `plugins/mail` |
| Collection entry (`.bb/plugins.json`) | `<name>` | `mail` |
| Package name | `bb-plugin-makosh-<name>` | `bb-plugin-makosh-mail` |
| Plugin id (derived by BB) | `makosh-<name>` | `makosh-mail` |
| Release tag | `<name>/vX.Y.Z` | `mail/v0.1.0` |

`node scripts/check-manifests.mjs` checks that the collection manifest, the
marketplace catalog, and every plugin manifest agree on these.
