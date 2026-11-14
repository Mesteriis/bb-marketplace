# Makosh Mail — slice 2: folders, images, message actions

Status: decisions made by the owner (2026-11-15) after the live check of
slice 1. Builds on `2026-11-14-mail-imap-first-slice-design.md`; everything
there still holds unless this document changes it.

## Intent

The owner connected iCloud and Gmail and asked for two things missing from
real use: pictures in mail, and the folders a mail client has (Spam and the
rest), with "spam / not spam" handling.

## Owner's decisions

1. **Images:** remote images stay blocked by default. A message with blocked
   images shows **Show images** (this message, this time) and **Always show
   from <sender>** (a per-sender allowlist). Inline images embedded in the
   message (`cid:`) always show — they are part of the mail, not a remote load.
2. **Folders:** system folders (Inbox, Sent, Drafts, Spam, Trash,
   Archive / All Mail) **and** the owner's own folders (Gmail labels appear as
   folders). All of them sync with the same 30-day window rules.
3. **Actions:** **Spam**, **Not spam**, **Archive**, **Delete** on a message
   or thread, by the owner's click only. Agents get none of these.

## Goals

1. Folder list per account on the Mail page (system folders first in a fixed
   order, then the owner's folders alphabetically), with unread counts. The
   thread list shows the selected folder; Inbox is the default.
2. Sync every selectable folder of every account, each with its own
   UIDVALIDITY/state, reconciliation and pending reads (slice 1 rules,
   generalized from INBOX to any folder).
3. Remote images per decision 1; inline `cid:` images render from stored
   bytes.
4. Spam / Not spam / Archive / Delete as server moves, applied locally at
   once and pushed by the sync loop, surviving restarts and failures.
5. Search, mentions, agent tools and CLI cover all folders and say which
   folder a message is in.

## Non-goals

Sending/replying; creating, renaming or deleting folders; drag-and-drop;
labels as multi-tags (a Gmail message shown under several labels appears in
each folder, read-only); emptying Trash or permanent deletion; attachment
download (inline images only); IMAP IDLE; proxying images through the server.

## Anti-goals

- A move the owner did not click. Agents, mentions, CLI and sync never move,
  delete or flag mail (except the existing `\Seen` on open).
- Losing mail: a move is never a local delete before the server confirms;
  Delete moves to Trash, it never expunges.
- Remote loads without the owner's per-message or per-sender consent.
- Duplicate messages in a thread view or search results because Gmail shows
  one message in several folders.

## Design

### Folders (core + gateway + store)

- Gateway: `listFolders(config): Promise<RemoteFolder[]>` —
  `{ path, name, delimiter, specialUse: "inbox"|"sent"|"drafts"|"junk"|"trash"|"archive"|"all"|null, selectable }`
  from imapflow `list()` (special-use flags, `\Noselect` → not selectable).
  `openInbox(config, …)` becomes `openFolder(config, path, { readOnly })`;
  the session is folder-agnostic otherwise. `moveMessages(uids, destination)`
  on a writable session (imapflow `messageMove`, which falls back to
  COPY+EXPUNGE when MOVE is missing); a refused move throws.
- Core: `syncAccount` runs `syncFolder` for each selectable folder (Inbox
  first, then by special use, then the rest), one session per folder,
  sequentially. All slice-1 behaviors move to `syncFolder` unchanged,
  parameterized by folder path. Folder list refreshed each round; folders
  that disappeared on the server are dropped locally with their rows.
- Gmail: `[Gmail]/All Mail` and `[Gmail]/Important`/`Starred` duplicate other
  folders. Sync **All Mail** (it is the archive) but skip `\Flagged` and
  `\Important` virtual folders. Dedup at read time: a message is identified
  across folders by `gm_msgid` (X-GM-MSGID) when present, else by
  `(account, message_id)` when non-null.
- Store (append-only migration): `folders(account_id, path, name, delimiter,
  special_use, selectable, sort_key, unread_count, total_count)`;
  `messages.gm_msgid` column; `sync_state` already keyed by folder.
  `listThreads(accountId, folder, cursor, limit)` lists threads that have at
  least one message in that folder; thread/search/mention results dedupe by
  the cross-folder identity, preferring the copy in the folder being viewed,
  else Inbox, else any.
- Threads stay account-wide (a thread spans Inbox and Sent, as in Gmail).
  The thread list row's unread state/count is computed for the selected
  folder.

### Message actions

- RPC `message_action({ messageIds: string[], action: "spam"|"not_spam"|"archive"|"delete" })`
  (owner UI only; not exposed as a tool, CLI command or mention).
- Destination per account, from special-use: spam → `junk`; not_spam →
  `inbox`; archive → Gmail: remove from Inbox = move from INBOX to `all`
  (All Mail); others: `archive` folder; delete → `trash`. If the account has
  no folder with that special use, the action is refused with a clear
  message and nothing changes. Not spam on a message not in Spam is refused.
- Local effect at once: the message rows in the source folder get
  `move_pending = <destination path>` and are hidden from the source folder's
  list; the thread list and counts update; realtime notifies. They are not
  deleted locally.
- Push: each sync round first pushes pending moves per source folder on a
  writable session, after confirming UIDVALIDITY (slice-1 rule for `\Seen`):
  `moveMessages(uids, destination)`, then the source rows are deleted
  locally and the destination folder syncs normally (the moved messages
  arrive there with their new UIDs). A refused or failed move keeps
  `move_pending` and retries next round; after 3 failed rounds the move is
  cancelled, the message reappears in the source folder, and the account's
  `last_error` explains it.
- Undo: not in this slice (the owner can move back with the opposite
  action from the destination folder).

### Images

- Sanitizer gains a mode `{ remoteImages: boolean }`. Off (default): today's
  behavior. On: `<img src>` with `https:` is kept (still no `srcset`,
  `<picture>`, CSS `url()`, `http:`), and the frame CSP becomes
  `img-src data: https:`. The sanitizer reports whether it blocked any remote
  image so the UI shows the **Show images** bar only when useful.
- Allowlist: store table `image_senders(account_id, address, created_at)`;
  RPC `images_allow_sender({ messageId })` (adds the message's sender) and
  `images_disallow_sender({ address, accountId })`; `message_body` returns
  `remoteImagesAllowed: boolean` for the sender. "Show images" for one
  message is UI state only.
- Inline images: the gateway keeps the bytes of inline image parts
  (`content-disposition: inline` or referenced `cid:` with an image MIME
  type), up to 1 MB each and 5 MB per message; the store keeps them in
  `inline_parts(message_id, content_id, mime_type, data BLOB)`.
  `message_body` returns HTML with `cid:` references replaced by `data:`
  URLs (server-side, so the client never fetches anything). Oversized parts
  are dropped (the image shows as broken). Mail already synced gets inline
  images only when it is re-fetched — acceptable; a later "repair" can
  re-fetch.

### UI (BB-native, same rules as slice 1)

- Left column of the Mail page: account select, then folder list with
  icons (Inbox, Sent, Drafts, Spam, Trash, Archive, then folders), unread
  counts, selected highlight. Narrow widths: folder select in the header.
- Reading pane toolbar: Spam / Not spam (only in Spam), Archive, Delete,
  Hand to agent. A pending move shows the message as "Moving to Spam…" in
  no list (it is hidden) and a toast with the result of the push when it
  completes or fails.
- Images bar above a message with blocked remote images: "Images are
  hidden to protect your privacy." [Show images] [Always show from
  sender@…].

### Agent surfaces

`mail_search` / `mail_read` / mention / CLI read include the folder name in
their output and search all folders (deduped). No new agent abilities.

## Testing

As slice 1: core with fakes (folder iteration, per-folder state, move push
with UIDVALIDITY guard, retry and cancel after 3 failures, dedup), store on
real SQLite (folders, listThreads by folder, dedupe, inline parts,
image_senders, migrations appended), gateway mapper tests (special-use
mapping, Gmail virtual folders skipped, inline part extraction and caps),
sanitizer (remote mode keeps only https img src; CSP switch; blocked-image
detection), server (RPC refusals, no tool/CLI exposure of actions), UI
(folder switching, actions, images bar). Live check on the owner's accounts.

## Resolutions after the builder check (binding; override the sections above)

1. **Host CSP:** checked live — BB serves `/plugins/makosh-mail/mail` with no
   CSP header or meta, so the frame's own meta decides; `img-src data: https:`
   works when images are allowed.
2. **Inline images size:** caps lowered to 512 KB per part and 2 MB per
   message (base64 adds a third). Larger parts are dropped.
3. **Thread actions** act on the thread's messages that are in the folder
   being viewed (as Gmail does). Copies in other folders (Sent, All Mail) are
   untouched. Gmail Archive = move the thread's INBOX copies to All Mail; with
   no INBOX copy it is refused ("Already archived").
4. **Re-home, don't re-fetch:** after a successful move the gateway returns
   the COPYUID map (imapflow `messageMove` result); the store moves each row
   to the destination folder with its new uid, keeping its id, flags,
   `seen_pending` and bodies. Without a uid map (server lacks UIDPLUS) the row
   gets `uid = NULL` in the destination (detached) and is reattached by the
   normal reconcile/backfill via `(account, message_id)` / `gm_msgid`;
   rows still detached at the end of that folder's next successful round are
   deleted.
5. **Push order per folder:** pending `\Seen` first, then pending moves, both
   after the UIDVALIDITY check. Re-homing carries any pending read to the
   destination, so no read is lost.
6. **Failures:** only server refusals (the gateway throws on imapflow's
   `false`/`undefined`) count toward the 3-failure cancel. Connection errors,
   skipped rounds and sleep do not. A move whose uids no longer exist in the
   source (map without uids) counts as done; reconcile handles the rest.
7. **Dedup at derivation:** a cross-folder identity column `dedup_key`
   (`gm:<X-GM-MSGID>` when present, else `mid:<message_id>`, else the row id)
   is stored on each row. Thread rows, counts, unread counts, the badge, search
   and mention results count distinct `dedup_key`s. Opening a message marks
   every row with the same `dedup_key` read locally (pending only on the row
   in the viewed folder; the server propagates the rest on the next round).
8. **Gmail ids:** map imapflow `emailId` (X-GM-MSGID) to `gm_msgid`;
   the per-round flags fetch also returns it so existing rows backfill.
9. **Virtual folders:** skip Gmail folders whose flags include `\Flagged` or
   `\Important` (imapflow does not treat `\Important` as special-use; test the
   flag). iCloud special-use resolves by flags or imapflow's name fallback.
10. **Badge:** unread distinct messages in Inbox folders of all accounts.
    Folder counts are local (synced window), not server STATUS.
11. **Exposure:** `message_action` and the image RPCs are registered
    non-discoverable; like `accounts_remove` they are reachable by anything
    that can call local plugin RPC, which the docs already state for agents
    with shell access. No tool, CLI command or mention exposes them.
12. **Schema additions** (appended migrations only): `folders` table;
    `messages.gm_msgid`, `messages.dedup_key`, `messages.move_pending`,
    `messages.move_failures`; `image_senders`; `inline_parts`; indexes on
    `(account_id, folder)`, `dedup_key`.

## Calls made by me (not the owner)

- Sync All Mail for Gmail; skip `\Flagged`/`\Important` virtual folders.
- Threads stay account-wide; lists filter by folder.
- Delete = move to Trash only; no expunge, no undo.
- Inline images embedded as `data:` by the server, caps 1 MB / 5 MB.
- Moves retried 3 rounds, then cancelled with an error.
- `http:` remote images stay blocked even when images are allowed.
