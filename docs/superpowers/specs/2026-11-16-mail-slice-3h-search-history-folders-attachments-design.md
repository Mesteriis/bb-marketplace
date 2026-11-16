# Makosh Mail — slice 3h: search, history, folders, attachments, reading (server search, older mail, operators, saved searches, folder management, Gmail labels, attachment viewer and files, reading comfort)

Status: builder's design, proposed to the owner on 2026-11-16. The owner
asked for the whole backlog to be closed and accepts sensible defaults; every
decision in "Owner's decisions" below is a proposal marked
*(owner, accepted 2026-11-16)* with a one-line rationale. It follows 3a
(organize and read), 3b (write and send), 3c (agent proposals and
translation), 3d (sending polish), 3e (inbox triage), 3f (agent and mail) and
3g (BB integration), all on `feat/mail-imap-slice`. Everything in the
slice-1, slice-2 and 3a–3g specs holds unless this document changes it, and
their "Resolutions" sections are the binding form. In particular: nothing is
ever expunged except 3b's `expungeOwn` of the plugin's own drafts; every
server fetch is `BODY.PEEK`; 3f's AI access scope, redaction and agent log
rules hold for every path that can reach an agent; 3g's "no BB patches, no
host entry, no terminal" holds.

Backlog (`docs/mail-feature-backlog.md`), checked on 2026-11-16 against the
file and the code:

| # | Item | Label now | Done today | In 3h |
| --- | --- | --- | --- | --- |
| 35 | Server search | кандидат | no IMAP search beyond the window | yes |
| 34 | History older than the window | кандидат | the window only | yes |
| 43 | Search operators | кандидат | `from:`, `subject:`, `is:unread`, `after:`, `before:` (`src/core/search.ts`) | the rest |
| 63 | Saved searches | кандидат | no | yes |
| 84 | Search in attachment text | позже | no | text and PDF |
| 83 | Semantic search | позже | no | local "Related mail" only; semantic stays later |
| 49 | Folder management | кандидат | CREATE of the snooze folder only (3e) | yes |
| 88 | Drag messages to folders | позже | no (the composer takes dropped files only) | yes |
| 79 | Gmail labels as labels | позже | label folders are synced as folders, copies deduplicated | yes |
| 50 | Attachment viewer | кандидат | download only (3a) | yes |
| 85 | Attachments overview | позже | no | yes |
| 54 | Thread management | кандидат | per-message collapse in the reading pane | the rest |
| 62 | Plain text and dark theme | кандидат | the HTML frame is forced light (`sanitize.ts` 72) | yes |
| 86 | Sender card | позже | no | yes |
| 89 | Print and save as PDF | позже | no | yes |
| 74 | List virtualization, big mailboxes | кандидат | keyset paging and "Load more" | **moved to 3j** |
| 76 | List density and pane layout | кандидат | no | **moved to 3j** |

Points the builder could not verify are marked **[unverified]** and collected
in "Not verified" at the end. "Open questions for the owner" lists the places
where a proposed decision is most likely to be changed. Each has a
recommendation, and the design below follows it.

## Owner's decisions

Proposed by the builder on 2026-11-16; each line is marked
*(owner, accepted 2026-11-16)* with a one-line rationale.

1. **Scope of 3h:** server search (#35), older mail on request (#34), search
   operators (#43), saved searches (#63), attachment text search (#84, text
   and PDF), local "Related mail" in place of semantic search (#83), folder
   create / rename / delete / subscribe (#49), drag to folders (#88), Gmail
   labels (#79), attachment viewer (#50), Files view (#85), thread
   management (#54), plain text and dark mail (#62), sender card (#86), print
   and save as PDF (#89). **#74 (list virtualization and big mailboxes) and
   #76 (list density and pane layout) move to 3j** (UI and reliability).
   *(owner, accepted 2026-11-16)* Both rework the same list component and
   need a performance harness; 3h only adds timing tests for its own queries.
2. **Server search runs only on the owner's click and only for the owner.**
   Under local results: **Search on the server** (per account or all). Gmail
   searches its All Mail folder with `X-GM-RAW`; other servers get
   `UID SEARCH` over Inbox, Sent, Archive and the owner's folders (Trash,
   Spam and Drafts only with `in:`), at most 30 folders and 60 seconds per
   account, on a read-only (`EXAMINE`) connection. The newest 50 hits are
   fetched into Mail (`BODY.PEEK`) and shown like local mail; **More from the
   server** fetches the next 50. Agents keep the local `mail_search`; there
   is no server-search tool. *(owner, accepted 2026-11-16)* It is network
   work on the owner's mail server, so it is a visible, bounded,
   owner-started action.
3. **Server hits are kept for 14 days unless opened.** A fetched hit is
   marked `search`; opening, flagging, moving or replying to it keeps it;
   otherwise it is removed from the local store (never from the server)
   after 14 days. *(owner, accepted 2026-11-16)* The base must not grow
   from every search, and an opened message must not vanish under the owner.
4. **Older mail loads in steps, per folder or per conversation.** At the
   end of a folder's list: **Load 30 more days** (at most 500 messages per
   step, newest first); in a conversation: **Load the whole conversation**
   (Gmail `X-GM-THRID`, else `HEADER Message-ID` / `References` searches).
   Loaded history is kept, reconciled with the server like the window, and
   dropped only by **Forget older mail** for that folder (a local delete).
   *(owner, accepted 2026-11-16)* The backlog asks for "по запросу … база не
   растёт без нужды"; steps make the cost visible and stoppable.
5. **Operators.** Added: `to:`, `cc:`, `has:attachment`, `filename:`,
   `in:` (role or folder), `account:`, `is:read`, `is:flagged` (`is:starred`),
   `is:unflagged`, `larger:` / `smaller:` (`10K`, `2M`), `newer_than:` /
   `older_than:` (`7d`, `2w`, `3m`, `1y`), `list:`, `category:`, `label:`;
   a leading `-` negates any operator; repeated operators AND, except `in:`
   and `account:`, which OR. No `OR` keyword, no free-text negation; unknown
   or malformed operators stay free text, as today, and the search shows a
   note under the box. *(owner, accepted 2026-11-16)* Gmail's names, which
   the owner already types, without a query language to secure.
6. **Saved searches are local.** **Save search** names the current query
   (and account); saved searches show in the rail under the folders with a
   local unread count, can be renamed, reordered and deleted, and open as a
   list like a folder. They never run on the server by themselves.
   *(owner, accepted 2026-11-16)* A virtual folder is a stored query, not a
   server object.
7. **Folder management never expunges.** **New folder…** (with a parent),
   **Rename…** and **Subscribe / Unsubscribe** for the owner's folders;
   **Delete folder…** only for an empty folder with no subfolders, checked
   on the server right before `DELETE`. A non-empty folder can be deleted
   only through an explicit second choice, **Move N messages to Trash, then
   delete**, which uses 3a's move (never a plain `EXPUNGE`; a server without
   `MOVE` refuses) and deletes only when the folder is then empty. INBOX,
   folders with a special use, Gmail's `[Gmail]` folders and the snooze
   folder cannot be renamed or deleted. Every command runs on a fresh
   connection with no mailbox selected. *(owner, accepted 2026-11-16)*
   imapflow sends `CLOSE` (which expunges `\Deleted` mail) before deleting or
   renaming a selected mailbox when `UNSELECT` is missing; nothing selected
   means that path never runs.
8. **Drag to folders.** Conversations (one or the selection) are dragged
   from the list onto a folder in the rail; the drop is 3a's move to that
   folder, undoable (3d), with the same refusals. Only Mail's own drag
   payload is accepted. *(owner, accepted 2026-11-16)* It is the move the
   owner already has, with the mouse.
9. **Gmail labels are labels.** For Gmail accounts Mail fetches
   `X-GM-LABELS` at sync and shows the owner's labels as chips on messages;
   **Labels…** adds or removes labels with `STORE X-GM-LABELS` on the All
   Mail copy (never a copy, move or expunge), undoable; system labels
   (`\Inbox`, `\Sent`, `\Trash`, `\Spam`, `\Draft`, `\Important`,
   `\Starred`) are not offered — Inbox and Starred keep their 3a actions.
   Label folders stay in the rail; a conversation no longer looks duplicated
   in them. *(owner, accepted 2026-11-16)* A label change is metadata on the
   owner's server; it cannot lose mail.
10. **Attachments are viewed in Mail's own viewer, never by BB's file
    preview.** Images (PNG, JPEG, GIF, WebP, AVIF, BMP; SVG only as an
    `<img>`), text (plain, CSV, Markdown, JSON, XML, logs, code, `.ics`,
    `.patch`; shown as text with BB's `experimental_SourceCode`) and PDF.
    The type is the declared type confirmed by the file's first bytes; a
    mismatch is download-only. Bytes come through a one-time ticket into a
    `Blob` the page never navigates to. HTML attachments show as source
    text. Office files, archives and everything else: download only.
    *(owner, accepted 2026-11-16)* BB's preview takes only live files
    (workspace, host path, thread storage); using it would mean writing
    untrusted mail bytes to disk outside a project.
11. **PDF is drawn with pdf.js — new dependency `pdfjs-dist`, exact pin
    `6.5.438`** (Apache-2.0; published 2026-11-01; 37.6 MB unpacked, about
    1.5 MB of it bundled — library plus worker, **[unverified]** until
    `bb plugin build` measures it; optional native `@napi-rs/canvas` is not
    used). Pages render to `<canvas>` with `isEvalSupported: false`, no
    scripting, no forms, no annotation layer, fonts from the file only, no
    network; links inside a PDF are listed under it by their real URL and
    opened only by click. If the owner declines the dependency, PDFs stay
    download-only and #84 covers text attachments only. *(proposed — owner to
    confirm)* It is the one vetted, pure-JavaScript PDF renderer; the
    sandboxed frame blocks the browser's own PDF plugin.
12. **Files view.** Rail **Files** lists every synced attachment (inline
    images left out) with filters by type, sender, account and date, and
    **View**, **Download**, **Save to project…** (3g) and **Open message**.
    Metadata only; nothing is fetched until the owner acts. *(proposed —
    owner to confirm)* The metadata is already stored.
13. **Attachment text is indexed only when the owner turns it on, and only
    here.** Setting `indexAttachmentText` (off): text-like attachments and
    PDFs up to 10 MB, in mail within the sync window (and loaded history),
    are fetched (`BODY.PEEK`), their text extracted on this machine (PDF with
    the same pinned pdf.js, in the plugin server, no canvas) and indexed in a
    separate local full-text index; at most 50 attachments per sync round.
    Agents never search or read attachment text. *(proposed — owner to
    confirm)* It costs bandwidth and disk, and attachment text has not passed
    the redaction agents rely on.
14. **No semantic search in 3h.** A plugin has no local embedding model, and
    computing embeddings through Makosh AI would send all mail to a provider,
    which the backlog's own risk note forbids. Instead the reading pane gets
    **Related mail**: a local ranking by shared distinctive words of the
    subject and opening lines, shared participants and references. #83 stays
    `[позже]` with that note. *(owner, accepted 2026-11-16)* Nothing leaves
    the machine and the owner still gets "more like this".
15. **Thread management.** Quoted text is hidden by default with **Show
    quoted text** per message (plain text: 3f's `stripQuoted` rules; HTML:
    quote blocks marked by the sanitizer and hidden with CSS); **Expand all /
    Collapse all**; per folder **Group by conversation** (on by default) —
    off lists single messages. *(owner, accepted 2026-11-16)* Defaults keep
    today's grouping; hiding quotes is the common default in mail clients.
16. **Plain text and dark mail.** Per message **Plain text / Original**, and
    a setting for the default; when BB is dark, HTML mail is shown with
    adapted colors (a CSS-only inversion inside the sandboxed frame, images
    and media re-inverted) unless the message declares its own dark styles,
    with **Original colors** per message and a setting to turn it off.
    *(owner, accepted 2026-11-16)* Pure CSS inside the existing sandbox; no
    script, no new request.
17. **Sender card.** Clicking a sender opens a side card: name and address,
    message counts both ways, first and last date, the latest 10
    conversations, the latest files, and the actions Mail already has (search
    `from:`, Always show images, Block, project binding). Local only.
    *(owner, accepted 2026-11-16)* Everything shown is already stored.
18. **Print and Save as PDF.** **Print…** on a message or the conversation
    builds a print document (headers and the sanitized body, remote images
    only when already allowed) in a hidden sandboxed frame without scripts and
    calls its `print()`; the system dialog's **Save as PDF** saves the file.
    Where printing is unavailable, **Save printable page** downloads the same
    document as `.html` through `experimental_saveFile`. *(proposed — owner to
    confirm)* No PDF library is needed to make a PDF.
19. **What 3h sends outside the machine:** only IMAP commands to the owner's
    own mail server — server search criteria (the search words), fetches of
    older mail, hits and (opt-in) attachments, folder `CREATE` / `RENAME` /
    `DELETE` / `SUBSCRIBE` / `UNSUBSCRIBE`, `STORE X-GM-LABELS` and 3a moves.
    Nothing goes to an AI provider and there is no new HTTP request.
    *(owner, accepted 2026-11-16)* README and `PLUGIN_OVERVIEW.md` list each
    new server write.
20. **One migration element (13)**, appended to `MIGRATIONS`; element 12
    (the 3g review) and 13 join the SHA pin. *(owner, accepted 2026-11-16)*
    Shipped elements stay frozen, as in every slice.

## Goals

1. **Server search** beyond the window, per account or all, owner-started,
   bounded, cancellable (#35).
2. **Older mail** per folder in steps and per conversation, kept and
   reconciled until forgotten (#34).
3. **Operators** for recipients, attachments, folders, accounts, flags,
   sizes, relative dates, lists, categories and labels, with negation (#43).
4. **Saved searches** in the rail with unread counts (#63).
5. **Attachment text search**, opt-in, local, text and PDF (#84).
6. **Related mail**, local and explainable (#83, partial).
7. **Folder management** without any expunge (#49), and **drag to folders**
   (#88).
8. **Gmail labels** as chips, set and removed on the server (#79).
9. **Attachment viewer** for images, text and PDF, isolated (#50).
10. **Files view** over all attachments (#85).
11. **Thread management**: hidden quotes, expand/collapse all, grouping per
    folder (#54).
12. **Plain text and dark mail** (#62).
13. **Sender card** (#86).
14. **Print and save as PDF** (#89).

## Non-goals (later or backlog)

- Semantic search with embeddings (#83 proper); any model call in 3h.
- Server search for agents (`mail_search` stays local); agents reading
  attachment text; a viewer or index for Office documents, archives, `.eml`
  attachments, audio or video.
- Saved searches that run on the server, notify, or act (rules are 3e/3g's).
- An `OR` keyword, parentheses, regular expressions, free-text negation.
- Folder sharing, ACLs, quotas, moving a folder under another parent
  (rename keeps the parent), deleting a folder that has subfolders.
- Creating or deleting Gmail labels as such (a label is created by being
  added to a message; deleting a label is a folder delete of a non-system
  label folder and follows decision 7).
- Rendering HTML attachments; executing, unpacking or opening any attachment
  outside Mail's viewer; BB's file preview for mail attachments.
- List virtualization, density, pane position (#74, #76 → 3j).
- Import of `.eml` / mbox (#95), backup (#94).

## Anti-goals

- **Any expunge.** No folder operation, label change, search or history load
  may remove a message from the server. Folder delete runs only on an empty
  folder; emptying goes through 3a's `MOVE` to Trash.
- **Mail leaving the machine for indexing or ranking.** Attachment text,
  related mail and operators are computed locally; no embeddings, no
  provider call.
- **Attachment content treated as a document.** No viewer path executes
  scripts, follows links by itself, loads remote resources or renders HTML.
- **Silent growth.** Server hits and history are owner-started and capped;
  search hits expire; history is forgettable.
- **Search words in logs.** The plugin log and the agent log never carry a
  query, a folder name, a label name or a file name; counts and outcome codes
  only.

## Design

### Code, SDK and host facts this design relies on

Line numbers are in the current tree (`plugins/mail/…`) unless marked "sdk"
(`node_modules/@get-bb/plugin-sdk/bundled-types/bb-plugin-sdk.d.ts`, SDK
0.6.132), "imapflow" (`node_modules/imapflow/dist/cjs/…`, imapflow 2.11.0)
or "root" (the repository root).

| Fact | Where |
| --- | --- |
| The parser knows `from:`, `subject:` (quoted values), `is:unread`, `after:` / `before:` (ISO dates). Unknown operators, empty values and bad dates stay free text. Ported from Velo (Apache-2.0, listed in root `THIRD_PARTY_NOTICES.md`). | `src/core/search.ts` 1–96; `src/core/model.ts` 447–454 |
| Local search: trigram FTS5 over subject, sender name/address and body text (≥ 3 characters, else `LIKE`); filters for the parsed fields; `move_pending` rows hidden; AI-scope filter on agent paths; one hit per dedup key (Inbox copy first). It searches every folder; there is no folder filter. | `src/adapters/bb/sqlite-store.ts` 222–250, 939–940, 2951–3010 |
| `search` RPC: `{ query ≤ 500, accountId \| null, limit ≤ 50 }` → `{ hits }`. Agent search refuses secret-like free text (`agentSearchRefusal`) and re-checks hits. | `src/core/contract.ts` 398–405; `src/core/redact.ts` 1392–1399; `server.ts` 935–950 |
| Sync window: `since = now − windowDays`; initial sync `searchSince(since)`; reconcile fetches missing window uids, checks flags of local rows dated inside the window, deletes a row only when a UID FETCH returns nothing. Rows outside the window are never checked or pruned today. | `src/core/sync.ts` 559–590, 739–781 |
| `sync_state(account_id, folder, uid_validity, last_uid, synced_since)`. A UIDVALIDITY change detaches rows and deletes those not reattached after the round. | `sqlite-store.ts` 158–164; `src/core/sync.ts` 16–18 |
| Gateway: `openFolder({ readOnly })`, `searchSince`, `uidsAfter`, `fetchMessages`, `fetchFlags`, `fetchRaw(uid, maxBytes)`, `findByMessageId` (UID SEARCH HEADER), `moveMessages` (refuses without MOVE), `capabilities()` (`uidplus`, `gmail`), `createFolder` (fresh connection, logout after). A refused SEARCH throws `SearchFailed`. | `src/core/ports.ts` 75–188; `src/adapters/bb/imapflow-gateway.ts` 167–198, 357–372, 643–650 |
| Folders come from `client.list()`; `toRemoteFolders` keeps `path`, `name`, `delimiter`, special use and selectability, drops `\Flagged` / `\Important` virtual folders and LSUB-only entries. The subscription state is not kept. | `imapflow-gateway.ts` 635, 898–925; `src/core/model.ts` 408–414 |
| imapflow `SearchObject`: `from`, `to`, `cc`, `bcc`, `subject`, `body`, `text`, `larger`, `smaller`, `before`, `since`, `on`, `sentBefore` / `sentSince`, `seen`, `flagged`, `header`, `not`, `or`, `uid`, `emailId`, `threadId` (OBJECTID or X-GM-EXT-1), `gmraw` / `gmailraw` (X-GM-RAW), `labels: { has, not }` (Gmail). Non-ASCII values get `CHARSET UTF-8` unless `UTF8=ACCEPT`. | imapflow `types.d.ts` 431–511; `search-compiler.js` 289–332, 486–492 |
| imapflow `mailboxCreate` (also SUBSCRIBEs), `mailboxRename`, `mailboxDelete`, `mailboxSubscribe`, `mailboxUnsubscribe`; `ListResponse.subscribed`; `status()` with `messages`. **`mailboxDelete` and `mailboxRename` first run `CLOSE`/`UNSELECT` when the target is the selected mailbox; `CLOSE` would expunge `\Deleted` mail.** | imapflow `imap-flow.d.ts` 297–344; `types.d.ts` 331–356, 389–425; `commands/delete.js` 18–24, `commands/rename.js` 23–28, `commands/create.js` 55–60 |
| Gmail labels: fetch `labels: true` (X-GM-LABELS); `messageFlagsAdd` / `messageFlagsRemove(range, flags, { uid: true, useLabels: true })` change labels instead of flags. | imapflow `types.d.ts` 548–549, 753–762; `imap-flow.d.ts` 429, 443 |
| imapflow `download(range, part, { uid, maxBytes })` streams one body part by IMAP part number. Mail's stored `part_id` is the postal-mime attachment index, not an IMAP part number, so attachment bytes come from the guarded `fetchRaw` + `parseMail` path. | imapflow `imap-flow.d.ts` 626, `types.d.ts` 693–705; `server.ts` 3218–3268 |
| `GET /download?t=<ticket>`: single-use 60 s tickets, guarded raw fetch, part checked against stored name, type and size; headers `attachment` disposition, `nosniff`, `Content-Security-Policy: default-src 'none'`. Raw messages over 50 MB are refused. | `server.ts` 3209–3268; `src/adapters/bb/downloads.ts` 20–35, 105–135 |
| HTML mail: `sanitizeEmailHtml` → a document with a CSP meta and `BASE_STYLE` (`color-scheme: light`, system colors) in `<iframe sandbox="allow-same-origin" srcDoc>`; the parent reads `contentDocument` to size it and route link clicks. | `src/ui/sanitize.ts` 69–81, 307–337; `src/ui/message-frame.tsx` 140–209 |
| Reading pane: messages oldest first, collapsed rows show sender/date/snippet. `stripQuoted` (">" lines and a trailing "On … wrote:" / Russian "написал(а):") exists for AI input; `quoteFreeBody` for BB text. | `src/ui/reading-pane.tsx` 3–4, 353–451; `src/core/ai-input.ts` 110–138; `src/core/bb-text.ts` 91–102 |
| Threads list: keyset paging (`threads_list`, limit ≤ 100), **Load more**. `listThreads` timing test at a few thousand messages per page. | `src/core/contract.ts` 364–376; `src/ui/thread-list.tsx` 388; `sqlite-store.test.ts` 780–835 |
| `message_action` with action `move` and `destination` moves up to 200 messages, undoable (3d `undoId`). | `src/core/contract.ts` 422–440 |
| The composer accepts dropped files (`dataTransfer.files`); no other drag-and-drop in Mail. | `src/ui/composer.tsx` 803–811 |
| **BB file preview** takes only live files: `ExperimentalLiveFileTarget` is `workspace` (environment + path), `host` (host + path) or `thread-storage`. `experimental_openFilePreview({ target, location, opener? })`; `experimental_FilePreview` draws BB's preview with an optional `renderPreview` for HTML, Markdown and CSV. `files.createPreview({ rootPath, ttlMs })` → `{ baseUrl, expiresAtMs }` serves a host directory. A plugin may register a `fileOpener` for extensions. | sdk 17853–17876, 22349–22370, 24147–24160, 25257, 26281–26325, 26520 |
| `experimental_saveFile({ fileName, url } \| { fileName, blob })` → `started` \| `failed` (BB's download path; iOS share sheet). | sdk 23164–23182, 27043 |
| `experimental_ImageLightbox({ imageSrc, imageAlt, title, isOpen, onClose, … })`; `experimental_SourceCode({ content, path, … })`. | sdk 24736–24749, 27219, 27113 |
| `experimental_useCodeTheme()` → `{ mode: "dark" \| "light", name, theme }`; `mode` changes the moment the user switches light/dark. No other theme-mode API for plugin pages. | sdk 23143–23155, 27019 |
| No SDK API for printing, for drag-and-drop between a plugin page and BB, or for the page's CSP; thread-row drag (`dragThreadIds`) is for BB's sidebar only. | sdk (searched: `print`, `drag`, `drop`, `iframe`, `worker-src`, `blob:`) |
| Settings: `syncWindowDays`, `syncIntervalMinutes`, … `taskTarget` (3g). | `server.ts` 441–590 |
| `MIGRATIONS` has elements 0–12 (12 = 3g review: `rule_threads`, `rule_runs` v2); the pin test covers `MIGRATIONS.slice(0, 12)` (0–11). No `REFERENCES` in new tables; deletes are explicit (3c resolution 17). | `sqlite-store.ts` 141–811; `sqlite-store.test.ts` 755–778 |
| Folder paths are stored in `messages.folder`, `sync_state.folder`, `folders.path`, `compose_drafts.server_folder`, `accounts.snooze_folder`, `snoozes.return_to`. | `sqlite-store.ts` 158–164, 167–193, 265–273, 334, 477, 481–490 |
| There is no index on `messages.from_address`. | `sqlite-store.ts` 194–197, 262–263 |
| RPC output keys must not match `/pass\|secret\|seal\|key/i`. | `src/core/contract.test.ts` 35, 712 |
| Keys in use: `a b c d e f g i j k n o r s t u v x z`, `#`, `!`, `/`, `?`, digits, `g`-sequences for Inbox, Sent, Drafts, Trash, All, Dev. | `src/ui/shortcuts.ts` |

### User flows

1. **Operators (#43).** The owner types `from:anna has:attachment
   newer_than:3m -in:trash invoice`. Hits narrow as typed. A bad value
   (`larger:abc`) stays text and the box shows "larger:abc — not understood
   (sizes look like 10K or 2M)". The search box's help popover lists the
   operators.
2. **Server search (#35).** Below local hits: "12 in Mail · **Search on the
   server**". A strip shows per account "iCloud: 4 of 23 folders… · Cancel";
   hits arrive in the same list marked "from the server"; "Gmail: 50 shown ·
   **More from the server**". Partial: "iCloud stopped after 30 folders —
   narrow with in:". A refused search: "This server could not search for
   this text".
3. **Save a search (#63).** **Save search** in the search header → name
   (prefilled with the query) → the rail's **Saved** section shows "Invoices
   · 3". Its menu: **Rename**, **Edit query**, **Move up/down**, **Delete**.
4. **Older mail (#34).** At the end of a folder: "Showing mail since 17 Oct
   · **Load 30 more days**" → "Loading… 120 of ~340 · Stop" → "Showing mail
   since 17 Sep". The folder menu has **Forget older mail** ("Removes 340
   messages older than the sync window from Mail. Nothing changes on the
   server."). In a conversation: "Older messages of this conversation may be
   on the server · **Load the whole conversation**".
5. **Folders (#49).** Rail folder menu: **New subfolder…**, **Rename…**,
   **Subscribed** (check), **Delete…**. Account menu: **New folder…**.
   Delete of an empty folder: "Delete *Receipts 2019*? It is empty." Delete
   of a non-empty one: "*Receipts 2019* has 41 messages. Move them to Trash
   first?" → **Move 41 to Trash, then delete** / **Cancel**. Refusals:
   "Inbox and system folders cannot be deleted", "Delete its subfolders
   first".
6. **Drag (#88).** The owner drags a conversation (or the selection: "3
   conversations") onto *Projects* in the rail; the folder highlights; drop
   → "Moved 3 conversations to Projects · Undo".
7. **Labels (#79).** A Gmail message shows chips "Travel · Receipts". **L**
   or **Labels…** opens a checklist of the account's labels with a filter
   and **New label…**; **Apply** → "Labels changed · Undo".
8. **View an attachment (#50).** Clicking an attachment (or **View**) opens
   the viewer sheet: header (name, type, size, **Download**, **Save to
   project…**, **Close**), body: the image (zoom to fit / 100%), the text
   with line numbers, or the PDF (page strip, zoom, "Page 3 of 12", "Links in
   this PDF (2)"). Not viewable: "This file type opens only after download".
9. **Files (#85).** Rail **Files** (`g f`): a table "Name · Type · Size ·
   From · Date · Account" with filters **Type** (Images, PDF, Documents,
   Archives, Calendar, Other), **From**, **Account**, a name filter, and
   **Load more**; row actions **View**, **Download**, **Save to project…**,
   **Open message**.
10. **Attachment text (#84).** With the setting on, search hits that matched
    inside an attachment show "in *report.pdf*: … quarterly totals …". Mail
    settings show "Attachment text: 1 240 indexed · 18 skipped (too large or
    unreadable) · indexing…".
11. **Related mail (#83).** Under the conversation: "Related (5) ▾" — rows
    with a reason ("same people", "similar subject", "mentions INV-2041").
12. **Thread management (#54).** Quoted text collapses to "··· Show quoted
    text"; the conversation header has **Expand all** / **Collapse all**
    (`;`); the folder menu has **Group by conversation** (check).
13. **Plain text and dark (#62).** Message menu: **Show plain text** /
    **Show original**; in dark BB an HTML mail shows in dark colors with
    **Original colors** in the message menu. Settings: "Show mail as:
    Original / Plain text", "Dark mail: Adapt colors / Original colors".
14. **Sender card (#86).** Clicking a sender's name opens a card beside the
    reading pane: "Anna Example · anna@example.com · 48 from, 12 to · since
    3 Mar 2025 · last 2 days ago", conversations, files, actions.
15. **Print (#89).** Message or conversation menu **Print…** (`Shift+P`) →
    the system print dialog (on macOS **PDF ▸ Save as PDF**). Without print
    support: **Save printable page** downloads `2026-11-16 Subject.html`.

### Search operators (`src/core/search.ts`)

- The tokenizer stays (forward scan, quoted values, Unicode spaces). A token
  `-name:value` is a negated operator; a bare `-word` stays free text.
- `ParsedQuery` keeps `text`, `from`, `subject`, `unread`, `after`, `before`
  for existing callers and gains `conditions: SearchCondition[]` and
  `notes: SearchNote[]`:
  `SearchCondition = { field, value, negated }` with `field` one of
  `from | to | cc | subject | has | filename | in | account | is | larger |
  smaller | after | before | list | category | label`; relative dates are
  turned into `after` / `before` against the clock passed in
  (`parseQuery(raw, now)`; callers without a clock keep today's behaviour).
  The store builds SQL from `conditions` only; the old fields are derived
  from them and removed in the last task once no caller reads them.
- Values: `has:` `attachment` \| `attachments` (only); `is:` `unread` \|
  `read` \| `flagged` \| `starred` \| `unflagged`; sizes `^\d{1,9}(\.\d+)?[KM]?$`
  (bytes, case-insensitive, capped at 2 GB); relative dates `^\d{1,4}[dwmy]$`;
  `in:` a role name (`inbox`, `sent`, `drafts`, `spam`/`junk`, `trash`,
  `archive`, `all`, `snoozed`) or a folder path or name (case-insensitive);
  `account:` an account email or display name; `filename:` a name fragment,
  or an extension when it has no dot (`filename:pdf` ≡ ends with `.pdf`).
  Each value ≤ 200 characters, control characters removed. Anything else is
  free text with a note (`unknown_operator`, `bad_value`).
- Combination: conditions AND; several `in:` or several `account:` OR among
  themselves; `-` wraps one condition in `NOT`. Free text stays one FTS5
  phrase (literal), as today.
- **SQL** (`sqlite-store.ts` `search`): `to:` / `cc:` → `mail_lower(to_json)`
  / `cc_json` `LIKE`; `has:attachment` → `has_attachments = 1`; `filename:`
  → `EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id AND
  a.is_inline = 0 AND …)`; `in:` → `m.folder` (paths resolved by
  `listFolders` roles, before the dedup so a hit in Trash is found by
  `in:trash`); `account:` → resolved to ids; `is:` → `is_read` / `is_flagged`
  (desired state first, as the list does); `larger:` / `smaller:` → `size`;
  `list:` → `list_id LIKE` (3g column); `category:` → `message_categories`
  (3f); `label:` → Gmail `gm_labels` (below) or, for non-Gmail accounts, the
  folder name. Bound parameters only; `LIKE` patterns through the existing
  `likePattern`.
- **Agents.** `mail_search` gets the same operators. `agentSearchRefusal`
  runs on every free-text-bearing value (`to:`, `cc:`, `subject:`,
  `filename:`, `list:`, `label:`, the text), not only text and subject;
  scoped searches never consult attachment text (decision 13).
- **Help.** A static operator list in the search popover (`search-help.tsx`).

### Server search (`src/core/server-search.ts`, `src/adapters/bb/server-search-jobs.ts`, new)

- **Plan (core, pure).** `planServerSearch(query, account, folders)` →
  `{ gmail: { folder, raw } } | { folders: { path, criteria }[] } |
  { refused: reason }`.
  - Gmail (`capabilities().gmail`, decided at run time): the folder with
    special use `all`; `raw` is a Gmail query built from conditions:
    `from:"…"`, `to:"…"`, `cc:"…"`, `subject:"…"`, `has:attachment`,
    `filename:"…"`, `larger:10M`, `smaller:…`, `after:YYYY/MM/DD`,
    `before:…`, `is:unread`/`is:read`/`is:starred`, `-is:starred`,
    `in:` roles (`in:inbox`, `in:sent`, `in:trash`, `in:spam`) or `label:"…"`,
    each negated with `-`; free text as one quoted phrase. Every value is
    stripped of `"` and control characters before quoting. `in:trash` /
    `in:spam` add Gmail's `in:anywhere`.
  - Others: folders = the `in:` folders, else Inbox, Sent, Archive and the
    folders without a special use, never Trash, Junk, Drafts unless named;
    selectable only; at most 30 (the rest reported as `skipped`). Criteria:
    text → `text`, `from`/`to`/`cc`/`subject` → the same keys, dates →
    `since` / `before` (INTERNALDATE; one-day slack each side, rechecked on
    the fetched header date), sizes → `larger` / `smaller`, `is:` → `seen` /
    `flagged`, negations → `not`. `has:attachment` and `filename:` have no
    IMAP criterion and are applied to the fetched rows (`has_attachments`,
    stored names). `list:`, `category:` and non-Gmail `label:` are local
    only: the plan drops them and the result says "list: is not used on the
    server".
  - A query with no condition the server can use (only local-only operators)
    is refused before any connection.
- **Run (adapter).** One job per account, at most one running per account
  and three in all; each job is a `GatewayJob` with progress. Per folder:
  `openFolder(…, { readOnly: true })` (`EXAMINE`), `search(criteria, { uid:
  true })` → uids (at most 2 000 per folder kept), `close`. Then the newest
  50 uids not already stored (by `(account, folder, uid)` and by dedup key
  after fetch) are fetched with the existing `fetchMessages` (`BODY.PEEK`,
  the same caps) and inserted with `kept = 'search'`, `kept_at = now`; the
  rest stay as a cursor in the job (`More from the server` fetches the next
  50). Threads are rebuilt for the account once per batch. A 60-second
  budget per account and the owner's **Cancel** abort between folders and
  between fetch batches; what was fetched stays.
- **Not on the write queue.** The job uses its own read-only connection and
  never writes to the server, so it does not wait for the account's write
  queue (`account-queue.ts`); store writes are synchronous transactions like
  sync's.
- **Gateway port.** `FolderSession.searchServer(criteria: ServerCriteria):
  Promise<number[]>` (`ServerCriteria` = Mail's own type, translated to
  imapflow's `SearchObject` in the adapter; `gmailRaw` only when the session
  says `gmail`). A refusal throws `SearchFailed` (existing code); a server
  that refuses `CHARSET UTF-8` → `SearchCharsetRefused` → "This server could
  not search for this text".
- **Results in the list.** `search` (local) returns rows of every `kept`
  state; the hit row shows "from the server" when `kept = 'search'`.
- **Expiry.** The day clock (`day-clock.ts`) once a day deletes, locally,
  rows with `kept = 'search'` and `kept_at` older than 14 days (setting
  `serverSearchKeepDays`), with their attachments, inline parts and
  attachment text, then rebuilds threads. Opening, flagging, moving,
  replying to, snoozing, labelling or binding a `search` row sets `kept =
  'opened'` (never expires). A history load that covers a `search` row sets
  `kept = 'history'`.
- **Reconcile.** `search` and `opened` rows outside the reconciled range are
  not checked; when the owner opens one the guarded raw fetch already
  reports "no longer on the server", and the row is then deleted locally.

### Older mail (#34) (`src/core/history.ts`, new; `sync.ts`)

- **Per folder.** `history_load({ accountId, folder })`: from = the folder's
  `history_since ?? synced_since`; range = `[from − historyStepDays, from)`
  (default 30 days). `searchSince` + `before` on a read-only session gives
  uids; the newest 500 not stored are fetched (`BODY.PEEK`) into the store
  with `kept = 'history'`. When the range had at most 500 new uids,
  `history_since` moves to the range start; otherwise to the date of the
  oldest fetched message (the next step continues from there). An empty
  range moves `history_since` too, and after three empty steps in a row the
  list says "No older mail on the server in this folder". Progress and
  **Stop** through the same job polling as server search.
- **Per conversation.** `conversation_load({ threadId })`: Gmail → the
  thread's `gm_thrid` with `threadId` on All Mail; others → for each
  Message-ID in the conversation's `refs` and `message_id` (at most 50),
  `HEADER References <id>` and `HEADER Message-ID <id>` in the folders the
  conversation lives in plus Sent and Archive; at most 100 messages fetched
  with `kept = 'history'`; threads rebuilt.
- **Reconcile covers history.** `reconcile` uses `min(since, history_since)`
  for the local rows it checks, so a message deleted on the server leaves
  the loaded history too. `searchSince` for the window part is unchanged;
  the history part is checked by `fetchFlags` only (no re-search), in the
  existing 500-uid batches.
- **UIDVALIDITY reset** clears `history_since`; kept rows are detached with
  the rest and those not reattached by the window fetch are deleted, as
  today. The list then offers **Load 30 more days** again.
- **Forget older mail.** `history_forget({ accountId, folder })` deletes,
  locally, the folder's rows dated before `synced_since` whose `kept` is
  `history` or `search` (not `opened`), clears `history_since`, rebuilds
  threads. Shows the count first (`history_forget_check`).
- **Window setting change.** `syncWindowDays` raised: the window grows as
  today; rows inside it are window rows regardless of `kept` (the column is
  ignored inside the window and cleared by reconcile when it sees them
  there).

### Saved searches (#63) (`src/core/saved-searches.ts`, new)

- Table `saved_searches` (below). Name 1–60 characters, query 1–500 (same
  as `search`), optional account. At most 50.
- Opening one runs the local `search` with `limit` 50 and paging (`search`
  gains an optional `cursor`, keyset by `(date DESC, seq DESC)` over the
  deduplicated rows); the list header shows the query with **Edit** and
  **Search on the server**.
- Rail count: unread hits, computed with the search capped at 500 rows
  (`499+`), refreshed on the same realtime ticks as folder counts and at most
  once per 30 seconds per saved search.
- Routes: subPath `s/<savedSearchId>`; a missing id shows "This saved search
  was deleted".

### Attachment text (#84) (`src/core/attachment-text.ts`, `src/adapters/bb/attachment-indexer.ts`, `src/adapters/bb/pdf-text.ts`, new)

- **When.** After an ok sync round, when `indexAttachmentText` is on: the
  candidates are non-inline attachments of rows in the window or loaded
  history (not `search`), kind `text` or `pdf`, size ≤ 10 MB, message raw
  size ≤ 25 MB, not yet in `attachment_text`, newest first, at most 50 per
  round and 200 MB of raw fetch per day. Spam and Trash are skipped.
- **Fetch.** The guarded raw fetch (`fetchRawGuarded`, read-only, `BODY.PEEK`)
  and `parseMail`, then the part by index with the stored name, type and
  size check — the download route's rules. One message's attachments are
  indexed from one fetch.
- **Extract.** Text kinds: decoded with the part's charset (UTF-8 fallback,
  invalid bytes replaced), control characters removed. PDF: `pdfjs-dist`
  legacy build in the plugin server with `isEvalSupported: false`,
  `disableFontFace: true`, `useSystemFonts: false`, no worker, no
  `standardFontDataUrl`, no URL loading (`data` bytes only); at most 200
  pages and 20 seconds per file, checked between pages; encrypted PDFs are
  `skipped/encrypted`. Text capped at 200 000 characters, whitespace runs
  collapsed. Failures are rows with `state = 'failed'` and a reason code; a
  failed file is not retried until the owner presses **Retry failed**.
- **Search.** The local `search` (owner path only) also matches
  `attachment_text_fts` with the same phrase and returns, per hit, the first
  matching attachment's name and a 120-character excerpt
  (`attachmentMatch`). Scoped (agent) searches never join it.
- **Turning it off** stops indexing; **Remove attachment text** deletes the
  table's rows.

### Related mail (#83, partial) (`src/core/related.ts`, new)

- Input: the open message. Terms: up to 8 distinctive words of its subject
  and first 2 000 characters of body text (stop words in English and
  Russian removed, numbers ≥ 4 characters and ticket-like tokens such as
  `INV-2041` kept), each ≥ 4 characters.
- Candidates (≤ 200, local, in the same account and not in Spam/Trash): FTS5
  matches of each term (trigram, so substring-tolerant), rows sharing a
  participant (From/To/Cc address), rows sharing a Message-ID reference.
  Score = matched terms (weighted by rarity, `bm25` of the trigram index as
  the tie-break) + 2 per shared participant + 5 for a shared reference; the
  open conversation excluded. Top 10, each with its reason.
- No model, no network; the computation is bounded (≤ 200 candidates, one
  query per term) and timed in the store tests.

### Folder management (#49) (`src/core/folder-ops.ts`, new; gateway)

- **Names.** A new or renamed folder name: 1–100 characters after trim, no
  control characters, does not contain the account's delimiter, not `.` or
  `..`, not INBOX in any case. The path is `parent + delimiter + name` (or
  `name` at the top), compared case-insensitively with existing paths before
  sending.
- **Gateway port** (all on a fresh connection, nothing selected, logout
  after; through the account's write queue; errors mapped to Safe codes,
  never server text):
  - `createFolder(config, path)` — existing (CREATE + SUBSCRIBE).
  - `renameFolder(config, from, to)` → `{ path }`; `RenameFailed`.
  - `folderStatus(config, path)` → `{ messages, uidValidity }` (`STATUS`).
  - `deleteFolder(config, path, { expectEmpty: true })`: `STATUS messages`
    then `DELETE` on the same connection; `NotEmpty` when `messages > 0`;
    `DeleteFailed` on refusal.
  - `setSubscribed(config, path, subscribed)`; `SubscribeFailed`.
  - `listFolders` keeps `subscribed` (imapflow `ListResponse.subscribed`);
    `RemoteFolder` and `Folder` gain `subscribed: boolean` (servers without
    LSUB/LIST-EXTENDED report every folder subscribed).
- **Refusals before any command:** INBOX; a special-use folder; a path under
  Gmail's `[Gmail]` (`[Google Mail]`); the account's snooze folder; for
  delete, a folder with children (from the stored folder list, rechecked by
  a fresh `LIST` in the same connection); a folder with `move_pending` rows
  or queued moves into it; a non-selectable parent for rename.
- **Rename** re-homes locally in one transaction after the server answers:
  every stored folder path equal to `from` or starting with `from +
  delimiter` (children) is rewritten in `messages.folder`,
  `sync_state.folder`, `folders.path`, `compose_drafts.server_folder`,
  `accounts.snooze_folder`, `snoozes.return_to`, `folder_prefs.path` and
  saved searches' `in:` values are left as typed (they resolve by name or
  path at run time; a missing folder shows a note). A test lists every
  table column named `folder`, `path`, `*_folder` or `return_to` from
  `sqlite_master` and fails when one is not covered. The next sync's
  UIDVALIDITY check handles servers that change it on rename.
- **Delete, empty:** `folder_delete_check` → `{ messages (server), children,
  refusal? }`; `folder_delete({ expectedMessages: 0 })` → `deleteFolder` →
  local rows, sync state and prefs of that path removed (they were empty).
- **Delete, non-empty (explicit):** `folder_delete({ moveToTrash: true,
  expectedMessages: N })`: refused when the server count differs from `N`
  (the dialog's number), or when the account has no Trash or no `MOVE`
  (3a's `MoveUnsupported`). Then all uids (`SEARCH ALL` on a read-write
  session) are moved to Trash with 3a's `moveMessages` in 500-uid batches
  (rows re-homed as 3a does; the action is **not** offered as undo — the
  dialog says so; the messages are in Trash), `STATUS` again, and `DELETE`
  only at 0. A non-zero count after the moves (mail arrived meanwhile) stops
  with "New mail arrived in the folder; it was not deleted".
- **Gmail:** deleting a non-system label folder removes the label only; the
  same checks apply (decision 7) so the behaviour does not depend on the
  provider.
- **Subscribe:** `folder_subscribe({ subscribed })`; Mail keeps syncing a
  folder whether or not it is subscribed (subscription is shown and set for
  other clients); unsubscribed folders show dimmed under **More folders**.
- After any operation the account's folders are re-listed (`saveFolders`)
  and a sync of the affected folders is queued.

### Drag to folders (#88) (`src/ui/drag-move.ts`, new)

- Thread rows are `draggable`; dragging a selected row carries the whole
  selection (≤ 200 messages as `message_action` allows; more → "Move up to
  200 at a time"). `dataTransfer` gets `application/x-makosh-mail-move` with
  `{ v: 1, pageId, threadIds }` (`pageId` = a random id per Mail page load)
  and a text fallback with the count only.
- Rail folders accept a drop only with that type and the current `pageId`;
  the thread ids are resolved against the page's loaded list; the drop
  calls the existing move with `destination` (role targets use the role
  action: dropping on Trash is **Delete**, on Spam is **Spam**, on Archive
  is **Archive**). Same refusals and undo as the move dialog. All accounts:
  only folders of the dragged messages' account accept (others show "not
  allowed").
- Keyboard and screen readers keep `v` (Move to…); the drag adds
  `aria-describedby` text only.

### Gmail labels (#79) (`src/core/labels.ts`, new)

- **Sync.** For Gmail accounts (`preset` gmail or `capabilities().gmail`),
  `fetchMessages` and `fetchFlags` also request `labels` (X-GM-LABELS) on
  the All Mail folder; the store keeps `gm_labels` (a JSON array of label
  names as the server sent them, system labels included) on the All Mail
  row, and the reconcile flag pass refreshes it. Rows in label folders read
  their message's All Mail row by dedup key.
- **Show.** Chips for the owner's labels (system labels left out; `\Inbox`
  etc. are already roles); the list row shows up to three.
  `label:` matches `gm_labels`.
- **Change.** `labels_change({ messageIds, add, remove, undoId })` resolves
  each message to its All Mail uid (refused when the message has no All
  Mail copy yet: "Sync this account first"), runs `messageFlagsAdd` /
  `messageFlagsRemove` with `{ uid: true, useLabels: true }` on a
  read-write All Mail session through the write queue, updates
  `gm_labels`, and records the inverse change as the undo action (3d). A
  label name: 1–100 characters, no control characters, not a system label,
  not starting with `\`. Adding a new name creates the label on Gmail.
  Gmail's label folders appear at the next folder listing.
- **Dedup in label folders.** Unchanged: copies share a dedup key; the
  chips make the copies' meaning visible.

### Attachment viewer (#50) (`src/ui/attachment-viewer.tsx`, `src/ui/pdf-view.tsx`, `src/core/file-kinds.ts`, new)

- **Kinds** (`fileKindOf(mimeType, filename)` → `image | pdf | text |
  document | archive | calendar | other`, also stored in
  `attachments.kind`). Viewable: `image`, `pdf`, `text`, `calendar` (as
  text).
- **Bytes.** `attachment_view_ticket({ messageId, partId })` → `{ url, kind,
  mimeType, size }` or a refusal (`too_large`, `not_viewable`,
  `not_found`); the route is `/download` with a ticket of kind `view`: the
  same guarded fetch and checks, the same headers plus `Cache-Control:
  no-store`; the body is sniffed on the server: PDF (`%PDF-`), PNG, JPEG,
  GIF, WebP (`RIFF…WEBP`), AVIF (`ftypavif`), BMP, SVG (text starting,
  after an optional BOM and XML declaration, with `<svg`), text (valid UTF-8
  or the part's charset, no NUL in the first 8 KB). A sniffed kind that
  differs from the stored kind answers `409 not_viewable`. Size caps: images
  20 MB, PDF 25 MB, text 2 MB shown (longer text is cut with "Showing the
  first 2 MB · Download").
- **Page side.** `fetch(url)` → `Blob` with the type the server decided →
  `URL.createObjectURL`, revoked when the viewer closes. The page never
  navigates to it, never opens it in a new window and never passes it to
  `openUrl`.
  - Image: `<img src=blob:>` in the sheet (or BB's
    `experimental_ImageLightbox` when present), `referrerPolicy="no-referrer"`,
    `decoding="async"`. SVG appears only this way, where SVG cannot run
    scripts or load resources.
  - Text: `experimental_SourceCode({ content, path: filename })` when the
    host provides it, else a `<pre>`; never `innerHTML`. HTML attachments are
    text kind `other` → shown as source text only on **View source**.
  - PDF: `pdf-view.tsx` loads `pdfjs-dist` lazily (a separate chunk, only
    when a PDF is opened) with `getDocument({ data, isEvalSupported: false,
    disableAutoFetch: true, disableStream: true, enableXfa: false })`,
    renders visible pages to `<canvas>` (`annotationMode: DISABLE`), keeps at
    most 5 rendered pages, max zoom 400 %, 500 pages. Links: `getAnnotations()`
    of each page, `Link` annotations with an `http(s)`/`mailto` URL only,
    listed under the viewer by real URL, opened through the existing
    `openLink` (BB's browser preference). Outline, attachments inside the
    PDF, JavaScript actions, forms and XFA are ignored. The worker is loaded
    from a bundled module through a `blob:` URL; when the page cannot start a
    worker **[unverified]**, pdf.js runs on the main thread with the page cap
    lowered to 100.
- **Print document frames** (#89) and the existing HTML mail frame are the
  only iframes; the viewer has none.

### Files view (#85) (`src/ui/files-view.tsx`, new)

- `files_list({ kind?, sender?, accountId?, name?, cursor, limit ≤ 100 })`
  → `{ files: { messageId, partId, filename, kind, mimeType, size, date,
  from, accountId, threadId }[], nextCursor }`; non-inline attachments of
  rows not `move_pending`, deduplicated by `(dedup key, part_id)`, keyset
  by `(date DESC, message seq DESC, part_id)`. Spam and Trash left out
  unless the Type filter's **Include Spam and Trash** is ticked.
- Rail **Files** (`g f`, subPath `files`); the sender card links to it
  filtered by the sender.
- Only the stored metadata; a row outside the window appears once its
  message is loaded (history or server search).

### Thread management (#54)

- **Quotes, plain text:** the body is split by `quoteRanges(text)`
  (`src/core/quotes.ts`, new, built from `stripQuoted`'s rules plus
  Outlook's "-----Original Message-----" and "From: … Sent: …" header
  blocks); hidden ranges render as one "··· Show quoted text" button.
- **Quotes, HTML:** the sanitizer marks `blockquote[type=cite]`,
  `div.gmail_quote`, `.yahoo_quoted`, `#divRplyFwdMsg` and its following
  siblings, `#appendonsend` and following siblings, `blockquote` directly
  after an attribution line, with `data-mk-quote`; the frame's base style
  hides `[data-mk-quote]` unless `<html data-mk-quotes="shown">`; the parent
  toggles that attribute through `contentDocument` (allowed by
  `allow-same-origin`; no script in the frame). Nothing is hidden when the
  whole body would be (a forwarded message).
- **Expand all / Collapse all** in the conversation header (`;` toggles).
- **Group by conversation** per folder (`folder_prefs.grouping`, default
  on). Off: `messages_list({ scope, cursor, limit, filter })` (new store
  method `listMessages`, keyset `(date DESC, seq DESC)`, one row per
  deduplicated message in the folder) and the reading pane shows that
  message alone with **Show conversation**. All accounts role views keep
  their own preference in a `folder_prefs` row with `account_id = '*'` and
  the role name as `path`.

### Plain text and dark mail (#62)

- **Plain text:** `Show plain text` renders `body_text` (or, when absent,
  text derived from the sanitized HTML: block elements → line breaks, links
  as `text <url>`) in the plain-text view, with quotes per #54. Setting
  `mailView`: `original` (default) \| `plain`.
- **Dark:** when `experimental_useCodeTheme().mode === "dark"` and setting
  `darkMail` is `adapt` (default), `sanitizeEmailHtml` gets `{ dark: true }`
  and the document's base style becomes `:root { color-scheme: dark; }`
  plus, unless the message declares dark support (a `color-scheme` meta or
  style containing `dark`, or a `prefers-color-scheme: dark` media query in
  its styles), `html { filter: invert(0.9) hue-rotate(180deg);
  background: #fff }` with `img, video, picture, [style*="background-image"]
  { filter: invert(1) hue-rotate(180deg) }` re-inverting media. **Original
  colors** per message re-renders with `dark: false`. Plain-text bodies
  already use BB's tokens. The frame's CSP and sandbox are unchanged.

### Sender card (#86) (`src/ui/sender-card.tsx`, new)

- `sender_card({ address, accountId | null })` → `{ name, address,
  fromCount, toCount, firstDate, lastDate, conversations: ThreadSummary[] ≤
  10, files: FileRow[] ≤ 5, imagesAllowed, blocked, projectId | null }`.
  Counts by dedup key across folders (not Spam/Trash), served by the new
  `messages_from` index for From and a bounded `LIKE` on `to_json`/`cc_json`
  over the newest 5 000 rows for To (noted "in recent mail" when capped).
- Actions reuse 3a/3e/3g RPCs: **Search from this sender** (`from:`),
  **Always show images**, **Block…**, **Bind to a project…**, **Files** (the
  Files view filtered).
- Opens from the sender name in the reading pane and in list rows
  (`Shift+click` keeps today's behaviour).

### Print and save as PDF (#89) (`src/ui/print.ts`, new)

- `printDocument(messages, { remoteImages })` builds one HTML document: for
  each message a header table (From, To, Cc, Date, Subject — text nodes,
  escaped) and the body — HTML through `sanitizeEmailHtml` (light colors
  always, quotes shown), plain text in `<pre>`. The same CSP meta as mail
  (`default-src 'none'`, images `data:`/`cid:` and `https:` only when
  allowed), `@page { margin: 16mm }`, no Mail UI.
- A hidden `<iframe sandbox="allow-same-origin allow-modals">` (no
  `allow-scripts`; `allow-modals` is what lets `print()` run in a sandboxed
  frame) gets the document as `srcDoc`; on load the parent calls
  `frame.contentWindow.print()` and removes the frame after `afterprint` (or
  60 s).
- **Save printable page:** shown when `print` is missing or throws
  **[unverified]** for BB's iOS app: `experimental_saveFile({ fileName,
  blob })` with the same document (`text/html`), named `YYYY-MM-DD
  Subject.html` through `sanitizeFileName`.

### Data model and migration

Migration element **13** is appended to `MIGRATIONS`. Elements 0–12 are
frozen; the pin becomes `MIGRATIONS.slice(0, 14)` in the docs task (element
12's SHA is added if 3g's close-out has not added it). No `REFERENCES`;
deletes are explicit and every path that deletes a message also deletes its
`attachment_text` rows. Timestamps ISO TEXT.

```sql
-- older mail and server hits outside the window (#34, #35)
ALTER TABLE sync_state ADD COLUMN history_since TEXT;   -- NULL = window only
ALTER TABLE messages ADD COLUMN kept TEXT;               -- NULL | history | search | opened
ALTER TABLE messages ADD COLUMN kept_at TEXT;
CREATE INDEX messages_kept ON messages(kept, kept_at) WHERE kept IS NOT NULL;

-- Gmail labels (#79): JSON array as the server sent it; NULL = not fetched
ALTER TABLE messages ADD COLUMN gm_labels TEXT;

-- sender card (#86)
CREATE INDEX messages_from ON messages(from_address COLLATE NOCASE, date);

-- attachment kinds (#50, #85); new rows get the kind from fileKindOf
ALTER TABLE attachments ADD COLUMN kind TEXT NOT NULL DEFAULT 'other';
UPDATE attachments SET kind = CASE
  WHEN lower(mime_type) = 'application/pdf' OR lower(filename) LIKE '%.pdf' THEN 'pdf'
  WHEN lower(mime_type) LIKE 'image/%' THEN 'image'
  WHEN lower(mime_type) = 'text/calendar' OR lower(filename) LIKE '%.ics' THEN 'calendar'
  WHEN lower(mime_type) LIKE 'text/%' OR lower(mime_type) IN
    ('application/json', 'application/xml', 'application/x-patch', 'application/x-diff') THEN 'text'
  WHEN lower(mime_type) IN ('application/zip', 'application/gzip', 'application/x-7z-compressed',
    'application/x-rar-compressed', 'application/vnd.rar', 'application/x-tar') THEN 'archive'
  WHEN lower(mime_type) LIKE 'application/vnd.openxmlformats-officedocument.%'
    OR lower(mime_type) LIKE 'application/vnd.oasis.opendocument.%'
    OR lower(mime_type) IN ('application/msword', 'application/vnd.ms-excel',
      'application/vnd.ms-powerpoint', 'application/rtf') THEN 'document'
  ELSE 'other' END;
CREATE INDEX attachments_kind ON attachments(kind);

-- attachment text (#84)
CREATE TABLE attachment_text (
  seq INTEGER PRIMARY KEY,
  message_id TEXT NOT NULL,
  part_id TEXT NOT NULL,
  state TEXT NOT NULL,            -- indexed | skipped | failed
  reason TEXT,                    -- too_large | unsupported | encrypted | timeout | unreadable
  body TEXT,                      -- ≤ 200 000 characters; NULL unless indexed
  extracted_at TEXT NOT NULL,
  UNIQUE (message_id, part_id)
);
CREATE VIRTUAL TABLE attachment_text_fts USING fts5(
  body, content='attachment_text', content_rowid='seq', tokenize='trigram'
);
CREATE TRIGGER attachment_text_ai AFTER INSERT ON attachment_text BEGIN
  INSERT INTO attachment_text_fts(rowid, body) VALUES (new.seq, new.body);
END;
CREATE TRIGGER attachment_text_ad AFTER DELETE ON attachment_text BEGIN
  INSERT INTO attachment_text_fts(attachment_text_fts, rowid, body) VALUES ('delete', old.seq, old.body);
END;
CREATE TRIGGER attachment_text_au AFTER UPDATE OF body ON attachment_text BEGIN
  INSERT INTO attachment_text_fts(attachment_text_fts, rowid, body) VALUES ('delete', old.seq, old.body);
  INSERT INTO attachment_text_fts(rowid, body) VALUES (new.seq, new.body);
END;

-- saved searches (#63)
CREATE TABLE saved_searches (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  query TEXT NOT NULL,
  account_id TEXT,                -- NULL = all accounts
  position INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- per-folder list preference (#54); account_id '*' = an All accounts role view
CREATE TABLE folder_prefs (
  account_id TEXT NOT NULL,
  path TEXT NOT NULL,
  grouping INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (account_id, path)
);
```

Folder subscription (#49) is one more column of `folders` in the same
element, filled by `saveFolders` from the listing:

```sql
ALTER TABLE folders ADD COLUMN subscribed INTEGER NOT NULL DEFAULT 1;
```

Account removal deletes `saved_searches` and `folder_prefs` of the account
and `attachment_text` of its messages in the existing account-delete
transaction.

### RPC contract (`src/core/contract.ts`)

All owner RPCs (3b resolution 1), refusing plugin callers
(`refusePluginCaller`). No output key contains `pass`, `secret`, `seal` or
`key`.

| Method | Input | Output |
| --- | --- | --- |
| `search` (changed) | `{ query, accountId, limit, cursor? }` | `{ hits, nextCursor, notes: { kind, token }[], attachmentMatches: { messageId, filename, excerpt }[] }` |
| `server_search_start` | `{ query, accountId \| null }` | `{ jobId }` or refusal `nothing_to_search` |
| `server_search_more` | `{ jobId }` | `{ ok }` |
| `history_load` | `{ accountId, folder }` | `{ jobId }` |
| `conversation_load` | `{ threadId }` | `{ jobId }` |
| `server_job_poll` | `{ jobId }` | `{ state: running \| done \| failed \| cancelled, accounts: { accountId, searched, total, fetched, found, partial, reason? }[], messageIds, moreAvailable, historySince? }` |
| `server_job_cancel` | `{ jobId }` | `{ ok }` |
| `history_forget_check` / `history_forget` | `{ accountId, folder }` | `{ count }` / `{ removed }` |
| `saved_searches_list` | `{}` | `{ searches: { id, name, query, accountId, unread, capped }[] }` |
| `saved_search_save` | `{ id?, name, query, accountId }` | `{ id }` |
| `saved_search_delete` / `saved_search_move` | `{ id }` / `{ id, position }` | `{ ok }` |
| `folder_create` | `{ accountId, parent \| null, name }` | `{ path }` |
| `folder_rename` | `{ accountId, path, name }` | `{ path }` |
| `folder_delete_check` | `{ accountId, path }` | `{ messages, children, refusal? }` |
| `folder_delete` | `{ accountId, path, moveToTrash, expectedMessages }` | `{ ok, moved }` |
| `folder_subscribe` | `{ accountId, path, subscribed }` | `{ ok }` |
| `folder_prefs_set` | `{ accountId \| '*', path, grouping }` | `{ ok }` |
| `messages_list` | as `threads_list` | `{ messages: MessageSummary[], nextCursor }` |
| `labels_list` | `{ accountId }` | `{ labels: { name, path \| null }[] }` |
| `labels_change` | `{ messageIds ≤ 200, add ≤ 20, remove ≤ 20, undoId? }` | `{ changed }` |
| `attachment_view_ticket` | `{ messageId, partId }` | `{ url, kind, mimeType, size }` or refusal |
| `files_list` | `{ kind?, sender?, accountId?, name?, includeJunk?, cursor, limit }` | `{ files, nextCursor }` |
| `attachment_text_status` | `{}` | `{ indexed, skipped, failed, pending, running }` |
| `attachment_text_retry` / `attachment_text_clear` | `{}` | `{ ok }` |
| `related_messages` | `{ messageId }` | `{ hits: { summary, reasons }[] }` |
| `sender_card` | `{ address, accountId \| null }` | see "Sender card" |

The shell limit (3c accepted limit) now names the new server writes:
`folder_create`, `folder_rename`, `folder_delete`, `folder_subscribe`,
`labels_change`, and the fetching RPCs `server_search_start`,
`history_load`, `conversation_load`.

### UI (summary)

- **Search header** (`mail-page.tsx`): operator notes, help popover
  (`search-help.tsx`), **Save search**, **Search on the server** with the
  per-account progress strip (`server-search-strip.tsx`), "from the server"
  marks, attachment-match excerpts.
- **Rail** (`folder-list.tsx`, `mail-sidebar.tsx`): **Saved** section,
  **Files** (`g f`), folder and account menus (new, rename, subscribed,
  delete, group by conversation, forget older mail), **More folders**
  (unsubscribed), drop targets.
- **List** (`thread-list.tsx`): draggable rows, label chips, **Load 30 more
  days** at the end of a folder, single-message mode.
- **Reading pane**: quotes hidden, **Expand all / Collapse all**, **Load the
  whole conversation**, **Related (n)**, label chips and **Labels…** (`l`),
  message menu **Show plain text / Show original**, **Original colors**,
  **Print…** (`Shift+P`), attachment click → viewer, sender name → card.
- **Dialogs and sheets**: `folder-dialogs.tsx` (new, rename, delete with the
  move step), `labels-dialog.tsx`, `attachment-viewer.tsx`, `pdf-view.tsx`,
  `sender-card.tsx`, `history-forget-dialog.tsx`.
- **Mail settings**: **Search and history** (history step, keep server hits,
  attachment text switch with status, Retry failed, Remove attachment text),
  **Reading** (show mail as, dark mail, hide quoted text).
- Shortcuts: `g f`, `l`, `;`, `Shift+P` — **[unverified]** that they are free
  in BB's global map; `shortcuts.ts` has none of them.

### Settings added

| Key | Type | Default | Label |
| --- | --- | --- | --- |
| `historyStepDays` | number 7–365 | 30 | Days loaded by "Load more days" |
| `serverSearchKeepDays` | number 1–90 | 14 | Keep unopened server search results (days) |
| `indexAttachmentText` | boolean | false | Search inside attachments (text and PDF, on this computer) |
| `mailView` | `original` \| `plain` | `original` | Show mail as |
| `darkMail` | `adapt` \| `original` | `adapt` | Mail in dark mode |
| `hideQuotes` | boolean | true | Hide quoted text in replies |

### Security and privacy

- **Server search and history** use read-only sessions (`EXAMINE`) and
  `BODY.PEEK` only; nothing is marked read. The search words go to the
  owner's own mail server (README says so). Agents cannot start them.
  Fetched rows pass the same parsing, caps and sanitizing as synced mail and
  are subject to the AI scope like any row.
- **Folder operations** never expunge: fresh connection, nothing selected
  (so imapflow's `CLOSE`-before-`DELETE`/`RENAME` path never runs), `DELETE`
  only after `STATUS messages = 0` on the same connection, emptying only by
  `MOVE`. System folders refused. Residual risk: a message delivered to the
  folder between `STATUS` and `DELETE` on a non-Gmail server would be lost
  with the folder; the window is one round trip, and README states it.
- **Labels** change by `STORE X-GM-LABELS` only, undoable; no copy, move or
  expunge.
- **Attachment viewer**: server-side type sniffing, size caps, `nosniff`,
  `default-src 'none'`, single-use tickets; page-side `Blob` never navigated
  to; images and SVG only in `<img>`; text as text; HTML never rendered;
  PDF through pdf.js without eval, scripting, forms, XFA, annotations or
  network; links only listed and opened by click. pdf.js is pinned exactly;
  a pdf.js advisory is handled like a dependency advisory (decision 11).
- **Attachment text**: off by default; extraction on this machine; bounded
  per file and per round; the index is never consulted by agent paths and
  never handed to BB (3g's `bb-text.ts` does not read it).
- **Related mail and operators**: local SQL only.
- **Drag**: only Mail's own drag type with the page's id; a drop from
  another page, plugin or app does nothing.
- **Print**: sandboxed frame without scripts; the same sanitizer and CSP;
  remote images only when already allowed.
- **Dark mail**: CSS inside the existing sandbox; the CSP is unchanged.
- **Logs and realtime**: counts, job ids and outcome codes; no queries,
  folder or label names, file names or excerpts. Realtime ticks carry tokens
  as before.
- **Dependency**: `pdfjs-dist` 6.5.438, exact, Apache-2.0; the build keeps
  its license header; the optional `@napi-rs/canvas` is never imported (the
  builder checks the bundle does not contain it).

## Testing

Core with fakes, the store on real SQLite, adapters with fakes of the
gateway and imapflow, UI with Testing Library and jsdom, as before. Fixtures
use made-up text and addresses on `example.com` / `example.org`; PDF
fixtures are generated in the test from a minimal hand-written PDF (no
third-party documents).

- **Operators** (`search.test.ts`): each operator, quoting, negation,
  repeated `in:` / `account:` OR, relative dates against a fixed clock,
  sizes, bad values and notes, unknown operators kept as text, Unicode
  spaces; compatibility of the old fields.
- **Store search** (`sqlite-store.test.ts`): every condition's SQL against
  rows, `in:trash` finding a Trash copy, `filename:` extension matching,
  labels for Gmail and folder names for others, paging cursor, attachment
  text hits and excerpts, scoped searches never using attachment text; a
  timing test at 20 000 messages for a page of `search`, `files_list`,
  `sender_card`, `related_messages` and `messages_list`.
- **Server search plan** (`server-search.test.ts`): Gmail raw strings
  (escaping of `"`, control characters, negations, roles), IMAP criteria,
  folder choice and the 30 cap, local-only operators dropped with notes,
  refusals.
- **Server search jobs** (`server-search-jobs.test.ts`): read-only sessions
  only (the fake refuses writes), 50-hit batches, dedup against stored rows,
  cancel between folders, budget expiry, `SearchFailed` and
  `SearchCharsetRefused`, `kept` values, the 14-day expiry and the
  promotions to `opened` and `history`.
- **History** (`history.test.ts`, `sync.test.ts`): step boundaries,
  500 cap and continuation, empty steps, conversation load (Gmail thread id
  and header searches), reconcile over `history_since`, UIDVALIDITY reset,
  forget.
- **Folder ops** (`folder-ops.test.ts`, `imapflow-gateway.test.ts`): name
  rules, every refusal, rename re-homing with the schema scan, delete only
  at `messages = 0`, the move-then-delete path with a count that changes
  midway, no command ever issued with a mailbox selected (the fake records
  `SELECT`/`EXAMINE` state at `DELETE`/`RENAME`), subscription mapping.
- **Labels** (`labels.test.ts`): parsing, system labels hidden and refused,
  `useLabels` STORE calls, undo inverse, rows without an All Mail copy.
- **Drag** (`drag-move.test.ts`): payload shape, foreign types and page ids
  ignored, role targets, the 200 cap.
- **Viewer** (`attachment-viewer.test.tsx`, server route tests): sniffing
  table (each kind, mismatches, SVG with a script stays `<img>`-only, HTML
  refused), caps, blob revocation, no navigation; PDF view with a fake
  pdf.js module asserting the options (`isEvalSupported: false`, no
  annotation layer) and link listing filtered to http(s)/mailto.
- **Attachment text** (`attachment-text.test.ts`, `pdf-text.test.ts`):
  charsets, caps, page and time limits, encrypted and broken PDFs, round
  and daily budgets, failure rows, retry, clear.
- **Related** (`related.test.ts`): term choice (English and Russian stop
  words, ticket tokens), scoring and reasons, bounds.
- **Reading** (`quotes.test.ts`, `sanitize.test.ts`, `message-frame` tests):
  quote ranges, HTML quote marking and the toggle, nothing hidden when all
  would be, dark style only when BB is dark and the message has no dark
  styles, the CSP unchanged.
- **Print** (`print.test.ts`): document content escaped, sandbox attribute
  exactly `allow-same-origin allow-modals`, the fallback download.
- **Contract** (`contract.test.ts`): the new schemas, the credential-key
  walker, plugin callers refused for every new method.
- **Migration**: element 13 on a copy of an element-12 database, the backfill
  of `attachments.kind`, the FTS triggers, the SHA pin for 0–13.

### Live verification (owner's accounts and BB, after the build)

1. Operators on the owner's mail: `to:`, `has:attachment`, `in:`,
   `larger:`, `newer_than:`, negation.
2. Server search on Gmail and on iCloud: a message older than the window is
   found, fetched, opened; Cancel works; nothing marked read.
3. **Load 30 more days** on a folder and **Load the whole conversation**;
   **Forget older mail**.
4. Saved search in the rail with a count.
5. Folder create, rename (with a subfolder), subscribe toggle, delete empty;
   delete non-empty through Trash on a test folder holding test messages
   sent to self.
6. Drag a conversation to a folder; Undo.
7. Gmail labels: chips, add, remove, Undo; a new label.
8. Viewer: an image, a text file, a PDF with a link; a renamed `.exe` shown
   as not viewable.
9. Files view filters; attachment text search on a PDF with the setting on.
10. Quotes hidden, plain text, dark mail in BB's dark mode.
11. Sender card; Related mail.
12. Print and Save as PDF on macOS; the fallback where print is missing.

## Tasks

Each task ends with `npm run check`. The last also runs `npm run build` and
`node ../../scripts/check-manifests.mjs`. Paths are under `plugins/mail/`.

1. **Core: operators and kinds.** `search.ts` (conditions, notes, relative
   dates), `file-kinds.ts`, `quotes.ts`, `related.ts` term choice,
   `labels.ts` parsing, `folder-ops.ts` name and refusal rules (+ tests).
2. **Store and migration 13.** Columns, tables, FTS, backfill; search over
   conditions with paging and attachment matches; `listMessages`;
   `files_list`; sender card queries; related candidates; saved searches;
   folder prefs; rename re-homing with the schema scan; `kept` expiry,
   promotions and forget; explicit deletes of `attachment_text` (+ tests).
3. **Gateway.** `searchServer`, labels fetch and STORE, `renameFolder`,
   `folderStatus`, `deleteFolder`, `setSubscribed`, `subscribed` in
   `listFolders` (+ tests with imapflow fakes).
4. **Server search and history jobs.** Plan, jobs, polling, cancel,
   reconcile over `history_since`, conversation load, day-clock expiry
   (+ tests).
5. **Attachment text.** Indexer, text decoding, `pdf-text.ts` with the pinned
   pdf.js (only after the owner accepts decision 11) (+ tests).
6. **Server RPCs.** Every method in the table, the view ticket and sniffing
   on `/download`, folder operations through the write queue, labels with
   undo, settings (+ tests).
7. **UI: search, rail, list.** Notes and help, save search, server-search
   strip, Saved and Files views, folder dialogs and menus, drag and drop,
   label chips and dialog, Load more days, single-message mode (+ tests).
8. **UI: reading.** Viewer and PDF view, quotes, expand/collapse, plain text,
   dark mail, sender card, related, print (+ tests).
9. **Docs and listing.** `README.md` and `PLUGIN_OVERVIEW.md` (what goes to
   the mail server, the new server writes and their limits, the folder
   delete residual risk, attachment text opt-in, the viewer's file types,
   the shell limit with the new RPCs), `package.json` `bb.description`, root
   `marketplace.json`, `skills/mail/SKILL.md` (new operators for
   `mail_search`; no server search for agents), `CHANGELOG.md`,
   `docs/mail-feature-backlog.md` labels for 34, 35, 43, 49, 50, 54, 62, 63,
   79, 84, 85, 86, 88, 89 (`[уже есть]`), 83 (`[позже]`, "связанные письма
   — локально, срез 3h"), 74 and 76 (`[кандидат]`, "срез 3j") and the
   header's date line; the SHA pin for elements 12–13; `package-lock.json`
   with `pdfjs-dist` 6.5.438 exact. `THIRD_PARTY_NOTICES.md` changes only
   if code is ported (none planned; `search.ts` keeps its Velo header). Run
   `check-manifests`, `npm run check` and `npm run build`; record the bundle
   size before and after pdf.js.

## Calls made by me (not the owner)

- Server search on Gmail goes through All Mail with `X-GM-RAW`; others over
  a capped folder list; local-only operators are dropped with a note.
- Hits are fetched into the store (not shown transiently), so reading,
  threading and actions need no second code path.
- `kept` states `history`, `search`, `opened`; expiry by the day clock;
  history reconciled by flags only.
- History steps by date with a 500-message cap; conversation loads by Gmail
  thread id or header searches.
- Operators: Gmail names, `-` negation, OR only for `in:` and `account:`.
- Folder ops on fresh connections; rename re-homes every stored path, with a
  schema-scan test; delete via `STATUS` then `DELETE`; non-empty via 3a
  moves, not undoable.
- Subscription shown and set, but does not change what Mail syncs.
- Labels on the All Mail copy; system labels hidden.
- Viewer bytes through the existing ticket route with a `view` kind and
  server-side sniffing; BB's file preview not used.
- PDF text extraction in the plugin server without a worker thread,
  page- and time-bounded.
- Related mail by terms, participants and references; no model.
- Dark mail by CSS inversion with media re-inverted; skipped for messages
  that declare dark styles.
- Print through a sandboxed `allow-modals` frame; HTML download fallback.
- Keys `g f`, `l`, `;`, `Shift+P`.

## Open questions for the owner

1. **pdf.js.** Add `pdfjs-dist` 6.5.438 (proposed), or keep PDFs
   download-only and #84 text-only? *Recommendation:* add it; it is the only
   way to read a PDF inside Mail without writing it to disk.
2. **Server-hit lifetime.** 14 days unopened (proposed), keep forever, or
   drop when the search is closed? *Recommendation:* 14 days.
3. **Non-empty folder delete.** Offer **Move to Trash, then delete**
   (proposed) or refuse non-empty folders entirely? *Recommendation:* offer
   it; the messages stay recoverable in Trash.
4. **Attachment text default.** Off (proposed) or on? *Recommendation:* off;
   it downloads attachments the owner never opened.
5. **Hide quoted text by default.** On (proposed) or off?
   *Recommendation:* on, with the per-message toggle.
6. **Dark mail default.** Adapt colors (proposed) or original?
   *Recommendation:* adapt; original is one click per message.
7. **#74 and #76 to 3j.** Agree (proposed), or keep them here?
   *Recommendation:* 3j.
8. **Semantic search.** Accept "Related mail" as the local substitute and
   keep #83 `[позже]` (proposed)? *Recommendation:* yes, until BB offers a
   local embedding service.

## Not verified

- That BB's plugin page allows `blob:` images, a `blob:` module worker and
  `fetch` of the plugin's own HTTP route returning bytes (the page's CSP is
  not in the SDK). Live step 8.
- pdf.js bundle size after `bb plugin build` and whether the build pulls in
  `@napi-rs/canvas`; that the plugin server's Node version meets pdf.js's
  `>=22.13` engine (`package.json` engines of pdfjs-dist 6.5.438).
- That `window.print()` from a sandboxed `allow-modals` frame opens the
  system dialog in BB desktop, and what BB's iOS app does. Live step 12.
- That `experimental_useCodeTheme().mode` follows BB's app light/dark (the
  SDK says "palette or light/dark").
- That `experimental_ImageLightbox` accepts a `blob:` `imageSrc`.
- iCloud's support for `SEARCH CHARSET UTF-8`, `TEXT` search speed on large
  folders, and whether iCloud keeps UIDVALIDITY on `RENAME`. Live steps 2
  and 5.
- Gmail's `X-GM-RAW` behaviour for every operator mapping (e.g. `filename:`
  with spaces). Live step 2.
- `ListResponse.subscribed` on iCloud and Gmail (imapflow assumes subscribed
  when the server reports nothing).
- That `g f`, `l`, `;` and `Shift+P` do not collide with BB's global
  shortcuts.
- Performance of the 20 000-message timing tests on the owner's machine
  (CI-like bounds as in 3f resolution 19).
