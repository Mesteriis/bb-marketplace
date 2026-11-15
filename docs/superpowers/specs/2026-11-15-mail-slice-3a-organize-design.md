# Makosh Mail — slice 3a: all accounts, flags, bulk actions, attachments, source, hotkeys

Status: decisions made by the owner (2026-11-15). First of three slices toward
a full mail client in BB: 3a (this: organize and read), 3b (compose, reply,
forward, drafts, SMTP), 3c (agent sends with confirmation, translation via a
hidden BB thread). Builds on the slice-1 and slice-2 specs; everything there
holds unless this document changes it. Backlog: `docs/mail-feature-backlog.md`.

## Owner's decisions

1. An **All accounts** view: one list across iCloud and Gmail.
2. **Unread / read and flag (star)** toggles, synced to the server.
3. **Multi-select** threads and apply an action to all of them; **move to any
   folder** of the same account.
4. **Download attachments.**
5. **Show message metadata** (headers) and **download the message as .eml**
   with all its metadata.
6. **Hotkeys** in the Gmail style.

## Goals

1. Account selector gains **All accounts** (default when more than one account
   exists). Its rail shows unified roles — Inbox, Sent, Drafts, Spam, Archive,
   Trash (each merging the folders of that special use across accounts; Gmail
   Archive = All Mail) — then each account's own folders under the account's
   address. Thread rows show which account they belong to (short address or
   colored dot). Unread counts per role are sums.
2. Read/unread and flag on a message or thread, from the reading pane, the
   thread row and hotkeys; applied locally at once and pushed to the server by
   the sync loop like `\Seen` today (`\Seen` add/remove, `\Flagged`
   add/remove), surviving restarts; the server wins otherwise (reconcile).
3. Thread list checkboxes (and shift-click range, `x` hotkey, "select all on
   page"); a selection bar with Mark read/unread, Flag/Unflag, Archive, Spam /
   Not spam, Delete, Move to…; works in All accounts too (the server splits a
   batch per account and source folder). Move to… lists the selectable folders
   of the message's account (destination must be the same account).
4. Attachments listed with name, type, size and a download button. Download
   fetches the part from the server on demand and saves it through the browser
   as a file (no auto-open). Inline (`cid:`) parts are downloadable too.
5. A "Details" panel (per message) shows all headers as plain text (From, To,
   Cc, Bcc if present, Reply-To, Date, Message-ID, In-Reply-To, References,
   Received chain, Authentication-Results / DKIM / SPF / DMARC lines, List-*,
   X-* headers, MIME structure summary, size, UID, folder, account). "Download
   .eml" saves the exact raw RFC 822 source from the server (byte-for-byte,
   `BODY.PEEK[]`), named `<date> <subject>.eml` (sanitized filename).
6. Hotkeys active only while the Mail page has focus and no text field is
   focused: `j`/`k` next/previous thread, `o`/`Enter` open, `u` back to list,
   `x` select, `e` archive, `#` delete, `!` spam, `s` flag toggle, `Shift+U`
   mark unread, `Shift+I` mark read, `v` move to…, `/` focus search, `g i` /
   `g s` / `g d` / `g t` / `g a` go to Inbox/Sent/Drafts/Trash/All accounts,
   `?` shows the shortcut sheet. `c`, `r`, `a`, `f` (compose, reply, reply all,
   forward) are reserved for 3b and show "coming soon" in the sheet.

## Non-goals (later slices)

Compose/send/drafts (3b), agent sending and translation (3c), snooze, rules,
IDLE, signatures, contacts, attachment preview in BB's file viewer, folder
management (create/rename/delete), drag-and-drop, per-message "load images"
memory beyond the slice-2 sender allowlist.

## Anti-goals

- Any server change the owner didn't click (or press a hotkey for). Flags,
  read state and moves stay owner-only; agents, mentions and CLI get none.
- Attachment or .eml bytes passing through logs, agent text, realtime
  payloads, or being written to disk by the plugin (the browser saves them).
- Opening a downloaded file automatically.
- Hotkeys firing while the owner types in BB's composer, search or any input,
  or while another BB page is active.
- Losing a flag/read change because the server state arrived first: pending
  local intent wins until pushed (slice-1 `seen_pending` rule, generalized).

## Design

### Pending flag intents (store, sync, gateway)

- Generalize slice-1 `seen_pending` into two desired-state columns:
  `seen_desired INTEGER NULL` and `flag_desired INTEGER NULL` (NULL = no
  pending change; 0/1 = desired value). Appended migration only: add both
  columns, backfill `seen_desired = 1 WHERE seen_pending = 1`, keep
  `seen_pending` working (it becomes a derived flag kept in sync, or every
  reader switches to `seen_desired` — builder's call, but slice-1/2 semantics
  must hold: `markOpened` sets read on every attached copy).
- `applyFlags` (reconcile) never overwrites a field whose desired value is
  pending.
- Sync push per folder (after the UIDVALIDITY check, before moves): group
  pending intents into four sets (seen+, seen−, flag+, flag−) and push each
  with one STORE (`messageFlagsAdd` / `messageFlagsRemove`) on the writable
  session; clear the intents on success; a refused STORE leaves them pending
  and adds a problem line (like moves, no strike count needed — retry is
  harmless).
- Gateway: `FolderSession.setFlags(uids, { seen?: boolean; flagged?: boolean })`
  or four explicit methods; throws on refusal (SafeImapError "StoreFailed").
- Cross-folder copies: marking read/unread or flag/unflag applies to every
  attached copy with the same dedup key (Gmail labels share flags server-side
  anyway; iCloud copies are separate messages and should match).

### All accounts

- Contract: `threads_list` input becomes
  `{ scope: { kind: "account"; accountId; folder } | { kind: "all"; role: SpecialUse }, cursor, limit }`
  (keep the old shape working for one release or update the UI in the same
  slice — builder's call; no external callers exist).
  `folders_list` with `accountId: null` returns the unified roles with summed
  counts plus per-account own folders.
- Store: `listThreadsAll(role, cursor, limit)` merges threads from every
  account that have a member in a folder with that special use (dedup inside
  an account as today; threads are per account, so no cross-account merge).
  Keyset paging across accounts by `(last_date, id)`.
- Thread rows carry `accountId`; the UI shows the account marker only in All
  accounts.
- Actions from All accounts: `message_action` gains an optional `scope`
  (role) instead of `folder`, or the UI sends one call per account/folder group
  — builder's call; each underlying move still targets one account and one
  source folder (slice-2 rule).

### Bulk actions and Move to…

- `message_action` actions extend to `mark_read`, `mark_unread`, `flag`,
  `unflag`, `move` (with `destination: string` path, same account, selectable,
  not the source). Batch limit stays 200 ids per call; the UI chunks larger
  selections.
- Thread-level selection acts on the thread's messages in the viewed folder
  (or role) — slice-2 resolution 3 holds.

### Attachments and raw source

- Gateway: `fetchRaw(uid): Promise<Uint8Array>` (`BODY.PEEK[]`) on a read-only
  session, size cap 50 MB (refuse larger with a clear message).
- Attachment download re-parses the raw message with postal-mime and returns
  the part at the stored `partId` (postal-mime index, as recorded since
  slice 1), verifying filename and MIME type match the stored metadata; on
  mismatch, refuse ("The message changed on the server; sync and try again").
- Transport to the browser: a plugin HTTP route
  `GET /api/v1/plugins/makosh-mail/http/download?kind=attachment|eml&messageId=…&part=…`
  with `auth: "local"` (BB app origin only), responding with the bytes,
  `Content-Type` (attachment: the stored MIME type, but `application/octet-stream`
  for anything HTML/SVG/JS-like), `Content-Disposition: attachment;
  filename*=UTF-8''…`, `X-Content-Type-Options: nosniff`,
  `Cache-Control: no-store`, `Content-Security-Policy: default-src 'none'`. The
  UI triggers it with a hidden `<a download>` or `experimental_saveFile` if
  the SDK route fits better — builder verifies which works in BB's app.
- Headers panel: RPC `message_source({ messageId }) → { headers: [name,
  value][], structure: string[], size, uid, folder }` built from the raw
  message; header values are plain text (never rendered as HTML), long values
  wrapped, total response capped (e.g. 256 KB of headers).
- Opening the Details panel or downloading counts as reading, not as opening:
  it never sets `\Seen` (owner can still open the message normally).

### Hotkeys

- Implemented in the Mail page with a single keydown listener scoped to the
  page's root element (or BB's command API if it supports page-scoped
  shortcuts — builder checks `app.commands.register` scoping); ignores events
  from inputs, textareas, contenteditable, and when modifier keys other than
  Shift are held; two-key `g` sequences time out after 1 s.
- A `?` sheet lists every shortcut, including the 3b ones marked "soon".

### UI (BB-native, as before)

- Selection bar replaces the list header while something is selected.
- Row affordances: checkbox on hover/selection, flag star, unread dot; account
  marker in All accounts.
- Reading pane toolbar adds Mark unread, Flag, Move to…, Details, Download
  .eml; attachment chips become download buttons.

## Testing

Store (desired-state intents, reconcile never overwrites pending, all-accounts
paging, cross-copy flags), gateway (setFlags, fetchRaw cap, refusal codes),
sync (push order: seen/flag intents, then moves; refused STORE keeps intents),
server (new actions and refusals, download route headers/escaping, filename
sanitizing, mismatch refusal, .eml byte-for-byte, no `\Seen`, no bytes in
logs), UI (unified rail, selection bar, Move to… dialog, Details panel renders
headers as text, hotkeys ignore inputs, `g` sequences). Live check on the
owner's accounts: flag on iCloud shows on the phone; mark unread round-trip;
move an ad to "Реклама"; download an attachment and an .eml and open them
manually.

## Calls made by me (not the owner)

- All accounts is the default when several accounts exist; roles merge by
  special use; own folders stay per account.
- Desired-state columns instead of more `*_pending` booleans.
- Downloads go through a local-auth HTTP route; files are never written by the
  plugin.
- 50 MB cap for raw fetches.
- Details/.eml never mark a message read.
- Hotkeys follow Gmail where possible; 3b keys reserved.

## Resolutions after the builder check (binding; override the sections above)

1. **Hotkeys on any layout.** Letters match the physical key (`event.code`:
   `KeyJ`, `KeyK`, `KeyO`, `KeyU`, `KeyX`, `KeyE`, `KeyS`, `KeyV`, `KeyG`,
   `KeyI`, `KeyD`, `KeyT`, `KeyA`), so they work on the Russian layout.
   Symbols match the character or, as a fallback, the code: `#` = `Shift+Digit3`,
   `!` = `Shift+Digit1`, `/` = `Slash`, `?` = `Shift+Slash`. `Escape` only
   closes the plugin's own dialogs (check live that BB's `app.back` doesn't
   also fire; stop propagation when a plugin dialog is open).
2. **Unified Archive excludes Gmail All Mail.** The All accounts "Archive"
   role merges `archive` folders only; Gmail's All Mail stays under the Gmail
   account's own section. The unified Inbox/Sent/Drafts/Spam/Trash roles merge
   by special use as designed.
3. **Downloads use one-time tickets.** RPC `download_ticket({ kind:
   "attachment" | "eml", messageId, partId? }) → { url, fileName }` (refuses
   plugin callers like other write RPCs) mints a random 32-byte ticket bound to
   the request, valid for 60 s and one use, kept in memory. The HTTP route
   accepts only `?t=<ticket>`; message ids in the URL are not accepted. The UI
   saves with `experimental_saveFile({ fileName, url })` (fallback `<a
   download>` on web only). This narrows but cannot close access by anything
   that can call local plugin RPC as a client — same documented limit as for
   moves.
4. **Thread star.** A thread row is starred when any message of the thread in
   the viewed folder/role is flagged. `s` (and the row star) on a thread:
   if any such message is flagged, unflag all of them; otherwise flag the
   newest one (Gmail behavior). In the reading pane, the per-message star
   toggles that message only.
5. **Stale-uid guard for raw fetches.** `.eml`, Details and attachment
   downloads refuse rows that are detached (`uid IS NULL`) or pending a move,
   check the folder's stored UIDVALIDITY against the session's, and after the
   fetch compare the stored size (and Message-ID when present) with the
   fetched message; on any mismatch refuse "The message changed on the server;
   sync and try again". Attachment downloads additionally compare filename,
   MIME type and size of the part.
6. **Desired-state migration covers every reader.** Element 3 (appended):
   `ALTER TABLE messages ADD COLUMN seen_desired INTEGER`, same for
   `flag_desired`, backfill `seen_desired = 1 WHERE seen_pending = 1`, index
   `(last_date, id)` on `threads`. After it, `seen_pending` is no longer read
   or written by code (left in place, frozen). Every reader/writer changes
   together in store, fake, ports and sync: `updateMessage`/`upsertMessages`
   and `applyFlags` never overwrite a field whose desired value is not NULL;
   move re-home carries both desired values (non-NULL wins); clearing after a
   push is compare-and-clear (clear only if the desired value still equals
   what was pushed); push queries select attached rows only; `markOpened`
   sets `seen_desired = 1` on attached unread copies and `is_read = 1` on all
   copies (slice-2 semantics).
7. **postal-mime determinism.** Export the gateway's parse function and reuse
   it (same options) for downloads; pin `postal-mime` to an exact version in
   package.json; part match by index plus filename + MIME + size.
8. **Raw fetch.** Gateway `fetchRaw(uid, maxBytes)` refuses before fetching
   when the stored size exceeds 50 MB and enforces the cap while reading;
   verify imapflow 2.11's `download`/`fetchOne(source)` API in
   node_modules (types may be missing — read dist). Add `messageFlagsRemove`
   to `SessionClient` after verifying its name/signature in dist.
9. **All-accounts actions.** The server accepts a batch spanning accounts and
   folders for `message_action` (new loop: group ids by account and source
   folder, apply each group with the slice-2 rules, return per-group results);
   moves and `move` still target one account per group. The UI may send one
   call.
