# Makosh Mail — slice 3i, part B: Apple Mail keyboard and reading flow (Apple Mail keys, the next message after a delete, earlier messages in one closed stack)

Status: builder's design, **accepted by the owner on 2026-11-16**: every
decision B1–B10 is marked *(owner, accepted 2026-11-16)*, and open questions
1–4 are closed (question 1 against the recommendation: ↓/↑ open the row
even when nothing is open, as in Apple Mail). Part A of 3i is
`2026-11-16-mail-slice-3i-security-privacy-design.md` (security and
privacy); this document adds part B to the same slice. The "Resolutions
after the builder check" at the end override every section above them, and
their "Interactions with part A" bind both parts.
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
    Apple Mail keys are added beside them. *(owner, accepted 2026-11-16).*
    Removing a key the owner already uses would be a regression; the two sets
    do not overlap (Apple's are arrows, Backspace/Delete and Command chords,
    Gmail's are plain letters and symbols).

B2. **Arrows and Backspace/Delete on every platform; Command chords on macOS
    only.** Up/Down, Shift+Up/Down, Backspace, Delete (⌦) work everywhere.
    The Apple Mail Command chords (⌘R, ⌃⌘A, …) are bound only when the page
    runs on macOS. *(owner, accepted 2026-11-16).* On Windows and Linux the
    same chords with Ctrl collide with browser and OS keys (Ctrl+R, Ctrl+N,
    Ctrl+Shift+J, Ctrl+Shift+R …) and Apple's map has no Ctrl version there;
    the letters already cover those platforms.

B3. **Only chords BB does not own.** A chord that BB 0.49.0 binds by default
    (⌘N, ⇧⌘N, ⌘F, ⌘P, ⌘K, ⌘1–9, …) is never bound by Mail, even though the
    page could `preventDefault` some of them. *(owner, accepted 2026-11-16).*
    Taking BB's keys inside one plugin page would make BB behave differently
    on the Mail page; the fallback is the Gmail letter (`c` for New message,
    `/` for search, Shift+P for print). Full list in "Keys that are not
    bound".

B4. **Up/Down by focus zone.** In the list (or anywhere on the page outside
    the conversation) Up/Down are `k`/`j`: move the cursor, and open the row
    when a conversation is already open. On a message header or the
    "earlier messages" stack in the conversation, Up/Down move focus between
    the headers. Anywhere else inside the conversation (the message text,
    a toolbar) Up/Down keep the browser's own scrolling. *(owner, accepted 2026-11-16).* Apple Mail scrolls the message when the message has focus;
    taking the arrows there would make a long message unscrollable by
    keyboard.

B5. **After delete, archive, junk, move or snooze of the open conversation,
    the next one opens** — the row below; at the end of the list, the row
    above; no rows left → the empty state. The same for the reading pane's
    toolbar, the hotkeys, the Apple chords and drag-to-folder (every path
    through `threadsAction`, plus snooze). *(owner, accepted 2026-11-16).*
    This is Apple Mail's behaviour; opening marks the next conversation read,
    as any open does.

B6. **Multi-selection: the cursor moves, nothing opens.** After a removing
    action on a selection, the cursor goes to the first remaining row after
    the last removed one (else before the first); the reading pane shows the
    empty state. *(owner, accepted 2026-11-16).* With a selection no
    conversation is open (its panel hides it, `SelectionPanel`), and opening
    a conversation the owner never chose would mark it read unseen.

B7. **Undo brings the conversation back and reopens it** when the reading
    pane still shows the conversation the action opened (or nothing);
    otherwise the restored row only takes the cursor. *(owner, accepted 2026-11-16).* It undoes the visible effect without overriding a choice the
    owner made after the action.

B8. **Earlier messages collapse into one closed stack.** When a conversation
    opens, the messages before the first "anchor" (the message the owner
    opened, a message that was unread when the conversation opened, or any
    message the owner expanded) collapse into one closed stack — "N earlier
    messages" — when there are two or more of them. A click, Enter or Space
    opens it; `;` (Expand all) opens it with everything; Collapse all closes
    it again. *(owner, accepted 2026-11-16).* The newest (or the target)
    message sits right under the conversation header; nothing is hidden that
    the owner has not read.

B9. **Order stays oldest → newest.** The stack sits above the shown messages,
    in date order, as print, `;` and "Load the whole conversation" already
    assume. *(owner, accepted 2026-11-16).* A "newest at the top" order (an
    Apple Mail setting) would change print, quotes, citations and the agent
    text order; it is listed for another slice.

B10. **Keys typed inside a message body reach the page.** The message frame
    forwards key presses from its document to the page, so hotkeys (and
    Backspace) still work after a click into a message's text. *(owner, accepted
    2026-11-16).* Today a click into the sandboxed frame silently
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
  - Mac chords with a Russian layout: `{ key: "\u043a", code: "KeyR", metaKey }`
    → reply; `{ key: "\u0424", code: "KeyA", metaKey, ctrlKey }` → archive; ⇧⌘J,
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

All four are **closed on 2026-11-16**.

1. **↓/↑ with nothing open:** move the cursor only (proposed), or open the
   row as Apple Mail does (and mark it read)? **Answer (2026-11-16): open
   the row immediately, as Apple Mail does, and mark it read** (not the
   recommendation; resolution 2 gives the details). `j`/`k` stay as they
   are (B1).
2. **After a multi-selection delete:** cursor only (proposed) or open the
   next conversation? **Answer: cursor only; nothing opens** (B6).
3. **⌘R / ⇧⌘R / ⌘Z** bound on the desktop app (proposed, subject to the
   live check), or left out to be safe? **Answer: bind them; any chord the
   live check shows reloading the window or running the host's own undo is
   dropped from the map and the sheet** (resolution 10).
4. **Stack scope:** collapse every earlier read message (proposed), or keep
   the first message of the conversation visible above the stack (Gmail's
   style)? **Answer: collapse all earlier messages; the opened message, the
   newest and every message unread at open are never hidden** (B8).

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

## Resolutions after the builder check

These override every section above. The owner accepted B1–B10 and answered
open questions 1–4 on 2026-11-16 (resolution 1). The builder checked this
part against the tree at commit `168abbb5`: `src/ui/shortcuts.ts`,
`src/ui/mail-page.tsx`, `src/ui/reading-pane.tsx`,
`src/ui/message-frame.tsx`, `src/ui/sanitize.ts`, `src/ui/selection-bar.tsx`,
`src/ui/composer.tsx`, `src/ui/compose-toolbar.tsx`, `src/ui/mail-settings.tsx`,
`app.tsx`, `src/core/threading.ts`, `src/adapters/bb/sqlite-store.ts`,
`server.ts`. Every cited symbol exists as described, within a line or two
of the cited lines. Findings that change the design are below.

1. **The owner's answers (2026-11-16).** (1) ↓/↑ open the row even when
   nothing is open, as Apple Mail does, and opening marks it read
   (resolution 2). (2) After a removing action on a multi-selection the
   cursor moves and nothing opens (B6 unchanged). (3) ⌘R, ⇧⌘R and ⌘Z are
   bound on the desktop app; whichever the live check shows reloading the
   window or running the host's own undo is removed from the map, the sheet
   and README in the same slice (resolution 10). (4) The stack collapses all
   earlier messages; the opened message, the newest and every message that
   was unread at open are never hidden (B8 unchanged).

2. **Arrows open; `j`/`k` do not change (owner answer 1).** Replaces B4's
   "move the cursor, and open the row when a conversation is already open"
   for arrows only.
   - `ShortcutCommand`'s `next`/`previous` gain `arrow?: true`; ↓/↑ in zone
     `"page"` produce them with `arrow: true`. `step(delta, repeat, arrow)`
     (`mail-page.tsx` 710–718) opens the new cursor row when `arrow` is set
     even if nothing is open; `j`/`k` keep today's rule (open only when a
     conversation is open).
   - Still never behind a selection (`selecting`), as today.
   - **Held arrows** move the cursor only (each `repeat` press), as `j`/`k`
     do. The page root gains an `onKeyUp`: releasing an arrow after a run of
     repeats opens the row under the cursor (same conditions). So a held ↓
     ends with the row it stopped on open, without opening and marking read
     every row it passed.
   - **One column** (`wide` false) with nothing open: arrows move the cursor
     only. Opening there would replace the list the owner is moving through
     with the conversation; once a conversation is open, arrows open as in
     two columns. *Builder call, flagged for the owner* (it narrows answer 1
     to the two-column layout the owner uses).
   - In Drafts, an arrow open uses `openRow` (the reading pane), never
     `activateRow`'s "continue in the composer".

3. **Field, dialog and IME safety: verified, with three additions.**
   - Verified: `matchKey` (`shortcuts.ts` 118–) returns null for any
     Ctrl/Alt/Meta or `isComposing` key before the typing check today;
     `isTypingTarget` (68–79) covers `input`, `textarea`, `select`,
     `isContentEditable`, `[contenteditable]`, `[data-mail-composer]` (the
     composer root, `composer.tsx` 794), dialogs and alert dialogs, listbox,
     option, combobox, menus and `[role="textbox"]`. The Move… filter, the
     search field, the composer and every vendored dialog are covered. The
     settings `tablist` (`mail-settings.tsx` 284) renders through
     `props.page`, outside the Mailbox root that carries `onKeyDown`
     (`mail-page.tsx` 401–406, 999–1004), so its arrows never reach Mail's
     handler. The message frame's document has no field: the sanitizer
     forbids `form`, `input`, `button`, `textarea`, `select` (`sanitize.ts`
     44–57).
   - Added: the IME guard also drops `keyCode === 229` (WebKit's
     composition keydown, where `isComposing` can be false), beside
     `isComposing` and `key === "Process"`.
   - Added: arrows (only arrows) return null when the target is inside an
     element that owns arrow keys: `[role="tablist"]`, `[role="radiogroup"]`,
     `[role="slider"]`, `[role="spinbutton"]`, `[role="tree"]`,
     `[role="grid"]`, `[role="toolbar"]`. None is in the page zone today; the
     guard keeps a later widget from losing its arrows.
   - Added: the typing check runs first for every key (as designed), so a
     chord never reaches a field; `HOST_RESERVED` chords still return null
     on a Mac.

4. **Shift+↓/↑ need their own selection rule.** Replaces "extend the
   selection with `toggleChecked(next, true)` from the anchor".
   `toggleSelection` (`selection-bar.tsx` 15–32) sets every row of the range
   to the **clicked row's new state** and `toggleChecked` moves the anchor to
   the clicked row (`mail-page.tsx` 734–737). Used for Shift+arrows it would
   not select the starting row on the first press, and turning back (⇧↓ then
   ⇧↑) would clear both rows instead of one. A pure
   `extendSelection({ order, base, anchor, to })` in `src/ui/successor.ts`
   returns `base ∪ order[anchor..to]`: the anchor is the cursor row when the
   Shift run starts (the selection then is `base`), each press moves `to`,
   and turning back shrinks the range. A run ends on any other key or a
   click. Grouped lists only, never in one column with a conversation open,
   as `x`. Tests: first press selects two rows; back over the anchor; a
   `base` selection made with `x` is kept.

5. **Successor paths, checked one by one.** Added to "`src/ui/mail-page.tsx`"
   and "`app.tsx`".
   - Toolbar, hotkeys, Apple chords and the selection bar all reach
     `threadsAction` (`app.tsx` 1272–1353) through `runAction`
     (`mail-page.tsx` 686–690); its `closeThread()` at 1318 already compares
     the **current** open id, so `then()` runs where `closeThread()` runs
     today, only when the open conversation is still `snapshot.threadId`.
   - **Snooze** reaches `snoozeThreads` (`app.tsx` 2045–2105) from the
     page's snooze menu (`mail-page.tsx` 1334) and the toolbar; `then` is
     passed the same way (closing at 2089 today). The "needs a folder" retry
     (`folderSettled`) runs without `then` and closes as today.
   - **Drag to a folder does not pass through the page.** The drop lands in
     the sidebar and reaches `dropThreads` (`app.tsx` 3433–3456) through the
     rail command `drop` (3503). So the page computes the successor when the
     drag starts (`drag.onStart`, `mail-page.tsx` 1614–1620) and hands it
     up: `onDragAccounts(accountIds, advance)` with `advance: (() => void) |
     null` (null when there is a selection or the open conversation is not
     dragged). `app.tsx` keeps it in a ref, passes it to `threadsAction`
     from `dropThreads`, and clears it on drag end.
   - **Rows**: `rowIds` are thread ids for grouped lists and message ids for
     search hits and non-grouped folders (`mail-page.tsx` 586–587); in the
     latter `isRemoved` matches the row's `threadId`. The successor is
     computed from the rows shown when the action starts (B5 call) and
     opened with `openRow` from that render, which captures the hit.
   - **Not in B5** (close as today): Mark unread (its own "back to the
     list", 1281–1284), Block sender (2163), Archive all from this list, and
     anything that removes the open conversation from outside the page (a
     rule, another device). README lists the B5 actions exactly.
   - A second removing key while the first action runs is dropped
     (`pendingRef`, then the destructive guard), so Backspace held or
     tapped twice never deletes the successor unseen.

6. **Undo keeps the thread id in the usual case; the reopen waits for the
   row.** Replaces B7's "[unverified]" on thread ids.
   - A moved row keeps its id: `takeOver` in the store's move settlement
     ("the moved row keeps its id and takes that copy's uid",
     `sqlite-store.ts` 3871–3893) rehomes the row instead of inserting a new
     one, also when it merges with a synced copy. Thread ids are
     `t_<root row id>` (`threading.ts` 231), so a conversation moved and
     moved back keeps its id. The exception is Gmail's copy back from All
     Mail (`UID COPY`, `server.ts` 1935–1944): the Inbox copy is a new row
     at the next sync and the thread id can change; then nothing reopens
     and the cursor stays (the undo itself is unaffected).
   - `app.tsx` keeps `reopenByUndo: Map<undoId, { threadId, accountId,
     advancedTo }>` (not a field of `lastUndo`), so both `z` and an older
     toast's own **Undo** find their entry. After a `done` undo with
     `restored > 0`, the page reopens `threadId` once the row is back in the
     list, waiting at most `MOVING_BACK_MAX_MS`; any owner open or close in
     between cancels it.

7. **The stack's open state lives in the page, beside `quotesAll`.**
   Replaces "Opening state `open` is per conversation in the pane".
   - `;`, Expand all and Collapse all are the page's `expandAll`
     (`mail-page.tsx` 800–811), which toggles messages through
     `onToggleMessage` and sets `quotesAll` (527, 809, 828). The stack's
     `open` is therefore page state `{ threadId, open }` passed to the pane
     in `ReadingSlice3h` (`stackOpen`, `onStackOpen`), like `quotesAll`.
     Expand all sets it open (every message expanded also moves the
     boundary to the first message); Collapse all sets it closed (the
     newest stays expanded, so the stack forms again before the anchors).
   - Anchors at first render, verified: `loadThread` sets `detail` and
     expands the focus in the same tick, then calls `markOpened`, which
     only sends `message_open` and does not flip `isRead` locally (`app.tsx`
     879–897, 925–945); the first render carries the server's `isRead`. The
     pane records the anchors in state keyed by thread id on the first
     render that has `detail` (as `Switches`).
   - Citation chips: `cite` (`mail-page.tsx` 779–787) expands the message
     before setting the highlight, so the boundary moves first and the
     highlight effect finds the `[data-message-id]` card after the render.
   - Print (`r3.onPrint(messages)`, reading-pane header; the `print` hotkey
     case) and `messageToHand` read the full `messages` list; plain text,
     original colors and quote switches are keyed by message id (`Switches`)
     and survive the stack; the single-message view (`single`) has no stack;
     Related mail uses the newest message. All unaffected, as designed.
   - "Load the whole conversation": the page remembers the message count
     when the job starts (`r3.conversation.state === "running"`); when it
     ends with more messages, the page sets the stack open.
   - Message headers get `data-mail-message-toggle` on the existing
     `<button aria-expanded>` (`reading-pane.tsx` 474–477).
   - The `Conversation` section that gets `data-mail-reading` and
     `tabIndex={-1}` is `mail-page.tsx` 1156–1161; it is the reading pane's
     scroll container (`overflow-y-auto`), so focusing it makes arrows
     scroll it natively.

8. **Frame key forwarding is feasible, with two corrections.** Added to
   "Message frame key forwarding".
   - Verified: the parent already attaches `click`/`auxclick` to the frame's
     `contentDocument` in `handleLoad` and removes them in `detachRef`
     (`message-frame.tsx` 266–301); `sandbox="allow-same-origin"` (312)
     permits it; each new `srcDoc` re-runs `handleLoad`. A `keydown`
     listener is added and removed the same way. The copy is built with the
     **parent** realm's `KeyboardEvent` (`frame.ownerDocument.defaultView`)
     and dispatched on the `<iframe>` element, so it bubbles through React's
     root listener and then to BB's `window` listener like a page key.
   - **Enter, Space and Tab are not forwarded.** In the frame they activate
     a focused link or `<summary>` or move focus. Forwarded, Enter would also
     run `open` (the copy's target is the `<iframe>`, which `isActivatable`
     does not treat as a link) and open the cursor row on top of the link.
   - **Arrows, Page Up/Down, Home and End are not forwarded** either: in the
     reading zone they map to no command, and a synthetic event has no
     default action. Their native default runs in the frame; the frame has
     no scroll of its own (its height is its content), so whether Chromium
     chains that scroll to the pane is a live check (step 6). If it does
     not, the frame listener scrolls the `[data-mail-reading]` container by
     a line or a page itself.
   - The forwarder drops `isComposing`, `key === "Process"` and `keyCode ===
     229` events itself (the copy's `keyCode` is 0), and keys whose target is
     a typing target.
   - BB's dispatcher may ignore synthetic (`isTrusted: false`) events
     **[unverified]**; either way nothing of BB's breaks, since BB never saw
     frame keys before.

9. **Composer ⇧⌘D.** `composer.tsx` `onKeyDown` (760–781) gains a Mac-only
   branch beside ⌘/Ctrl+Enter that calls the same `send()` (pre-send
   included) and stops propagation as the Enter branch does. The platform
   test is one exported `isMacPlatform()` in `shortcuts.ts` (the
   `navigator.userAgentData?.platform` else `navigator.platform` rule), and
   `compose-toolbar.tsx`'s `modKeyLabel` (12) uses it too, so there is one
   definition.

10. **⌘R, ⇧⌘R, ⌘Z: bound, then decided by the live check (owner answer
    3).** Live step 1 is owner-run after the build. A chord it shows
    reloading the window or running the host's undo is removed from `matchKey`, `SHORTCUT_SHEET`'s
    `mac` keys, README and CHANGELOG in a follow-up commit, and recorded
    here. Until then they are bound.

11. **Not verified, updated.** Still open: Apple Mail's own chords for
    delete, flag and mailbox search (not on Apple's page); Electron menu
    accelerators for ⌘R / ⇧⌘R / ⌘Z (live step 1); whether a browser tab lets
    the page prevent ⌘R; whether BB's dispatcher honours synthetic events;
    whether keyboard scrolling chains from the frame to the pane (live step
    6). Now verified: thread ids survive move and move back except Gmail's
    copy back (resolution 6); "unread at open" is captured on the first
    render (resolution 7); the frame forwarding path (resolution 8, jsdom;
    BB desktop in live step 6).

### Interactions with part A

These bind both parts (part A's status line points here).

- **I1. One frame load handler.** `message-frame.tsx` `handleLoad` gains
  part A's link listeners (`click`/`auxclick` reporting `{ href, text }`,
  `mouseover`/`focusin`/`mouseout`/`focusout` for the status line) and part
  B's `keydown` forwarder. All are attached in that one handler and removed
  by the one `detachRef`; tests assert that a new `srcDoc` leaves exactly
  one listener of each kind. The two parts' frame work is done by one agent
  in sequence (plan batches E then F).
- **I2. Keyboard link opening.** A link focused with Tab inside the frame and
  activated with Enter goes through the frame's own click → `onOpenLink({
  href, text })` → `cleanLink` and the deceptive-link dialog; Enter is not
  forwarded (resolution 8), so it cannot also open the cursor row. The
  dialog is a `[role="dialog"]`, so Backspace, arrows and chords inside it
  never act on mail.
- **I3. Arrow opens vs. the open-time sender check.** Every arrow open is a
  real open: `loadThread` marks the conversation read (`message_open`,
  accepted). The part A refresh (`sender_check_refresh`) is not sent per
  arrow press: the page sends it once the conversation has stayed open for
  600 ms (the timer is cleared when another conversation opens), only for
  expanded messages whose state is `unknown`, and the server drops a
  refresh for a message that already has one in flight. A held arrow opens
  nothing until release (resolution 2), so a run of presses queues at most
  one refresh. A result that lands after the owner moved on is stored and
  shown next time.
- **I4. Automatic images wait for the check.** An auto-opened successor or
  arrow-opened old message from an always-show sender loads images only
  after its state is known (part A resolution 5); the bar says so.
- **I5. The successor may be a warned message.** It opens with its warning
  strip and without automatic images, as any open does; nothing about the
  successor rule changes.
- **I6. The stack and warnings.** Earlier messages in the stack are read
  ones; their warning lines are hidden with them. The stack's summary line
  names senders with the same `addressLabel` as the headers, shows the
  address instead of the name for a message with a `name_shows_address`
  warning, and adds "· sender warning" when any stacked message has a failed
  check or a warning. A message unread at open (a fresh spoof included) is
  an anchor and never stacked.
- **I7. Stacked messages are not refreshed.** The part A refresh runs for
  expanded messages only, so opening a long old conversation fetches
  headers for the newest (and any anchors) only; opening the stack expands
  nothing by itself, and a message expanded from it is refreshed then.
- **I8. Encrypted and signed mail.** The crypto chip and the encrypted
  placeholder live in `MessageItem` and behave the same inside or outside
  the stack; Print prints the placeholder for an encrypted message (its body
  is null, part A resolution 6).
- **I9. ⇧⌘D** sends through the composer's pre-send path, so part A's
  `reply_to_elsewhere` item shows for it as for ⌘Enter.
- **I10. Attributes.** Part B's `data-mail-reading`, `data-mail-stack` and
  `data-mail-message-toggle` live in Mail's own DOM, never inside the frame;
  part A's `data-mk-*` marks live only inside the frame and are stripped
  from mail input (`sanitize.ts` 418). Neither selector matches the other.
- **I11. Shared files, one order.** Part A's UI and part B's app, frame and
  stack work both edit `app.tsx`, `reading-pane.tsx` and
  `message-frame.tsx`; the plan runs them in strictly sequential batches
  (A's UI first, since B's stack summary reads A's header fields).
