# Mail slice 3p: a local archive (import of mbox and .eml)

Backlog item 95: an old archive is opened and searched in BB without being
uploaded to a mail server. The owner approved this design on 2026-11-17:
a separate Archive page, text in the database with attachments read from
the source file, import by a terminal command, read-only, nothing for agents.

## The problem

Everything in Mail's store today is a copy of a message on an IMAP server:
a row has an account, a folder and a UID, and sync, moves, flags, sending
and the reply rule all assume that. An imported message has none of these.

## Decisions proposed

1. **A separate place, not the mailboxes.** Imported mail lives in its own
   tables (`archives`, `archive_messages`, its own full-text index) and is
   shown on its own page, "Archive", in the left rail next to Files. It
   never appears in the Inbox, in a folder, in All accounts, in the
   unread count or in a conversation with live mail. Sync, filters, block
   rules, snooze, reminders and sending never see it. This is what keeps
   the feature from being able to break live mail.
2. **Import copies what reading and search need; attachments stay in the
   file.** For each message the database keeps the headers (from, to, cc,
   date, subject, Message-ID), the text, the HTML (up to the cap live mail
   has, 1 MB) and the names and sizes of attachments. It also keeps where
   the message sits in the source file (path, offset, length). An
   attachment is read from that file when the owner opens it; if the file
   has been moved or changed since, Mail says so and the text stays
   readable. The source file is never written to.
3. **Import is a command in the owner's terminal**, like export:
   `bb makosh-mail archive add /full/path/old.mbox [--name "Old work mail"]`,
   and the same for one `.eml` file or a directory of `.eml` files.
   `archive list` and `archive remove <id>` beside it. They refuse inside
   an agent thread. No upload through the page: an archive can be
   gigabytes, and the page's upload path is built for attachments.
4. **Reading.** The Archive page lists the archives, then one archive's
   messages newest first, with search over subject, sender and text. A
   message opens in the same reading frame as live mail, with the same
   sanitizer: remote images off (with "Show images" for one message),
   links through the same check, no scripts. No sender check and no
   warnings are shown, because there is no provider result to base them on;
   the page says that an archive's senders are not verified.
5. **Read-only.** No reply, forward, move, delete of one message, flag or
   unread state. "Remove archive" deletes the whole archive from Mail (not
   the source file). Reply and forward can come later; they need a choice
   of the account to send from.
6. **Agents get nothing.** No tool, mention, CLI read or search reaches
   archive mail, and AI access has no setting for it. An old archive is
   the least reviewed mail the owner has; it can be opened to agents later
   as its own decision.
7. **Bounds.** One archive: at most 200,000 messages and 20 GB of source;
   one message: 50 MB (larger ones are counted and skipped); at most 20
   archives. The import reads the file as a stream, in one pass, and
   commits in batches, so a stopped import leaves a usable partial archive
   that `archive add` of the same file continues (messages are keyed by
   their place in the file). mbox is read as mboxrd and mboxo (a `>From `
   line loses one `>`); Thunderbird and Apple Mail exports are this form.
8. **Search.** Only inside the Archive page (one archive or all of them).
   The main search box does not search archives in this slice; it can
   offer "also in archives" later.

## What is deliberately not in it

- Uploading archive mail to a server, or moving it into a mailbox.
- Conversations: an archive is a flat list (sorting by subject thread can
  come later).
- Maildir, PST, OLM and other formats.
- Text search inside attachments.
- Encrypted or signed mail in an archive is shown as it is (no OpenPGP
  actions there).

## Shape of the work

- Core: `mbox.ts` gains a streaming-friendly reader (`splitMbox` state
  machine over chunks, unquoting); `archive.ts` (the view types, bounds,
  the search query).
- Store: migration 18 (`archives`, `archive_messages`,
  `archive_messages_fts` with triggers); list, page, search, get, remove.
- Adapter: `archive-import.ts` (stream a file, parse each message with the
  parser sync uses, batch insert, resume), attachment read by offset with a
  check that the bytes are still the same message.
- Server: three CLI commands; owner-only RPCs `archives_list`,
  `archive_messages`, `archive_message` (body), an attachment download
  through the existing one-time ticket.
- UI: the Archive rail page (`archive-view.tsx`), Russian texts.
- Docs, tests at each layer, one deploy at the end.

Estimated size: larger than any slice since 3k; two to three working
sessions of this kind.

## What was built

- `src/core/mbox.ts` (`MboxSplitter`, `isMboxSeparator`,
  `mboxSliceMessage`), `src/core/archive.ts` (types and bounds).
- Store: migration element 18 (`archives`, `archive_messages`,
  `archive_messages_fts`), pinned as `MIGRATIONS.slice(0, 19)`.
- `src/adapters/bb/archive-import.ts`: `importArchive`, `readArchiveRaw`,
  `readArchiveAttachment`.
- Server: the `archive` CLI command (add, list, remove), five owner-only
  RPCs (`SLICE_3P_METHODS`, 175 methods in all), the `/archive-download`
  route with its own one-time tickets.
- UI: the rail page, named **Local archive** so it is not taken for the
  Archive folder (`archive-view.tsx`), Russian texts.

## Different from the design

- The page is called "Local archive", not "Archive": a mailbox already has
  an Archive folder in the same rail.
- An unfinished import is continued by running `archive add` again; a
  complete archive is never re-read, even when the file grew.
- Inline (cid:) pictures of archive HTML are not shown.

## Not done

- No viewer for archive attachments (download only), no .eml download of
  an archive message, no conversations, no reply or forward.
- No progress while a large import runs; the command answers at the end.
- Not tried on a real export from Thunderbird, Apple Mail or Gmail
  Takeout; no second review pass and no rendered preview of the page.
