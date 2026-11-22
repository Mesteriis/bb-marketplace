# Chertog

Chertog (Чертог) is a plugin for [BB](https://github.com/get-bb/bb): a tiling
workspace with named layouts whose panels stay alive while they are
rearranged. The implementation brief is [docs/spec.md](./docs/spec.md). See
[PLUGIN_OVERVIEW.md](./PLUGIN_OVERVIEW.md) for what it does today.

This version is stage A of the brief in one window: existing BB threads and a
controlled test frame in tiles, two or more named layouts, saving through the
plugin's RPC.

## Names

The package is `bb-plugin-chertog` and the plugin id BB derives from it is
`chertog`. Both are fixed by the brief, so this plugin does not follow the
`bb-plugin-makosh-<name>` convention in
[docs/architecture.md](../../docs/architecture.md).

## What it registers in BB

| Surface | What it is |
| --- | --- |
| `navPanel` `chertog-home`, route `/plugins/chertog/home` | The workspace: the tile surface on the whole route. Its controls sit in BB's title bar (`experimental_headerTitle`, `headerContent`), not in the page. No `experimental_sidebar`, so BB's thread list stays. |
| `experimental_appOverlay` `chertog-live-panels` | The parent of live panels for the life of the window. See below. |
| `homepageSection` `chertog-home-redirect` | Sends an accidental arrival on the stock Home to the route ([docs/home-redirect.md](./docs/home-redirect.md)). Off until the setting below is declared. |
| Command `focus-tile-composer` | Focuses the composer of the thread in the focused tile. |
| Command `end-panel-session` | Ends the session of the focused panel. The only way a session is ended. |
| RPC `load_workspace`, `save_workspace` | The workspace document in the plugin's key-value storage. |
| HTTP `GET /fixtures/live-frame.html` | The controlled frame page for acceptance. |

### Integrate with Chertog

Any BB plugin can ask an open Chertog window to show a thread or a provider
panel as a tile by dispatching the same-document `chertog.open.v1` event. The
page answers in the event's `detail` before dispatch returns, and the plugin
falls back to its own action only when `detail.accepted` is false. Format,
sender snippet and providers: [docs/open-wire-v1.md](./docs/open-wire-v1.md).

### Why live panels live in the overlay

BB unmounts a nav panel when the user leaves its route and mounts a new one on
return (observed on BB 0.50.1: a marker made at mount changed after a visit to
the new thread screen, the overlay's did not). A panel inside the route would
lose its DOM on every visit to a thread. So the route draws tile chrome only
and reports the rectangle of its surface and of each content area; the
overlay, mounted once per window, places the panel containers there and hides
them while no route is on screen.

The overlay has no z-index and takes no pointer events outside the panel
containers. BB's palette and dialogs are drawn above it and the sidebar is
outside the measured rectangle. Because the overlay is above the route, the
route makes two concessions: a panel steps aside while the menu of its tile is
open, and panels turn translucent while a tile is dragged so the drop preview
shows.

### Settings

The server declares five boolean switches with `bb.settings.define`. A window
reads them through `useSettings()`; the server reads the last two (below).
Until BB delivers the values nothing of the workspace is mounted, and a key
that is missing reads as on, so an installation that never saw a switch keeps
its behavior.

| Key | Meaning | Default |
| --- | --- | --- |
| `homeRedirect` | "Открывать Чертог вместо штатного Домой". Never redirects while `tileSpace` is off | on |
| `acceptanceFixture` | "Тестовая панель для приёмки": the content picker offers the test panel | off |
| `tileSpace` | "Тайловое пространство": turns the in-window workspace on and off | on |
| `navigationPart` | "Навигация": enables or disables the `makosh-navigation` plugin | on |
| `threadListPart` | "Список тредов": enables or disables the `makosh-sidebar` plugin | on |

With `tileSpace` off, the window mounts no live layer, window overlay,
`chertog.open.v1` listener or thread subscription. A request for a tile stays
unanswered (`accepted: false`), so Makosh Sidebar opens the thread as usual.
BB's title bar on the Chertog route shows only the name, the page shows one line
saying the workspace is off, the Home redirect does not fire, and the tile
commands do nothing. Saved layouts are not touched and return when it is on
again; the switch takes effect when BB delivers the new value, without a reload.

`navigationPart` and `threadListPart` stand in until Navigation and the thread
list are absorbed into Chertog (`docs/absorption-design.md`). The server checks
them at start and on every settings write (`handle.onChange`): switch off and
plugin on, it calls `bb.sdk.plugins.disable`; switch on and plugin off, `enable`;
a plugin that is not installed is left alone with one log line. A refusal is
logged once per new state and retried at the next write. The rule is
`decidePartAction` in `src/core/parts`; the calls are in
`src/adapters/bb/server/parts-sync.ts`.

### Addressee of a command

A command for the chosen tile looks in `useComposers()` for a composer with
`scope.kind === "thread"` and the tile's exact `threadId`, and acts only when
there is exactly one. The tile and the composer are fixed before any
asynchronous work and checked again after it. Nothing is chosen by the DOM,
the address bar or the last focus.

## Layout

| Path | Holds |
| --- | --- |
| `src/core/` | Layout tree, panel registry, workspace document, Home redirect rule, wire schemas. No host code. |
| `src/ui/` | Tile surface, live host layer, workspace chrome. React with props only. No host code. |
| `src/adapters/bb/app/` | The window side: workspace controller and session, the `bb-thread` and `fixture-frame` sources, the route and the live layer, registration. |
| `src/adapters/bb/home/` | The Home redirect section. |
| `src/adapters/bb/server/` | The workspace store, its RPC and the fixture route. |
| `server.ts`, `app.tsx` | Composition for BB. |
| `tests/architecture.test.ts` | Fails the build when `src/core` or `src/ui` imports host code. |

## Develop

```sh
npm install
npm run check   # typecheck and tests
npm run build   # bb plugin build
```

The isolated stand for a run in a real BB is described in
[docs/e2e-stand.md](./docs/e2e-stand.md). Do not install a development build
into a working BB.

## Not verified

- BB Desktop: the stand is the web surface of BB 0.50.1.
- `ThreadChat` in tiles with real threads: two chats in one window, drafts,
  scroll, the command for the chosen tile. The stand has no project and no
  signed-in provider.
- The redirect of the stock Home and the test panel in a running BB: both
  wait for the settings.
