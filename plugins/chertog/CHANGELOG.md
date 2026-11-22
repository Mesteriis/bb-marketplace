# Changelog

## Unreleased

- Workspace controls moved into BB's title bar (focused tile and its menu on the left; layouts, "+ Панель", "Скрытые панели", "Новый тред" on the right, folded into "Ещё" below 880 px). Tiles get a 24 px bar with "+ ⋯ ▢ ✕", a 6 px gap, rounded corners and a darker border on the focused tile; the thread handoff moved from a row over the thread into the tile menu.
- Click in the thread list opens a tile (Makosh Sidebar sends `chertog.open.v1`), subthreads open as linked blocks beside their parent, tiles have "Открыть рядом…", the parent's keyboard move and close take the block along, and a window without a shown Chertog page answers open requests `not-shown`. Stand record: docs/acceptance-open.md.
- Stage A in one window. The "Чертог" page shows the tile surface on the whole route with BB's thread list beside it: existing threads in tiles and tabs, split, drag, resize, maximize, keyboard equivalents, and named layouts created, renamed, duplicated, deleted and switched from the toolbar.
- Live panels are kept for the life of the window in an app overlay, because BB remounts a nav panel on every return to its route. Leaving for a thread and coming back shows the same panels.
- Layouts are saved through the plugin's RPC after every change, one save at a time, against the revision they were made from. A conflict with another window is merged and reported; a failed save is shown and keeps the window's state.
- Removing a panel from the layout hides it and keeps it running, closing releases it and asks first when that ends a session, and a session is ended only by its own command.
- Commands: "Чертог: перейти к вводу выбранного тайла" and "Чертог: завершить сессию выбранной панели".
- The Home redirect section and the acceptance test panel are wired to the settings `homeRedirect` and `acceptanceFixture`. The server does not declare them yet, so both are off.
- Package scaffold: manifest, the host-agnostic `src/core` and `src/ui` layers with their import check, the BB adapter layer, and the entry points.
