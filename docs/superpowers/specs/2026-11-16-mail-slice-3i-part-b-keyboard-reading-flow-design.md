# Makosh Mail — slice 3i, part B: Apple Mail keyboard and reading flow (Apple Mail keys, the next message after a delete, earlier messages in one closed stack)

Status: builder's design, proposed on 2026-11-16, **not yet accepted by the
owner**. Part A of 3i is
`2026-11-16-mail-slice-3i-security-privacy-design.md` (security and
privacy); this document adds part B to the same slice and changes nothing in
part A. Every decision is marked *Proposed (owner to accept)* with a safe
default; the open questions are few and each has a recommendation.
Everything in the slice-1, slice-2, 3a–3h specs and 3i part A holds unless
this document changes it. In particular: hotkeys never fire while typing
(`isTypingTarget`), letters match the physical key (`event.code`), a held key
repeats only list moves, destructive keys stay quiet for
`DESTRUCTIVE_GUARD_MS` after an action, `Mod+Z` inside an editor stays the
editor's (3d), Escape stays BB's own "back" (`app.back`), and nothing is ever
expunged except 3b's own drafts. 3g's "no BB patches" holds.

The owner's request (2026-11-16, paraphrased from Russian): take into scope
now (1) keyboard shortcuts like Apple Mail — arrows move through the list,
Backspace deletes, the rest of the map taken from Apple Mail; (2) after a
message is deleted, the next one opens; (3) when a message shows the earlier
messages of its conversation, those collapse into one closed stack that opens
on click, because today the earlier messages push the message far down.

Backlog (`docs/mail-feature-backlog.md`): #15 "Горячие клавиши" `[уже есть]`
and #54 "Управление цепочками" `[уже есть]` (3h). Part B extends both; no new
backlog number.

Points the builder could not verify are marked **[unverified]** and collected
in "Not verified" at the end.

## Owner's decisions

Numbered B1–B10 so they do not clash with part A's 1–10.

B1. **Both key sets.** The Gmail-style single keys stay exactly as they are;
    Apple Mail keys are added beside them. *Proposed (owner to accept).*
    Removing a key the owner already uses would be a regression; the two sets
    do not overlap (Apple's are arrows, Backspace/Delete and Command chords,
    Gmail's are plain letters and symbols).

B2. **Arrows and Backspace/Delete on every platform; Command chords on macOS
    only.** Up/Down, Shift+Up/Down, Backspace, Delete (⌦) work everywhere.
    The Apple Mail Command chords (⌘R, ⌃⌘A, …) are bound only when the page
    runs on macOS. *Proposed (owner to accept).* On Windows and Linux the
    same chords with Ctrl collide with browser and OS keys (Ctrl+R, Ctrl+N,
    Ctrl+Shift+J, Ctrl+Shift+R …) and Apple's map has no Ctrl version there;
    the letters already cover those platforms.

B3. **Only chords BB does not own.** A chord that BB 0.49.0 binds by default
    (⌘N, ⇧⌘N, ⌘F, ⌘P, ⌘K, ⌘1–9, …) is never bound by Mail, even though the
    page could `preventDefault` some of them. *Proposed (owner to accept).*
    Taking BB's keys inside one plugin page would make BB behave differently
    on the Mail page; the fallback is the Gmail letter (`c` for New message,
    `/` for search, Shift+P for print). Full list in "Keys that are not
    bound".

B4. **Up/Down by focus zone.** In the list (or anywhere on the page outside
    the conversation) Up/Down are `k`/`j`: move the cursor, and open the row
    when a conversation is already open. On a message header or the
    "earlier messages" stack in the conversation, Up/Down move focus between
    the headers. Anywhere else inside the conversation (the message text,
    a toolbar) Up/Down keep the browser's own scrolling. *Proposed (owner to
    accept).* Apple Mail scrolls the message when the message has focus;
    taking the arrows there would make a long message unscrollable by
    keyboard.

B5. **After delete, archive, junk, move or snooze of the open conversation,
    the next one opens** — the row below; at the end of the list, the row
    above; no rows left → the empty state. The same for the reading pane's
    toolbar, the hotkeys, the Apple chords and drag-to-folder (every path
    through `threadsAction`, plus snooze). *Proposed (owner to accept).*
    This is Apple Mail's behaviour; opening marks the next conversation read,
    as any open does.

B6. **Multi-selection: the cursor moves, nothing opens.** After a removing
    action on a selection, the cursor goes to the first remaining row after
    the last removed one (else before the first); the reading pane shows the
    empty state. *Proposed (owner to accept).* With a selection no
    conversation is open (its panel hides it, `SelectionPanel`), and opening
    a conversation the owner never chose would mark it read unseen.

B7. **Undo brings the conversation back and reopens it** when the reading
    pane still shows the conversation the action opened (or nothing);
    otherwise the restored row only takes the cursor. *Proposed (owner to
    accept).* It undoes the visible effect without overriding a choice the
    owner made after the action.

B8. **Earlier messages collapse into one closed stack.** When a conversation
    opens, the messages before the first "anchor" (the message the owner
    opened, a message that was unread when the conversation opened, or any
    message the owner expanded) collapse into one closed stack — "N earlier
    messages" — when there are two or more of them. A click, Enter or Space
    opens it; `;` (Expand all) opens it with everything; Collapse all closes
    it again. *Proposed (owner to accept).* The newest (or the target)
    message sits right under the conversation header; nothing is hidden that
    the owner has not read.

B9. **Order stays oldest → newest.** The stack sits above the shown messages,
    in date order, as print, `;` and "Load the whole conversation" already
    assume. *Proposed (owner to accept).* A "newest at the top" order (an
    Apple Mail setting) would change print, quotes, citations and the agent
    text order; it is listed for another slice.

B10. **Keys typed inside a message body reach the page.** The message frame
    forwards key presses from its document to the page, so hotkeys (and
    Backspace) still work after a click into a message's text. *Proposed
    (owner to accept).* Today a click into the sandboxed frame silently
    turns every hotkey off (the frame's events never reach the page root).

## Goals

- Apple Mail's list keys (Up/Down, Shift+Up/Down, Backspace, Delete) and its
  Command chords that BB leaves free, layout-independent, never while typing.
- After a removing action on the open conversation, the next conversation
  opens; undo restores and reselects.
- An opened conversation shows its newest or target message near the top;
  earlier messages wait in one closed stack.
- The `?` sheet, README, CHANGELOG and backlog say exactly what is bound.

## Non-goals (later or backlog)

- Rebinding keys in BB's own Keyboard settings via `app.commands.register`
  with `defaultShortcut` (sdk `PluginCommandRegistration`, app 22320–22350).
  Those commands are BB-wide, not page-local, and "conflicting defaults
  remain unbound"; worth a later look, not needed now.
- Apple Mail's composer extras (⇧⌘A attach, ⇧⌘V paste as quotation, ⌥⌘B
  Bcc, ⌥⌘R Reply-To, ⇧⌘T format, ⌥⌘I append), Redirect (⇧⌘E, no feature),
  Move Again, Get new mail by key, the message-list filter (⌘L), Show all
  headers / raw source chords — later, unscheduled.
- "Newest message at the top" order (B9).
- Space to page through a message and jump to the next unread.

## Anti-goals

- Taking a key BB owns (B3), patching BB, or a capture-phase listener on
  `window` to beat BB's dispatcher.
- A destructive key that can fire from a text field, the composer, a dialog,
  a menu, a select or during IME composition.
- Expunging anything: ⌥⌘J "Erase junk mail" is deliberately not bound.

## Design

### Code, SDK and host facts this design relies on

Line numbers are in the current tree (`plugins/mail/…`) unless marked
"host" (BB 0.49.0 in the owner's installation,
`~/Library/Application Support/Makosh BB Backend/runtime/node_modules/bb-app/`,
server `server/dist/start-server.js`, client
`app/dist/assets/index-UJHlXnMg.js`) or "app" (`node_modules/@get-bb/plugin-sdk/bundled-types/bb-plugin-sdk-app.d.ts`).

| Fact | Where |
| --- | --- |
| `matchKey` returns null for any Ctrl/Alt/Meta or `isComposing` key, then for a typing target; letters by `event.code`; no arrow, Backspace or Delete is matched today. | `src/ui/shortcuts.ts` 118–190 |
| `isTypingTarget`: `input`, `textarea`, `select`, `isContentEditable`, and anything inside `[contenteditable]`, `[data-mail-composer]`, dialogs, listbox/option/combobox, menus, `[role="textbox"]`. | `src/ui/shortcuts.ts` 68–79 |
| `matchShortcut` drops held (`repeat`) keys except `next`/`previous`. | `src/ui/shortcuts.ts` 109–116 |
| Destructive set `archive`, `delete`, `spam`, `move`; the guard quiets them for 400 ms after an action. | `src/ui/shortcuts.ts` 195–243 |
| `SHORTCUT_SHEET` (sections Navigation, Actions, Writing; `keys: string[]`); the sheet renders each key as `<kbd>`. | `src/ui/shortcuts.ts` 252–306; `src/ui/shortcut-sheet.tsx` 36–53 |
| `useShortcuts` is a React `onKeyDown` on the page root (`tabIndex={-1}`); it calls `preventDefault` on a match and skips `defaultPrevented` events. | `src/ui/shortcuts.ts` 312–344; `src/ui/mail-page.tsx` 999–1004 |
| Rows: `rowIds` are search hits, a non-grouped folder's messages, or threads; `step(delta, repeat)` moves the cursor and opens the row when a conversation is open, nothing behind a selection. | `src/ui/mail-page.tsx` 585–587, 710–718 |
| When an action takes the cursor row off the list, the cursor goes to the next row, else the previous (`shownRows` effect) — but nothing opens. | `src/ui/mail-page.tsx` 589–608 |
| `targets()`: the selection, else the open conversation, else the cursor row (grouped lists only). `runAction` → `props.onThreadsAction`; `REMOVING_ACTIONS` = archive, delete, spam, not_spam, move. | `src/ui/mail-page.tsx` 413, 668–691 |
| `openRow` opens a hit (search: whole conversation; non-grouped folder: `singleMessage`) or a thread. `toggleSelection(rowIds, selection, id, range, anchor)` does Shift ranges. | `src/ui/mail-page.tsx` 692–705, 733–736; `src/ui/selection-bar.tsx` 15 |
| `threadsAction`: on success of a moving action it filters the list and, if the open conversation is among the done ones, calls `closeThread()`; snooze does the same. Failed conversations stay selected. | `app.tsx` 1272–1353 (1318), 2045–2105 (2089) |
| `selectThread(threadId, messageId, accountId)` opens a conversation; `closeThread()` resets `reading`. | `app.tsx` 962–980 |
| `loadThread` on first open expands `focusId` or the newest message, then marks every unread message of the conversation read (`markOpened`), after the first `setReading({ detail })`. | `app.tsx` 925–960, 879–897 |
| Undo: `lastUndo` (`{ id, moving }`), `recordUndo`, `undo(undoId, moving)` → `action_undo`; "Moving back…" until the next mail-changed; `z` and the toast both call it. | `app.tsx` 630, 1213–1265, 3881 |
| A conversation's messages come oldest first (`OLDEST_FIRST`); the pane renders every message as a `MessageItem` card whose header is a `<button aria-expanded>`; expanded state is `reading.expandedIds`. | `src/adapters/bb/sqlite-store.ts` 1410; `src/ui/reading-pane.tsx` 418–480, 947–976 |
| `;` / Expand all / Collapse all: `expandAll(expand)` toggles every message (Collapse keeps the newest open) and sets `quotesAll`. | `src/ui/mail-page.tsx` 800–811, 910–915; `src/ui/reading-pane.tsx` 870–880 |
| "Load the whole conversation" (3h) status line and button; print takes the whole `messages` list; per-message plain/original switches live in `ReadingPane` state keyed by thread. | `src/ui/reading-pane.tsx` 663–677, 883–900, 986–1001 |
| `messageToHand`: the newest expanded message, else the newest — used by reply, translate, BB actions. | `src/ui/reading-pane.tsx` 652–658 |
| The message frame is `sandbox="allow-same-origin"`; the parent already attaches `click`/`auxclick` listeners to its `contentDocument`; no keydown listener. | `src/ui/message-frame.tsx` 271–301, 309–318 |
| Thread ids are `t_<root message row id>` (`buildThreads`). | `src/core/threading.ts` 231 |
| BB 0.49.0 default keys (mac): ⌘[ / ⌘] history; ⇧⌘P palette; ⇧⌘O and ⌘N (desktop) new thread; ⌘K thread search; Escape `app.back`; ⌘, settings; ⌘\ sidebar; ⇧⌘[ / ⇧⌘] previous/next thread (desktop); ⌘1–9 thread jump (desktop); ⌃⌘←/→/↑/↓ tabs; ⇧⌃⌘ arrows pane focus (split); ⇧⌘E, ⇧⌘X (split); ⌘T, ⇧⌘T, ⌘W, ⌘J, ⌘P, ⌘O, ⇧⌘↵; ⇧⌘C, ⇧⌘M, ⌥M, ⌥P, ⌥T (BB composer/picker); ⌘F `window.find` (desktop); ⌘R, ⌘L, ⌘F only with BB's browser focused; ⇧⌘N new window (desktop); 1–9, ⌘↵, ⌘., ←/→ only in a BB question form. `window.reload`, `thread.archive`, `thread.markRead` are unassigned. | host server 211536–211915 (`DEFAULT_APP_KEYBINDINGS`, `macArrowBindings`, `numberedChatBindings`) |
| BB's dispatcher listens on `window` in the bubble phase and ignores events that are `defaultPrevented`, `isComposing` or `repeat`; only the tab and pane-focus arrow chords (⌃⌘ arrows, ⇧⌃⌘ arrows) are matched in the capture phase, before any page handler. | host client: the `S` / `x` callbacks and `addEventListener("keydown", t, !0)` beside `onAppCommand` |

Apple's page "Keyboard shortcuts in Mail on Mac",
<https://support.apple.com/guide/mail/keyboard-shortcuts-mlhlb94f262b/mac>,
fetched 2026-11-16 (version selector shows macOS 27 and 26; the page does not
date its table). It lists: ⌘N new message, ⇧⌘N get new mail, ⌘R reply, ⇧⌘R
reply all, ⇧⌘F forward, ⇧⌘E redirect, ⇧⌘D send, ⌘Z unsend, ⇧⌘U mark
read/unread, ⌃⌘M move to predicted mailbox, ⇧⌘J move to Junk, ⌥⌘J erase
junk, ⌃⌘A archive, ⌃⌘S sidebar, ⌘L message filter, ⌃⌘L apply rules, and
window/composer chords. It does **not** list delete, flag, mailbox search,
next/previous message, arrows, conversation expand/collapse, print or
headers. Those rows below come from Apple Mail's own menus and behaviour as
the builder knows them, marked **[unverified]** (the page itself says the
Mail menus show the current keys).

### The key map

"Mac" = bound only when the page runs on macOS (B2). Letters, arrows and
Backspace match `event.code`, so a Russian (or any) layout works; `key` is
never used for a chord.

| Action | Gmail key (stays) | Apple Mail key (new) | Apple source | Notes |
| --- | --- | --- | --- | --- |
| Next / previous conversation | `j` / `k` | ↓ / ↑ | behaviour [unverified] | B4 zones; held key repeats like `j`/`k` |
| Extend selection down / up | `x` per row | Shift+↓ / Shift+↑ | behaviour [unverified] | grouped lists only, as `x`; uses `toggleSelection(…, range)` |
| Next / previous message in the conversation | — | ↓ / ↑ on a message header or the stack | ours | moves focus only |
| Open | `o`, Enter | Enter | — | unchanged |
| Delete | `#` | Backspace, Delete (⌦); Mac also ⌘Backspace | Mail menu [unverified] | destructive guard; never in a field |
| Archive | `e` | Mac ⌃⌘A | Apple page | |
| Junk | `!` | Mac ⇧⌘J | Apple page | |
| Move to… | `v` | Mac ⌃⌘M | Apple page ("predicted mailbox") | opens Move…; Mail has no prediction |
| Read / unread | Shift+I / Shift+U | Mac ⇧⌘U (toggle) | Apple page | any unread in targets → mark read, else mark unread |
| Flag / unflag | `s` | Mac ⇧⌘L | Mail menu [unverified] | |
| Search | `/` | Mac ⌥⌘F | Mail menu [unverified] | focuses Mail's search field |
| Undo | `z` | Mac ⌘Z outside any field | Apple page ("Unsend") | inside an editor ⌘Z stays the editor's |
| Reply | `r` | Mac ⌘R | Apple page | live check (Electron reload) |
| Reply all | `a` | Mac ⇧⌘R | Apple page | live check (Electron force reload) |
| Forward | `f` | Mac ⇧⌘F | Apple page | |
| Send (composer) | ⌘/Ctrl+Enter | Mac ⇧⌘D | Apple page | composer's own handler |
| Expand / collapse all | `;` | — | — | also opens/closes the stack (B8) |

A held chord or Backspace does nothing after the first press (the `repeat`
rule); only arrows repeat.

### Keys that are not bound, and why

| Apple key | Apple action | Why not | Fallback |
| --- | --- | --- | --- |
| ⌘N | New message | BB `thread.new` (desktop) | `c` |
| ⇧⌘N | Get new mail | BB `window.new` (desktop) | the Sync button |
| ⌘F | Find | BB `window.find` (desktop) — BB's find-in-page | `/`, ⌥⌘F |
| ⌘P | Print | BB `file.quickOpen` | Shift+P |
| ⌘1–⌘9 | Go to mailbox | BB `thread.jump.1–9` (desktop) | `g` then `i`/`s`/`d`/`t`/`a` |
| ⌃⌘S | Show/hide sidebar | the sidebar is BB's; BB has ⌘\ | ⌘\ |
| ⌘K, ⌘J, ⌘W, ⌘T, ⌘O, ⌘[, ⌘] | — | BB defaults | — |
| ⌃⌘ arrows, ⇧⌃⌘ arrows | — | BB, capture phase: the page never sees them | — |
| Escape | — | BB `app.back` | `u` back to the list |
| ⌥⌘J | Erase junk mail | would expunge (anti-goal) | Trash's own Delete |
| ⇧⌘E, ⌘L, ⌃⌘L, composer extras | redirect, filter, rules, … | no matching feature (non-goals) | — |

In a browser tab (BB's web surface) the browser may keep ⌘R and ⇧⌘R for
itself before the page sees them **[unverified]**; the letters still work.

### `src/ui/shortcuts.ts`

- `ShortcutCommand` gains `{ kind: "select_down" } | { kind: "select_up" }`,
  `{ kind: "message_next" } | { kind: "message_previous" }` and
  `{ kind: "toggle_read" }`. Archive, delete, spam, move, flag, search, undo,
  reply, reply all and forward reuse their existing kinds.
- `matchShortcut(event, afterG, platform: { mac: boolean })`. `useShortcuts`
  reads the platform once (`navigator.userAgentData?.platform` else
  `navigator.platform`, `/mac/i`) — a DOM global, no host import — and tests
  pass it explicitly.
- `keyZone(target)`: `"typing"` (`isTypingTarget`), `"header"` (inside
  `[data-mail-message-toggle]` or `[data-mail-stack]`), `"reading"` (inside
  `[data-mail-reading]`), else `"page"`.
- Order in `matchKey`:
  1. `isComposing`, `key === "Process"` (IME on some engines), or zone
     `"typing"` → null. This now runs before the modifier check, so no
     chord ever reaches a field.
  2. Mac chords (only when `platform.mac`, Meta held): the table above by
     `event.code`, with exact modifier sets (⌘R requires no Shift/Ctrl/Alt;
     ⇧⌘R requires Shift only; ⌃⌘A requires Ctrl+Meta only; ⌥⌘F requires
     Alt+Meta only). Any other Meta/Ctrl/Alt combination → null (unchanged
     behaviour for everything else).
  3. Arrows (no modifiers): zone `"page"` → `next`/`previous`; `"header"` →
     `message_next`/`message_previous`; `"reading"` → null (native scroll).
     Shift+arrows in zone `"page"` → `select_down`/`select_up`.
  4. `code === "Backspace"` or `code === "Delete"` (no modifiers) → `delete`.
  5. The existing single keys, unchanged.
- `matchShortcut`'s repeat rule lets `next`, `previous`, `message_next`,
  `message_previous`, `select_down`, `select_up` repeat; nothing else.
- `HOST_RESERVED`: an exported list of the BB chords in "Keys that are not
  bound"; a test asserts that `matchShortcut` returns null for each of them
  on Mac and that no sheet entry names one.
- `SHORTCUT_SHEET` entries gain `mac?: string[]` (the Apple chord, shown
  only on a Mac as "or ⌘R") and new rows: ↓/↑, Shift+↓/↑, Backspace/Delete,
  "↓/↑ on a message: next or previous message". The sheet says once, under
  its title: "On a Mac, Apple Mail keys work too."

### `src/ui/mail-page.tsx`

- The `Conversation` `<section>` gets `data-mail-reading` and
  `tabIndex={-1}`, so a click on message text focuses the conversation (and
  arrows scroll it) instead of the page root.
- `select_down` / `select_up`: move the cursor one row and extend the
  selection with `toggleChecked(next, true)` from the anchor (grouped lists
  only, never in one column with a conversation open — the same rule as
  `x`).
- `message_next` / `message_previous`: focus the next/previous element of
  `[data-mail-message-toggle], [data-mail-stack]` inside the conversation,
  in DOM order; at the ends, stay.
- `toggle_read`: `mark_read` if any target has unread mail, else
  `mark_unread` (through `runIfAllowed`).
- Successor (B5): a pure `successorRow(rowsBefore, isRemoved, current)` in
  `src/ui/successor.ts` (host-free): the first row after `current` that is
  not removed, else the nearest before it, else null. The `shownRows`
  effect uses the same function, so the cursor and the opened row agree.
- `runAction(ids, action, destination)`: when the action is in
  `REMOVING_ACTIONS` (or snooze), there is no selection, and the open
  conversation is among `ids`, the page computes the successor from
  `rowIds` with `isRemoved = row belongs to a conversation in ids` (search
  hits by `hit.threadId`) and passes `then: () => openRow(successor)` (or
  `then: null` when there is none) to `onThreadsAction`.
- With a selection (B6) no `then` is passed; the page records
  `afterSelection = successorRow(rowIds, removed, lastRemovedRow)` and the
  `shownRows` effect puts the cursor there when the rows change.
- `onThreadsAction(ids, action, destination?, then?)` and
  `inbox.onSnooze(ids, until, then?)` (`mail-page.tsx` 210, 1334): the new optional argument is the only
  contract change; existing callers are unchanged.

### `app.tsx`

- `threadsAction` and `snoozeThreads`: where they call `closeThread()`
  because the open conversation is done, they call `then()` instead when it
  was given **and** the open conversation is still the one the action
  started on (`latest.current.reading.threadId === snapshot.threadId`). A
  failed conversation never advances. Mark unread keeps its own "back to the
  list" (unchanged).
- B7: `lastUndo` gains `reopen: { threadId, accountId, advancedTo: string |
  null } | null`, set when an action advanced from an open conversation.
  `undo` with `outcome === "done"` and `restored > 0`, once the reverse
  moves show (the existing mail-changed wait), reopens `reopen.threadId` with
  `selectThread` if the open conversation is still `advancedTo` (or none)
  and the row is in the list again; otherwise the page cursor goes to it
  when present. If the restored conversation comes back under another id
  (its root row was re-synced) **[unverified]**, nothing reopens and the
  cursor stays — the undo itself is unaffected.

### Conversation stack (`src/ui/conversation-stack.ts`, new; `reading-pane.tsx`)

- `splitConversation(messages, { anchorIds, expandedIds, open })` (pure):
  the boundary is the first message that is in `anchorIds` or
  `expandedIds`; the messages before it form the stack when there are at
  least two and `open` is false; otherwise every message shows.
- `anchorIds` is fixed when a conversation first renders (state keyed by
  thread id, as `Switches` already is): the newest message, the `focusId`
  target, and every message whose `isRead` was false in that first
  `thread_get` (it renders before `markOpened`'s refresh, `app.tsx` 930–945).
  So messages unread at open never hide in the stack, and the layout does
  not shift when they turn read a moment later.
- Rendering: the stack is one `<button data-mail-stack aria-expanded="false"
  aria-controls=…>` styled as two offset card edges behind one card (only
  `border-border`, `bg-card`, BB tokens), with "N earlier messages" and a
  second line of up to three sender names ("Anna, Boris and 2 others") and
  the date range. Click, Enter or Space opens it; focus then moves to the
  first revealed message header. Message headers get
  `data-mail-message-toggle`.
- Opening state `open` is per conversation in the pane. `;` / Expand all
  sets it open; Collapse all closes it. A message expanded inside the
  stack's range (a citation chip — `cite` → `onToggleMessage`; Expand all)
  moves the boundary, so the message is never hidden.
- "Load the whole conversation": older messages land before the boundary
  and join the stack; when the load completes with new messages the stack
  opens, since the owner asked to see them.
- Print (`onPrint(messages)`), plain text and original colors (per-message
  switches), reply/forward/translate (`messageToHand`), related mail and the
  AI summary are unaffected: they read the full `messages` list. The
  single-message view (`onlyMessageId`, 3h) has no stack.
- A new message arriving while the conversation is open appends after the
  boundary (it is newer), so it shows.

### Message frame key forwarding (B10, `src/ui/message-frame.tsx`)

On load, beside the click listeners, the parent adds a `keydown` listener to
the frame's `contentDocument`. Unless the key's own target is a typing
target (`isTypingTarget`), it dispatches a new bubbling, cancelable
`KeyboardEvent("keydown")` with the same `key`, `code`, modifiers,
`repeat` and `isComposing` on the `<iframe>` element, and calls
`preventDefault()` on the original when the copy was prevented. The copy's
target is inside `[data-mail-reading]`, so arrows stay native, while letters,
Backspace and chords reach the page. BB's own dispatcher sees the same copy
as it would any page key. No new sandbox permission; nothing from the mail
is read.

### Destructive-key safety

- Backspace/Delete/⌘Backspace are `delete`, so they pass the destructive
  guard and `runIfAllowed` (Delete in Trash stays whatever 3a offers).
- Never in a field: the typing check now runs first for every key,
  including chords; the composer (`[data-mail-composer]`), dialogs, menus,
  selects and `[role="textbox"]` are covered by `isTypingTarget`.
- Never while composing text with an IME: `isComposing` or `key ===
  "Process"`.
- Never held: `repeat` presses are dropped.
- Never after focus fell out of the page: the root's existing `focusLost`
  logic is unchanged; BB's own pages do not receive Mail's handler.

### Composer (⇧⌘D)

The composer's existing key handler (where ⌘/Ctrl+Enter sends) also sends on
⇧⌘D on a Mac, through the same pre-send path (3d). Nothing else in the
composer changes.

### UI (summary)

- Arrows, Backspace and the Apple chords as above; the shortcut sheet shows
  Apple chords on a Mac.
- After a removing action the next conversation opens; undo reopens it.
- "N earlier messages" stack above the shown messages.

### Security and privacy

- No new data leaves the page; key forwarding copies key fields only, never
  mail content.
- Destructive keys are guarded as above; no expunge is reachable by key.
- Auto-opening the next conversation marks it read on the server (`\Seen`,
  as any open). README says so.

## Testing

Vitest + jsdom, `@testing-library/react`; async UI assertions use `waitFor`
/ `findBy…`. Each test names what it pins.

- `shortcuts.test.ts`:
  - ↓/↑ → next/previous in zone page; message_next/previous on a
    `[data-mail-message-toggle]`; null inside `[data-mail-reading]`; held
    arrows repeat, held Backspace does not.
  - Shift+↓/↑ → select_down/up.
  - Backspace and Delete → delete; null in `input`, `textarea`,
    `[contenteditable]`, inside `[data-mail-composer]`, `[role="dialog"]`,
    `[role="textbox"]`, a select's listbox; null with `isComposing` and with
    `key: "Process"`.
  - Mac chords with a Russian layout: `{ key: "к", code: "KeyR", metaKey }`
    → reply; `{ key: "Ф", code: "KeyA", metaKey, ctrlKey }` → archive; ⇧⌘J,
    ⇧⌘U, ⇧⌘L, ⌥⌘F, ⌃⌘M, ⇧⌘F, ⌘Z, ⌘Backspace.
  - The same chords with `mac: false`, and Ctrl in place of Meta → null.
  - Every `HOST_RESERVED` chord → null; no `SHORTCUT_SHEET` entry uses one.
  - Extra modifiers (⌥⌘R, ⌃⌘R) → null.
- `successor.test.ts`: middle row → next; last row → previous; several
  removed in a run; all removed → null; current not in the list → null;
  search hits removed by thread.
- `conversation-stack.test.ts`: 1 earlier message → no stack; 5 earlier
  read → stack of 5; an unread-at-open message in the middle bounds the
  stack; an expanded message inside the range moves the boundary; `open`
  shows all; messages loaded before the boundary join the stack.
- `app.test.tsx` ("Apple keys and reading flow"):
  - ↓ with a conversation open opens the next row (`waitFor` the header).
  - Backspace on an open conversation calls the delete RPC and opens the row
    below; on the last row opens the one above; on the only row shows the
    empty state.
  - The action fails for the open conversation → it stays open.
  - The owner opened another conversation while the action ran → that one
    stays open.
  - Search results: deleting the open hit's conversation opens the next hit
    of another conversation.
  - Selection of three, Backspace → nothing opens; cursor on the row after
    the last removed.
  - Undo (toast and `z`) → the conversation reopens; after the owner opened
    another one, undo only restores.
  - Backspace typed in the search field, in the composer and in the Move…
    dialog's filter deletes nothing (RPC not called).
  - ⌘N on a Mac page does not open the composer and is not prevented
    (`defaultPrevented` false).
  - A conversation with 6 messages, newest unread: one "5 earlier messages"
    button, newest expanded; click → five headers, focus on the first; `;`
    → all expanded; Collapse all → stack again.
  - A citation chip pointing into the stack expands that message (visible).
  - Print with a closed stack prints all six (the print port receives six).
  - A key pressed inside a message frame (`contentDocument` keydown) runs
    the hotkey; a key in a field inside the frame does not.
- `shortcut-sheet` render: Apple chords shown with `mac: true`, hidden
  otherwise.

### Live verification (owner's BB, after the build)

1. On the desktop app: ⌘R, ⇧⌘R and ⌘Z on the Mail page reply / reply all /
   undo and do **not** reload the window or run the Edit menu's undo. If any
   reloads, it comes out of the map and the sheet (decision pinned in the
   spec's Resolutions).
2. ⇧⌘J, ⇧⌘U, ⇧⌘L, ⌃⌘A, ⌃⌘M, ⌥⌘F, ⇧⌘F, ⌘Backspace reach the page (no
   menu, macOS or BB action first).
3. Russian layout: ⌘R and `j` work.
4. Delete the last conversation in Inbox → the one above opens; undo → it
   reopens.
5. A long conversation opens with the newest message under the header; the
   stack opens on click and with Enter.
6. Click into a message body, press `j` and Backspace → they work.

## Tasks

Each task ends with `npm run check`; the last also runs `npm run build` and
`node ../../scripts/check-manifests.mjs` (only if `package.json` or listing
text changed). Paths are under `plugins/mail/`.

1. **Keys.** `shortcuts.ts`: zones, arrows, Backspace/Delete, Mac chords,
   `HOST_RESERVED`, repeat rule, sheet rows and `mac` keys;
   `shortcut-sheet.tsx` (+ tests).
2. **Successor and page wiring.** `successor.ts`; `mail-page.tsx`: zones'
   data attributes, `select_*`, `message_*`, `toggle_read`, `then` on
   removing actions and snooze, selection cursor (+ tests).
3. **App.** `threadsAction` / `snoozeThreads` `then`; undo reopen (+ app
   tests).
4. **Conversation stack.** `conversation-stack.ts`; `reading-pane.tsx`
   stack button, header attributes, `;`/Collapse/Load/cite interplay (+
   tests).
5. **Frame forwarding and composer ⇧⌘D.** `message-frame.tsx`,
   `composer.tsx` (+ tests).
6. **Docs.** `README.md` hotkeys paragraph (arrows, Backspace/Delete, Apple
   chords on a Mac, what is not bound and why; next conversation opens and
   is marked read; the stack); `CHANGELOG.md`; `PLUGIN_OVERVIEW.md` only if
   its hotkey line changes; `docs/mail-feature-backlog.md` #15 and #54 gain
   "Срез 3i (часть B)". `bb.description` and `marketplace.json` unchanged
   unless the one-line description changes. `THIRD_PARTY_NOTICES.md`
   unchanged (nothing ported).

## Calls made by me (not the owner)

- Page-local handling through the existing root `onKeyDown`, not BB plugin
  commands: no BB-wide keys, and BB's bubble-phase dispatcher already skips
  events Mail prevented.
- ⌃⌘M ("move to predicted mailbox") opens Move…: Mail has no prediction,
  and Move… is the nearest action under the same chord.
- ⇧⌘U is one toggle (Apple's), while Shift+I / Shift+U stay separate.
- The successor uses the rows as shown when the action started; a list that
  changes meanwhile (new mail) does not retarget it.
- The stack threshold is two: one earlier message is just its card.
- Arrow focus between message headers moves focus only; it never expands or
  marks anything read.

## Open questions for the owner

Each has a recommended default that the design above implements.

1. **↓/↑ with nothing open:** move the cursor only (proposed), or open the
   row as Apple Mail does (and mark it read)? *Recommendation:* cursor only;
   Enter opens. Once a conversation is open, arrows open as in Apple Mail.
2. **After a multi-selection delete:** cursor only (proposed) or open the
   next conversation? *Recommendation:* cursor only (B6).
3. **⌘R / ⇧⌘R / ⌘Z** bound on the desktop app (proposed, subject to the
   live check), or left out to be safe? *Recommendation:* bind; the live
   check removes any that reloads.
4. **Stack scope:** collapse every earlier read message (proposed), or keep
   the first message of the conversation visible above the stack (Gmail's
   style)? *Recommendation:* collapse all earlier; the first message is one
   click away.

## Items proposed for another slice

- BB plugin commands with rebindable defaults (`app.commands.register`).
- Newest-first conversation order (B9).
- Apple Mail composer chords, Redirect, Move Again, message filter (⌘L).

## Not verified

- Apple Mail chords for Delete (⌫, ⌘⌫), Flag (⇧⌘L) and Mailbox search
  (⌥⌘F), and Apple Mail's arrow/Shift+arrow list behaviour: not on Apple's
  shortcuts page (fetched 2026-11-16); from the Mail menus as the builder
  knows them.
- Whether BB desktop's Electron menu has accelerators for ⌘R, ⇧⌘R or ⌘Z
  that act before or instead of the page (BB's own key table leaves
  `window.reload` unassigned, which suggests not). Live step 1.
- Whether a browser tab lets the page prevent ⌘R / ⇧⌘R (web surface).
- Whether a conversation moved back by undo keeps its thread id (`t_<root
  row id>`; the root row may be re-synced under a new id). If not, undo does
  not reopen (B7 falls back to the cursor).
- That the first `thread_get` render always precedes the refresh that
  follows `markOpened`, so "unread at open" is captured (`app.tsx` 930–945
  orders them; a mail-changed refresh racing in between would only shrink
  the anchors to the target and newest).
- That a re-dispatched `keydown` on the `<iframe>` element reaches React's
  root listener in BB desktop as in jsdom (it is an ordinary bubbling DOM
  event).
