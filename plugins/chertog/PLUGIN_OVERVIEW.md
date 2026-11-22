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
- **Provider entry cards.** Choose Terminals, Telegram, Zoom or a Remote Hub protocol. Opening a card takes you to the provider when you request it. File, thread and terminal targets are chosen explicitly.
- **Embedded views.** Choose Telegram, Zoom, SSH, RDP or VNC in the content picker. A compatible provider draws its picker and confirms the selected resource in the same tile. Layouts keep its opaque UUID. A missing response leaves the result unknown.
- **File previews and diffs.** Select a ready workspace and a file. Compare the file at two available Git revisions inside a tile.
- **Presets.** Start from «Команда агентов», «Администрирование» or «Созвон». Choose the individual targets in the resulting tiles.
- **Thread handoff.** Transfer an existing thread to another participating BB window after confirmation.

## Limits

- The homeRedirect setting controls the redirect from the stock Home screen. The acceptanceFixture setting exposes the test frame.
- The command for the chosen tile is unavailable when its thread is on screen
  twice, for example in a tile and in BB's own pane.
- Telegram, Zoom, Remote Hub and Terminals keep their full screens and sessions in their own plugins. Saved entry cards still open the provider page. Embedded views require an owner that supports chertog.embed.v1.
- One workspace per BB server and one Chertog page per window. Thread handoff covers an existing BB thread. External calls and media stay with their provider.
- A page reload or an app restart reopens the layouts and loads their panels
  again. Panels stay alive only while the window stays open.
- Checked in a test BB in a browser. Not yet checked in BB Desktop or with
  running agents.

## Data

Stored on your BB server, in the plugin's own storage: layout names, the tile
arrangement, and panel references such as thread IDs, workspace-relative file paths and commit IDs. No message text, drafts,
titles or credentials are stored. Nothing is sent anywhere else.
