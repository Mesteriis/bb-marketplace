Chertog (Чертог) is a tiling workspace for BB. Its page shows several of your
existing threads side by side, in tiles and tabs, and keeps named layouts of
them. The interface is in Russian.

## What you get today

- **A workspace page.** "Чертог" in BB's navigation opens a page whose tiles
  and dividers fill the whole area. BB's own list of projects and threads
  stays beside it.
- **Threads in tiles.** Pick an existing thread for a tile or a tab. The tile
  header shows the thread, its project and what the agent is doing. Chertog
  never creates, forks or stops a thread.
- **Rearranging.** Split, drag a tile or a tab, resize by a divider, maximize
  and restore, with the mouse or the keyboard (Alt+arrows to move the focus,
  Alt+Shift+arrows to move a tab, Ctrl+Alt+arrows to move a tile, Alt+Enter to
  maximize).
- **Named layouts.** Create a layout from the open one, rename, duplicate,
  delete and switch. A panel shared by two layouts is the same live panel in
  both: its draft and scroll position survive the switch.
- **Leaving and coming back.** Open a thread in BB, return to Chertog, and the
  panels you had open are still there, not reloaded.
- **Three separate actions.** "Убрать из раскладки" hides a panel and keeps it
  running; it is listed under "Скрытые панели". Closing a panel releases it,
  and asks first when that would end its session. A session is ended only by
  the command "Чертог: завершить сессию выбранной панели".
- **A command for the chosen tile.** "Чертог: перейти к вводу выбранного
  тайла" focuses the composer of the thread in the focused tile.
- **Saving.** Layouts are saved on this BB server after every change. Two
  windows that change them at once are merged, and nothing either made is
  lost. A failed save is shown and leaves your layout on screen.

## Limits

- BB's Home button does not open Chertog. BB has no setting for another Home
  page.
- The redirect from BB's new thread screen to Chertog and the acceptance test
  panel wait for two plugin settings that this version does not declare yet.
  Until then both are off, and that screen shows an empty "Чертог" heading.
- The command for the chosen tile is unavailable when its thread is on screen
  twice, for example in a tile and in BB's own pane.
- Panels for Telegram, Zoom, Remote Hub, the editor and diffs are not built.
- One workspace per BB server, and one Chertog page per window. Moving panels
  between windows and monitors is not built.
- A page reload or an app restart reopens the layouts and loads their panels
  again. Panels stay alive only while the window stays open.
- Checked in a test BB in a browser. Not yet checked in BB Desktop or with
  running agents.

## Data

Stored on your BB server, in the plugin's own storage: layout names, the tile
arrangement, and for each panel the id of its thread. No message text, drafts,
titles or credentials are stored. Nothing is sent anywhere else.
