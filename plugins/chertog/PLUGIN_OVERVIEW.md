Chertog (Чертог) is a tiling workspace for BB. Its page shows several of your
existing threads side by side, in tiles and tabs, and keeps named layouts of
them. The interface is in Russian.

## What you get today

- **A workspace page.** "Чертог" in BB's navigation opens a page of tiles
  with BB's thread list beside it.
- **Controls in BB's title bar.** The focused tile and its menu on the left;
  layouts, "+ Панель", "Скрытые панели" and "Новый тред" on the right, folded
  into "Ещё" when the bar is under 880 px. Each tile has a 24 px bar with "+ ⋯ ▢ ✕".
- **Threads in tiles.** Pick an existing thread for a tile or a tab; the
  header shows its project and status. Chertog never creates or stops a thread.
- **Click opens a tile.** With Makosh Sidebar installed and the Chertog page
  shown, a plain click on a thread row puts the thread into a tile and the
  address stays; a second click focuses it. Modifier clicks and clicks while
  the page is not shown stay BB's own navigation.
- **Linked blocks.** A subthread opens beside its parent: the first to the
  right, the next below, more than three as tabs. "Открыть рядом…" in a tile
  menu adds a picker to the block. Moving or closing the parent takes the
  block along; closing asks once "Закрыть вместе с подчинёнными (N)?".
- **Open request.** Other plugins ask for a tile with the `chertog.open.v1`
  window event and get the outcome at once (docs/open-wire-v1.md).
- **Rearranging.** Split, drag a tile or a tab, resize by a divider, maximize
  and restore, with the mouse or the keyboard (Alt+arrows to move the focus,
  Alt+Shift+arrows to move a tab, Ctrl+Alt+arrows to move a tile, Alt+Enter to
  maximize).
- **Named layouts.** Create, rename, duplicate, delete and switch. A panel
  shared by two layouts is the same live panel in both.
- **Three separate actions.** "Убрать из раскладки" hides a panel and keeps it
  running ("Скрытые панели"). Closing releases it, asking first when that would
  end its session. Only "Чертог: завершить сессию выбранной панели" ends one.
- **Saving.** Layouts are saved on this BB server after every change; two
  windows changing them at once are merged. A failed save is shown.
- **Provider entry cards.** Choose Terminals, Telegram, Zoom or a Remote Hub protocol.
- **Embedded views.** Choose Telegram, Zoom, SSH, RDP or VNC in the content picker. A compatible provider draws its picker and confirms the selected resource in the same tile.
- **File previews and diffs.** Select a ready workspace and a file. Compare the file at two available Git revisions inside a tile.
- **Presets.** Start from «Команда агентов», «Администрирование» or «Созвон». Choose the individual targets in the resulting tiles.
- **Thread handoff.** Transfer an existing thread to another participating BB window after confirmation, from the tile menu.

## Limits

- The homeRedirect setting controls the redirect from the stock Home screen. The acceptanceFixture setting exposes the test frame.
- Telegram, Zoom, Remote Hub and Terminals keep their full screens and sessions in their own plugins. Saved entry cards still open the provider page. Embedded views require an owner that supports chertog.embed.v1.
- One workspace per BB server and one Chertog page per window. Thread handoff covers an existing BB thread. External calls and media stay with their provider.
- A reload reopens the layouts and loads their panels again.
- Click-to-tile and blocks: isolated stand, headless browser, seeded threads (docs/acceptance-open.md). Tile look and title bar: same stand, 1440x900 and 1280x600 (docs/acceptance-tile-chrome.md). Other features were checked in a test BB in a browser. Not checked in BB Desktop or with running agents.

## Data

Stored on your BB server, in the plugin's own storage: layout names, the tile
arrangement, and panel references such as thread IDs, workspace-relative file paths and commit IDs. No message text, drafts,
titles or credentials are stored. Nothing is sent anywhere else.
