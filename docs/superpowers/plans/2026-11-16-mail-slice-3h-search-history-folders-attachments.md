# Makosh Mail — Slice 3h (server search, older mail, operators, saved searches, attachment text, related mail, folder management, drag to folders, Gmail labels, attachment viewer, Files view, thread management, plain text and dark mail, sender card, print) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** Search reaches past the sync window. The owner can search their own mail server on a click, load older mail per folder or per conversation, use Gmail-style operators with negation, keep saved searches in the rail and, if they opt in, search inside text and PDF attachments locally. Related mail is ranked locally. Folders can be created, renamed, deleted (never by expunge) and subscribed. Conversations can be dragged onto folders, and Gmail labels show as chips and can be set. Attachments open in Mail's own isolated viewer (images, text, PDF through pdf.js), and a Files view lists every attachment. Quoted text is hidden, mail can be read as plain text or in adapted dark colors, a sender card opens, and messages print or save as PDF. Nothing goes to an AI provider. The only new server writes are folder `CREATE` / `RENAME` / `DELETE` / `SUBSCRIBE` / `UNSUBSCRIBE`, `STORE X-GM-LABELS`, and 3a moves.

**Architecture:** Same layers. New pure core modules: `search.ts` (conditions, notes, relative dates), `file-kinds.ts`, `quotes.ts`, `related.ts` (terms, scoring), `labels.ts`, `folder-ops.ts` (name and refusal rules), `server-search.ts` (`planServerSearch`), `history.ts`, `saved-searches.ts`, `attachment-text.ts` (decoding, caps). `sync.ts` exports `prepareMessage` and gains `historyCheck`. New adapters: `src/adapters/bb/server-search-jobs.ts`, `attachment-indexer.ts`, `pdf-text.ts` (a `worker_threads` worker) and `pdf-page.ts` (the page-side `PdfEngine` over `pdfjs-dist`, imported only by `app.tsx`). The gateway gains `searchServer`, label fetch and STORE, `renameFolder`, `folderStatus`, `deleteFolder`, `setSubscribed`, `subscribed` in the listing, and `namedLikeSpecialUse`. One migration element (13). The UI gets new views and dialogs, and host components and pdf.js reach it only as injected props.

**Spec:** `docs/superpowers/specs/2026-11-16-mail-slice-3h-search-history-folders-attachments-design.md`. Its "Resolutions after the builder check" (1–23) override every section above them. The owner accepted every decision on 2026-11-16, including 11, 12, 13 and 18 and `pdfjs-dist` 6.5.438 as a new dependency. The slice 1, slice 2 and 3a–3g specs, with their resolutions, still hold where 3h does not change them.

## Global Constraints

- Slice-1, slice-2 and 3a–3g global constraints still bind (see the earlier plans in `docs/superpowers/plans/`, last `2026-11-16-mail-slice-3g-bb-integration.md`).
- **Nothing is ever expunged** except 3b's `expungeOwn` of the plugin's own drafts. There are three folder rules:
  - Folder `DELETE` and `RENAME` run on a fresh connection with no mailbox selected, so imapflow's `CLOSE`-before-`DELETE`/`RENAME` path (`commands/delete.js`, `commands/rename.js`) never runs.
  - A non-Gmail delete happens only at `STATUS messages = 0` on the same connection. Emptying a folder goes only through 3a's `MOVE`.
  - Gmail label folders are deleted by a plain `DELETE` (spec resolution 5).
- **Every server read is read-only and `BODY.PEEK`.** Server search, history and conversation jobs use `EXAMINE` sessions. Jobs skip folders with no `sync_state` or a different UIDVALIDITY, and never insert uids above `last_uid` (spec resolution 6).
- **Nothing reaches an AI provider and there is no new HTTP request.** Printing loads no remote image (spec resolution 19). pdf.js gets bytes only: no `cMapUrl`, `standardFontDataUrl`, `wasmUrl` or URL loading.
- **Attachment text is owner-only.** It is joined only when the guarded page `search` RPC passes `attachments: true` (spec resolution 4). It is never joined for the CLI, `mail_search`, agent tools or plugin callers, and never by `bb-text.ts`.
- **pdf.js never runs on BB's main thread or the plugin server's thread.**
  - On the server it runs in a `worker_threads` worker with `resourceLimits`, a 20 s timer and `terminate()` (spec resolution 1).
  - On the page it runs in a `blob:` worker. If that worker cannot start, PDFs are download-only (spec resolution 2).
- **No query, folder name, label name, file name or excerpt** goes into the plugin log, the agent log, realtime or error text. These carry counts, job ids and outcome codes only.
- Every 3h RPC is owner-only (`refusePluginCaller`, `server.ts` 739), and `search` gains it too. Output keys never match `/pass|secret|seal|key/i` (`contract.test.ts` walker).
- **Migrations:** `MIGRATIONS` (`src/adapters/bb/sqlite-store.ts` 140) is append-only and SHA-pinned in `sqlite-store.test.ts` ("shipped migration elements are unchanged", 755–778).
  - Elements 0–11 are pinned (`MIGRATIONS.slice(0, 12)`), and element 12 (3g review) exists unpinned.
  - 3h appends element 13 only and never edits or reformats an earlier element.
  - Task 12 pins elements 12 and 13 (`MIGRATIONS.slice(0, 14)`).
  - New tables keep ISO TEXT timestamps and carry no `REFERENCES` clause. Deletes are explicit, and every path that deletes a message row also deletes its `attachment_text` rows.
- `src/core` and `src/ui` stay host-free, and `tests/architecture.test.ts` is unchanged. `src/ui` may import only React, DOMPurify, the four TipTap packages and the design system. Inject these from `app.tsx` as props: `pdfjs-dist` (through `src/adapters/bb/pdf-page.ts`), `experimental_SourceCode` (`HostSourceCode`), `experimental_ImageLightbox`, `experimental_saveFile`, and `experimental_useCodeTheme().mode` (as `dark`).
- One new dependency: `pdfjs-dist` **6.5.438, exact** (Task 0).
  - Its optional `@napi-rs/canvas` may land in `node_modules` and the lockfile. Mail never imports it, and `dist/` must not contain it (spec resolution 21).
  - The root `THIRD_PARTY_NOTICES.md` gets a pdf.js entry in the same commit as the dependency.
- Tests sit next to the code (`*.test.ts(x)`).
  - Fixtures use made-up addresses on `example.com` / `example.org` and made-up text. PDF fixtures are minimal hand-written PDFs built in the test.
  - Store tests run on real SQLite, and adapters use fakes of the gateway and imapflow. Server tests use `createFakePluginHost` / `createFakeSdk` overrides that record their arguments.
  - Timing tests time one call (one page) with a generous bound and never time the seeding.
- Every task leaves `npm run check` green (in `plugins/mail`). It is committed on `feat/mail-imap-slice` with a message prefixed `feat(mail): 3h —` (docs: `docs(mail): 3h —`) and the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
  - `git add` only the task's own files by explicit path. The tree holds unrelated uncommitted changes (prompt-shaper, taskboard, telegram, `marketplace.json`), and other sessions commit here.
  - Never push, tag or publish. Never touch the installed plugin, `.worktrees/live`, or another plugin.

## Recurring pitfalls (read before every task)

- **`tests/architecture.test.ts`** forbids host imports in `src/core` and `src/ui`. Its `IMPORT_SPECIFIER` regex also matches `from "…"`, `import "…"`, `import("…")` and `require("…")` **inside string literals and comments**. Do not write example import lines in strings or comments in those directories. Never add packages to `ui.packages`. Add a port and inject an adapter instead.
- **No credential-shaped literals in tests.** Build made-up secrets from pieces at run time (3f review resolution 5), including in redaction and search tests.
- **Contract output keys** must not match `/pass|secret|seal|key/i`. Watch `dedupKey`-like names, `keptAt` is fine, `sortKey` is not. The walker in `contract.test.ts` checks every new output schema.
- **Keep `\u` escapes.** Tool-written files sometimes turn `\u200e`, `\u00a0` and similar escapes into raw characters. Write them as escapes (tokenizer Unicode spaces, `normalizeName`-style marks, stop-word lists) and check the diff for invisible characters.
- **Timing tests use generous bounds** and time one call, never the seeding (3f resolution 19). 20 000-row seeds go in one transaction.
- **Migration pins:** never touch elements 0–12. A migration test that builds an old database runs `MIGRATIONS.slice(0, 13)` and then `slice(13)`, like the existing tests at 4787–4803.
- **Contract counts:** `Object.keys(rpcSchemas)` has 126 methods today (`contract.test.ts` 1557). Add a `SLICE_3H_METHODS` list. Every "N earlier methods" count (`contract.test.ts` 514–516, 823–825 and the like) must filter it out too.
- **`sync.ts` naming:** the local `kept` map in `syncFolder` / `keptAtReset` is not the new `messages.kept` column. Use `KeptState` for the column.
- **imapflow refusals return `false`** (`search.js` `searchFailed`, `store.js`), so check every boolean answer.

## Review Focus

- **No expunge, ever.** Fake-session tests record `SELECT` / `EXAMINE` state at every `DELETE` / `RENAME` and assert none. A non-Gmail delete happens only at `messages = 0`. Move-then-delete stops when the count changes. Gmail label delete never moves mail. Tasks 5, 9.
- **Jobs cannot hide new mail.** Uids above `last_uid` are skipped, and a UIDVALIDITY mismatch or missing `sync_state` skips the folder. A job-stored Inbox row never removes a message from the next round's `newInbox`. Tasks 2, 7.
- **Attachment text is owner-only.** CLI, agent tool, `mail_search` and plugin caller get no attachment hits. Only `attachments: true` from the page joins the index. Tasks 4, 9.
- **The AI scope survives folder changes.** `folders_json` is rewritten on rename and dropped on delete and on `saveFolders` removal. The schema scan covers it. Tasks 4, 9.
- **Viewer isolation.**
  - The server sniffs every kind, and a mismatch answers `409`. SVG, HTML and anything else are download-only.
  - Blobs are made only with sniffed raster, PDF or text types, revoked on close, and never navigated to.
  - pdf.js options are asserted through a fake engine. Links are listed as `http(s)`/`mailto` only and opened only by click.
  - Tasks 9, 11.
- **pdf.js containment.** The server worker has limits, a timeout and terminate. The page uses a blob worker or download-only, never the main thread. `dist/` has no `@napi-rs/canvas`. Tasks 0, 8, 11, 12.
- **Undo for labels** applies per-message deltas only, and a refused STORE makes no undo record. Tasks 1, 9.
- **No names in logs or realtime:** a canary query, folder name, label name and file name are absent from every recorded log, agent-log row and realtime payload. Tasks 7, 9.

---

### Task 0: pdf.js packaging spike (server worker and page bundle) — gate for #84 PDF and the PDF viewer

**Files:** `plugins/mail/package.json`, `package-lock.json` (`pdfjs-dist` 6.5.438 exact), root `THIRD_PARTY_NOTICES.md`; spike code in a scratch directory outside the repository (the session scratchpad) or a throw-away branch. Only the dependency, the notice and a short result note are committed. The result note goes as a "Task 0 result" section appended to this plan.

**Steps:**

- [ ] `npm install --save-exact pdfjs-dist@6.5.438` in `plugins/mail`. Record whether `@napi-rs/canvas` landed in `node_modules` and the lockfile; that is accepted (spec resolution 21). `npm run check` stays green.
- [ ] **Server worker (spec resolution 1).** Build a minimal `pdf-text` worker that loads `pdfjs-dist/legacy/build/pdf.mjs`, opens a hand-written two-page PDF from bytes with the spec's options and returns `getTextContent()` text. Try these in order and stop at the first that passes:
  - (a) A worker started from code embedded in the server bundle: `new Worker(source, { eval: true })` with a bootstrap that resolves `pdfjs-dist` from the plugin directory through `createRequire(import.meta.url)`. Note that `dist/server.js` already uses `createRequire`, and the installed plugin directory keeps its `node_modules`, as `.worktrees/live/plugins/mail/node_modules` shows.
  - (b) A worker file emitted next to `dist/server.js` by `bb plugin build`, if the build supports more than one server entry.
  - (c) A `data:` / `file:` URL worker built from `pdfjs-dist`'s files at run time.
- [ ] Server pass criteria, all required:
  - `npm run build` succeeds.
  - Running the built code under Node 24 (`node -v` → v24.20.0) extracts the fixture's text inside a worker.
  - A PDF with a 1 GB allocation bomb stand-in (a loop page count or a huge stream) ends with `ERR_WORKER_OUT_OF_MEMORY` or the timeout, and the parent process survives.
  - `terminate()` after 20 s works on a stuck worker.
  - `@napi-rs/canvas` is not loaded: check `process.moduleLoadList` or a resolve hook in the worker. If pdf.js only imports it when `DOMMatrix`/`Path2D` are missing, the worker installs minimal stubs first.
  - `grep -c "napi-rs" dist/server.js` is 0.
- [ ] **Page bundle (spec resolution 2).** In a scratch copy of `app.tsx` wiring, import `pdfjs-dist` (the modern build first, the legacy build if the modern one fails to bundle) through a `pdf-page.ts` adapter and build. Record:
  - whether a dynamic `import()` stays a separate chunk or is inlined into `dist/app.js`;
  - `dist/app.js` size before (878 KB today) and after;
  - whether the pdf.js worker can be embedded as a string or module and started as `new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" })), { type: "module" })` with no network request;
  - that `dist/app.js` holds no `napi-rs`.
- [ ] Page pass criteria:
  - The build succeeds with the worker embedded.
  - In jsdom or a local Chromium page loading `dist/app.js`'s worker blob (no BB), the fixture renders page 1 to a canvas with `isEvalSupported: false` and no request.
  - BB's real CSP cannot be read from the SDK. The viewer therefore always runs a start probe of the worker at run time and falls back to download-only. The live check (Task 13) records the probe result in BB.
- [ ] **Outcome and fallback.**
  - Server pass: Task 8 builds PDF text extraction with the winning method.
  - Server fail: Task 8 builds text attachments only, PDFs get no `attachment_text` row, and the setting and README say "text attachments" (spec resolution 1).
  - Page pass: Task 11 builds `pdf-view.tsx` and `pdf-page.ts` with the winning bundling.
  - Page fail: PDF preview is download-only, `pdf-view.tsx` is not built, and there is no main-thread fallback (spec resolution 2).
  - If both fail, remove `pdfjs-dist` again (`npm uninstall`) and drop the notice. Otherwise keep it.
- [ ] Root `THIRD_PARTY_NOTICES.md`: a `## pdf.js (pdfjs-dist)` entry in the existing format.
  - Source: <https://github.com/mozilla/pdf.js>, npm `pdfjs-dist` 6.5.438.
  - License: Apache-2.0, Copyright Mozilla Foundation.
  - Paths: bundled into `plugins/mail/dist/app.js` (the viewer and its worker) and used by `plugins/mail/dist/server.js` (the text worker), listing only the parts that passed.
  - A note that the optional `@napi-rs/canvas` is not used.
  - Keep pdf.js's license header in the bundle.
- [ ] `npm run check`, `npm run build`, `node ../../scripts/check-manifests.mjs` → commit `package.json`, `package-lock.json`, `THIRD_PARTY_NOTICES.md` and this plan's "Task 0 result" section (`feat(mail): 3h — pdfjs-dist 6.5.438 and packaging spike result`).

### Task 1: Core search operators, kinds, quotes, labels and folder rules (pure)

**Files:**
- `src/core/search.ts` (+ `search.test.ts`), `src/core/model.ts` (`ParsedQuery` gains `conditions`, `notes`).
- New `src/core/file-kinds.ts`, `src/core/quotes.ts`, `src/core/labels.ts`, `src/core/folder-ops.ts` (each + test).
- `src/core/undo.ts` (+ test) adds the `labels` kind.
- `src/core/index.ts` exports.

**Produces:**
- **`search.ts`**
  - `OPERATOR = /^(-?)([a-z][a-z_]*):/i` (spec resolution 12).
  - `parseQuery(raw, now?)` keeps `text`, `from`, `subject`, `unread`, `after`, `before` for existing callers and adds `conditions: SearchCondition[]` and `notes: SearchNote[]`. `SearchCondition` is `{ field, value, negated }`, with `field` in the spec list. `SearchNote` is `{ kind: "unknown_operator" | "bad_value"; token }`.
  - Value rules: sizes, relative dates (`newer_than` / `older_than` → `after` / `before` against `now`), and roles for `in:`. Each value is ≤ 200 characters with control characters removed.
  - `-` negates any operator. A bare `-word` stays text.
- **`file-kinds.ts`**
  - `FileKind = "image" | "pdf" | "text" | "document" | "archive" | "calendar" | "other"` and `fileKindOf(mimeType, filename)`, matching the migration's backfill `CASE`.
  - `isViewable(kind, mimeType)`: image except `image/svg+xml`, pdf, text and calendar (spec resolution 13).
  - `sniffKind(firstBytes: Uint8Array, declared)` → `FileKind | "svg" | "html" | null` (`%PDF-`, PNG, JPEG, GIF, `RIFF…WEBP`, `ftypavif`, `BM`, SVG after BOM/XML declaration, NUL-free UTF-8 text). It is pure, so the server route and the tests share it.
  - `VIEW_CAPS = { image: 20 MB, pdf: 25 MB, textShown: 2 MB }`.
- **`quotes.ts`**: `quoteRanges(text): { start; end }[]`, using `stripQuoted`'s rules (`src/core/ai-input.ts`) plus Outlook's "-----Original Message-----" and "From: … Sent: …" blocks. When the whole text would be hidden, it returns nothing.
- **`labels.ts`**
  - `GMAIL_SYSTEM_LABELS`, `parseGmLabels(json): string[]`, `ownerLabels(labels)`, and `validLabelName(name)` (1–100 characters, no control characters, not a system label, no leading `\`).
  - `labelDeltas(before: Map<id, string[]>, add, remove)` → `{ messageId, added, removed }[]`, with only the labels that really changed.
- **`folder-ops.ts`**
  - `validFolderName(name, { delimiter, siblings, namedLikeSpecialUse })`: 1–100 characters after trim, no control characters, no delimiter, not `.` / `..` / INBOX, a case-insensitive clash check, and the injected special-use check (spec resolution 18).
  - `folderOpRefusal(folder, { op, children, snoozeFolder, gmail, movePending })`: INBOX, special use, under `[Gmail]` / `[Google Mail]`, the snooze folder, children (for delete), pending moves, non-selectable parent.
  - `gmailLabelFolder(folder, gmail)` for spec resolution 5.
  - `renamedPath(path, from, to, delimiter)` covers the path itself and its children.
- **`undo.ts`**
  - `UndoGroupKind` gains `"labels"`, and the group gains `labelDeltas` (spec resolution 10).
  - `undoToastText` / `undoResultText` for labels ("Labels changed").

**Tests to write first:**
- [ ] `search.test.ts`, with every existing case kept:
  - each operator, including `newer_than:3m` and `older_than:1y` against a fixed clock;
  - `-in:trash` negated, `-word` and lone `-` kept as text, `-bogus:x` kept as text with a note;
  - quoted values, and repeated `in:` / `account:` collected for OR;
  - sizes `10K`, `2M`, over 2 GB, and `abc` → note;
  - `has:attachments`, `filename:pdf`, Unicode spaces as `\u00a0` / `\u2003` escapes in the source;
  - 200-character cut, control characters removed.
- [ ] `file-kinds.test.ts`: the kind table, SVG `image` but not viewable, each magic number, an SVG behind a BOM and XML declaration, HTML detected, binary with NUL not text, and a mismatch between declared and sniffed.
- [ ] `quotes.test.ts`: English and Russian attributions, Outlook headers, `>` runs, and nothing hidden when everything would be.
- [ ] `labels.test.ts`: system labels hidden and refused, deltas skip labels already present or already absent.
- [ ] `folder-ops.test.ts`: every name rule and refusal, the special-use function called, `renamedPath` with children and a sibling prefix (`Work` versus `Work2`).
- [ ] `undo.test.ts`: the labels kind texts and that a labels group round-trips.
- [ ] `npm run check` → commit.

### Task 2: Core server-search plan, history steps, saved searches, attachment text, related terms (pure)

**Files:** new `src/core/server-search.ts`, `src/core/history.ts`, `src/core/saved-searches.ts`, `src/core/attachment-text.ts`, `src/core/related.ts` (each + test); `src/core/index.ts`.

**Produces:**
- **`server-search.ts`**
  - `ServerCriteria` (Mail's own: `text`, `from`, `to`, `cc`, `subject`, `since`, `before`, `larger`, `smaller`, `seen`, `flagged`, `not[]`, `gmailRaw?`).
  - `planServerSearch(parsed, account: { gmail: boolean }, folders: Folder[])` returns one of:
    - `{ kind: "gmail"; runs: { folder, raw }[] }`: All Mail, or Trash or Spam folders for `in:trash` / `in:spam`;
    - `{ kind: "folders"; runs: { path, criteria }[]; skipped: number }`;
    - `{ refused: "nothing_to_search" }`.
  - `localOnly` notes for `list:`, `category:` and non-Gmail `label:`.
  - Gmail without a `\All` folder is planned as `folders` with `gmailRaw` (spec resolution 11).
  - `gmailRawOf(conditions)` quotes values after removing `"` and control characters.
  - `postFilter(row, parsed)` applies `has:attachment`, `filename:` and the header-date recheck for one-day slack.
  - Caps: 30 folders, 2 000 uids per folder, 50 per batch, 60 s per account.
- **`history.ts`**
  - `historyRange(state: { historySince, syncedSince }, stepDays)` → `{ from, before }`.
  - `nextHistorySince(range, fetchedOldest, newCount)`.
  - `emptyStepsNote(count)`.
  - `conversationSearches(thread: { messageIds, refs, gmThrid })` → Gmail `threadId`, or `HEADER` searches, at most 50 ids.
  - `HISTORY_STEP_MAX = 500`, `CONVERSATION_MAX = 100`.
  - `jobInsertable(uids, state: { uidValidity, lastUid } | null, sessionUidValidity)` → `{ uids, skipped, reason? }` (spec resolution 6).
- **`saved-searches.ts`**: `validSavedSearch({ name, query })` (1–60 / 1–500) and `SAVED_SEARCHES_MAX = 50`.
- **`attachment-text.ts`**
  - `decodeText(bytes, charset)`: UTF-8 fallback, replacement characters, control characters removed, whitespace collapsed, ≤ 200 000 characters.
  - `indexCandidates` caps (50 per round, 200 MB raw per day, 10 MB file, 25 MB message).
  - `ATTACHMENT_TEXT_TOTAL_MAX = 50_000_000` (spec resolution 15).
  - `excerptAround(body, phrase, 120)`.
- **`related.ts`**
  - `relatedTerms(subject, text)`: ≤ 8 terms, ≥ 4 characters, English and Russian stop words, ticket tokens such as `INV-2041`.
  - `scoreRelated(candidates)`: terms by rarity, +2 per shared participant, +5 per shared reference, top 10 with reasons.

**Tests to write first:**
- [ ] Gmail raw strings: escaping of `"` and control characters, negations, roles, `in:trash` running in the Trash folder, no-`\All` fallback.
- [ ] IMAP criteria per operator, folder choice (Trash, Junk and Drafts only when named), the 30 cap with `skipped`, local-only notes, `nothing_to_search`.
- [ ] Post-filter: has-attachment and the date slack.
- [ ] History ranges: step boundaries, 500 continuation from the oldest fetched, empty steps.
- [ ] `jobInsertable`: above `lastUid` skipped, mismatching UIDVALIDITY and missing state skip all.
- [ ] Conversation searches capped at 50.
- [ ] Saved search bounds.
- [ ] Decoding: latin1, broken UTF-8, NUL, caps.
- [ ] Related: terms (with Cyrillic test words written as `\u` escapes or plain UTF-8, never mangled), scores, reasons, bounds.
- [ ] `npm run check` → commit.

### Task 3: Contract, model and ports

**Files:**
- `src/core/contract.ts` (+ `contract.test.ts`), `src/core/model.ts`, `src/core/ports.ts`, `src/core/index.ts`.
- Stubs so everything compiles and stays green:
  - `src/core/testing/fakes.ts` and `src/adapters/bb/sqlite-store.ts`: new read methods answer empty, new write methods throw "Not available yet".
  - `server.ts`: new handlers `refuse("conflict", "Not available yet")`.

**Produces:**
- **`contract.ts`**: the 28 new methods of the spec's RPC table, plus the changes from the resolutions:
  - `search` input gains `cursor?` and `attachments?: boolean`, and its output gains `nextCursor`, `notes` and `attachmentMatches`.
  - `folder_delete_check` output gains `gmailLabel: boolean`.
  - `server_job_poll` accounts gain `skipped` and a `reason` enum that includes `not_synced` and `changed`.
  - `attachment_text_status` gains `full`.
  - `SLICE_3H_METHODS` (28 names).
- **`model.ts`**
  - `MessageSummary` / `MessageHeader` gain `kept: KeptState | null` and `labels: string[]`.
  - `Folder` / `RemoteFolder` gain `subscribed`.
  - `AttachmentView` gains `kind`.
  - New `FileRow`, `SavedSearchView`, `SenderCard`, `RelatedHit` and `KeptState`.
- **`ports.ts`**
  - `MailStore.upsertMessages(…, opts?: { kept?: "history" | "search" })` (spec resolution 7).
  - `search(query, accountId, limit, opts?: { scoped?: boolean; attachments?: boolean; cursor? })`.
  - New store methods for saved searches, folder prefs, files, sender card, related candidates, attachment text, kept expiry and promotion, history forget, folder re-home, `historyChecked`.
  - `FolderSession` gains `searchServer(criteria: ServerCriteria): Promise<number[]>`, `fetchLabels(uids)` and `setLabels(uids, { add, remove })`.
  - `ImapGateway` gains `renameFolder`, `folderStatus`, `deleteFolder(config, path, { expectEmpty })`, `setSubscribed` and `namedLikeSpecialUse(name): boolean`.
  - `SyncOptions.historyCheck?` lives in `sync.ts`.

**Tests to write first:**
- [ ] Method set: 126 + 28 = 154, the earlier per-slice counts filtering out `SLICE_3H_METHODS`.
- [ ] Bounds: query ≤ 500, name ≤ 60, folder name ≤ 100, labels ≤ 20 each, `messageIds` ≤ 200, limits.
- [ ] The credential-key walker over every new output schema.
- [ ] `search` input without `attachments` parses as before.
- [ ] `npm run check` → commit.

### Task 4: Store and migration element 13

**Files:** `src/adapters/bb/sqlite-store.ts` (+ `sqlite-store.test.ts`); `src/core/testing/fakes.ts` (`InMemoryMailStore` parity).

**Element 13** = the spec's SQL as written, plus `ALTER TABLE sync_state ADD COLUMN history_checked_at TEXT` (spec resolution 23). Do not touch elements 0–12.

**Produces:**
- **`search`**
  - Search runs over `conditions` with bound parameters and `likePattern` (spec "SQL"), with `in:` before the dedup.
  - The keyset cursor follows `date IS NULL DESC, date DESC, id DESC` (spec resolution 17).
  - `attachment_text_fts` is joined only when `opts.attachments === true`, with `attachmentMatches` (spec resolution 4).
- **`upsertMessages` with `kept`**: never downgrades a window row or an `opened` row, and moves `search` to `history` (spec resolution 7). Promotion to `opened` happens in `markOpened`, flag, move, reply, snooze, label and bind paths.
- **`listMessages`, `filesList`, `senderCard` and `relatedCandidates`**
  - `filesList` is deduplicated by `(dedup key, part_id)`.
  - `senderCard` counts From by `from_address = ? COLLATE NOCASE` (spec resolution 20).
  - `relatedCandidates` uses ≤ 200 candidates.
- **Saved searches** CRUD and move, ≤ 50.
- **`folder_prefs`**.
- **`expireSearchRows(now, days)`** deletes rows with their attachments, inline parts and `attachment_text`.
- **`historyForget` and `historyForgetCount`.**
- **`rehomeFolder(accountId, from, to, delimiter)`** in one transaction over `messages.folder`, `sync_state.folder`, `folders.path`, `compose_drafts.server_folder`, `accounts.snooze_folder`, `snoozes.return_to`, `folder_prefs.path` and `ai_scope_accounts.folders_json` (spec resolution 3).
- **`dropFolder(accountId, path)`**, also dropping the `folders_json` entry.
- **`saveFolders`** stores `subscribed` and drops removed paths from `folders_json` (spec resolution 3).
- **`attachment_text`**: insert, status, retry, clear, the total-characters sum (spec resolution 15), and explicit deletes in `deleteRows` and `deleteAccount`.
- **`deleteAccount`** also deletes `saved_searches` and `folder_prefs`.

**Tests to write first:**
- [ ] Elements 0–11 still match the pin.
- [ ] Migration on a database built with `MIGRATIONS.slice(0, 13)`: columns exist; `attachments.kind` is backfilled for each `CASE` arm; FTS triggers work on insert, update and delete.
- [ ] Every condition's SQL against rows: `in:trash` finds a Trash copy, `filename:pdf`, labels for Gmail and folder names for others, `-has:attachment`.
- [ ] Paging across equal and NULL dates.
- [ ] Attachment hits only with `attachments: true`, even unscoped.
- [ ] Kept upgrade rules; expiry deletes `attachment_text`.
- [ ] **Schema scan**: every column named `folder`, `path`, `*_folder` or `return_to` from `sqlite_master`, plus `folders_json`, is covered by `rehomeFolder`. Fails on a new uncovered column.
- [ ] Rename re-homes children but not a sibling prefix.
- [ ] `saveFolders` removal drops the `folders_json` entry.
- [ ] Total cap sum.
- [ ] One timing test at 20 000 messages for a page of `search`, `filesList`, `senderCard`, `relatedCandidates` and `listMessages` (generous bounds, seed untimed).
- [ ] `npm run check` → commit.

### Task 5: Gateway

**Files:** `src/adapters/bb/imapflow-gateway.ts` (+ `imapflow-gateway.test.ts`).

**Produces:**
- **`searchServer(criteria)`**
  - Translates to imapflow's `SearchObject` (`gmraw` only when `capabilities().gmail`).
  - `false` → `SafeImapError("SearchFailed")` (spec resolution 20).
  - At most 2 000 uids kept per folder.
- **Labels on Gmail sessions**: `fetchMessages` and `fetchFlags` request `labels: true` and report `gmLabels`.
  - `setLabels(uids, { add, remove })` uses `messageFlagsAdd` / `messageFlagsRemove` with `{ uid: true, useLabels: true }`.
  - `false` → `SafeImapError("LabelsRefused")`; after success it re-fetches `labels` for those uids (spec resolution 10).
- **`renameFolder`, `folderStatus`, `deleteFolder` and `setSubscribed`**
  - Each opens a fresh connection with no mailbox selected and logs out after.
  - `deleteFolder` with `expectEmpty` runs `STATUS messages`, then `DELETE` on the same connection, `NotEmpty` when the count is above 0. With `expectEmpty: false` (Gmail label) it runs `DELETE` only.
  - Errors are mapped to Safe codes (`RenameFailed`, `DeleteFailed`, `SubscribeFailed`), never server text.
- **`listFolders`** keeps `subscribed` (`ListResponse.subscribed`; `toRemoteFolders` at 907).
- **`namedLikeSpecialUse(name)`** over `specialUse(false, { name, flags: [] })` from `imapflow/lib/special-use.js` (spec resolution 18).

**Tests to write first (imapflow fakes):**
- [ ] Criteria translation per field, `gmraw` only on Gmail, a `false` search → `SearchFailed`.
- [ ] Label fetch parsing; STORE calls carry `useLabels`; `false` → `LabelsRefused`; refetch after success.
- [ ] The fake records the selected mailbox at `DELETE` / `RENAME` and it is always none.
- [ ] Delete refuses at `messages > 0` with `expectEmpty`.
- [ ] Gmail label delete issues `DELETE` without `STATUS`.
- [ ] Logout after every command, error mapping without server text, `subscribed` mapping.
- [ ] `namedLikeSpecialUse("Trash")`, `("Sent Mail")`, `("Отправленные")` true, and `("Receipts")` false. Write the Cyrillic as `\u` escapes.
- [ ] `npm run check` → commit.

### Task 6: Sync — kept rows, history check, reset keeps opened rows

**Files:** `src/core/sync.ts` (+ `sync.test.ts`); `src/adapters/bb/sync-service.ts` (+ test); `src/core/testing/fakes.ts`.

**Produces:**
- **`export function prepareMessage`**, behaviour unchanged (spec resolution 7).
- **`SyncOptions.historyCheck?: boolean`**: `reconcile` checks flags between `history_since` and the window only then, and records `history_checked_at`. The sync service sets it on full rounds for folders whose check is NULL or older than 24 h (spec resolution 9).
- **`keptAtReset`** also wants `kept = 'opened'` rows (spec resolution 16). A reset clears `history_since`.
- **Window rows**: a row inside the window has its `kept` cleared by reconcile.
- **Gmail All Mail sync** stores `gm_labels`, and the flag pass refreshes them.

**Tests to write first:**
- [ ] `prepareMessage` exported gives the same output as before for the existing fixtures.
- [ ] History rows are checked only with `historyCheck`, and a deleted history message is removed then.
- [ ] Incremental rounds never fetch flags of history rows.
- [ ] Reset: an `opened` row is reattached by Message-ID, an `opened` row gone from the server is deleted, a `history` row not reattached is deleted, and `history_since` is cleared.
- [ ] `gm_labels` stored and refreshed.
- [ ] The ok outcome's `newInbox` / `returning` / `inserted` are unchanged.
- [ ] `npm run check` → commit.

### Task 7: Server search, history and conversation jobs; expiry

**Files:** new `src/adapters/bb/server-search-jobs.ts` (+ `server-search-jobs.test.ts`); `src/core/history.ts` wiring if needed; `src/adapters/bb/day-clock.ts` (+ test).

**Produces:**
- **`createServerJobs({ store, gateway, clock, limits })`**
  - One job per account, at most one running per account and three in all, each a polled job with progress, cancel and a 60 s budget per account.
  - Read-only sessions only, and not on the write queue.
  - `jobInsertable` before every insert (spec resolution 6).
  - `prepareMessage` and `upsertMessages(…, { kept })`; threads rebuilt once per batch.
  - Server search: newest 50 per batch, the cursor for **More from the server**, `postFilter`.
  - History: the step, the 500 cap, `history_since`, empty-step counts.
  - Conversation: Gmail `threadId` or the header searches, ≤ 100.
- **Day clock**: once a day, `expireSearchRows(now, serverSearchKeepDays)`.

**Tests to write first:**
- [ ] The fake session refuses any write and any non-read-only open.
- [ ] 50-hit batches and **More**; dedup against stored rows.
- [ ] Cancel between folders and batches, budget expiry with `partial`.
- [ ] `SearchFailed` reported.
- [ ] **New mail is not hidden.** A job never inserts an Inbox uid above `last_uid`, and the next `syncAccount` round still reports that message in `newInbox`. Mismatching UIDVALIDITY and a folder without `sync_state` are skipped with their reason.
- [ ] Kept values; history continuation and three empty steps; conversation caps.
- [ ] Expiry after 14 days, never for `opened` or `history`.
- [ ] A canary query and folder name absent from every recorded log.
- [ ] `npm run check` → commit.

### Task 8: Attachment text indexer and PDF worker

**Files:** new `src/adapters/bb/attachment-indexer.ts` (+ test), `src/adapters/bb/pdf-text.ts` (+ `pdf-text.test.ts`), and the worker entry Task 0 chose.

**Produces:**
- **`extractPdfText(bytes, { timeoutMs: 20_000, maxPages: 200 })`**
  - Runs in a `worker_threads` worker with `resourceLimits` and `terminate()` on the timer.
  - Returns `{ text } | { skipped: "encrypted" } | { failed: "timeout" | "unreadable" }` (spec resolution 1).
  - Built only if Task 0's server part passed.
- **`createAttachmentIndexer`**
  - Runs after an ok sync round when `indexAttachmentText` is on. Candidates follow the spec's rules (no `search` rows, no Spam or Trash).
  - Fetches each message with one `fetchRawGuarded` and `parseMail`, then reads each part with the download route's name, type and size checks.
  - Decodes text with `decodeText` and runs PDFs through `extractPdfText`.
  - Respects the round and daily budgets and the total cap (spec resolution 15).
  - Writes failure rows, supports **Retry failed** and **Remove attachment text**.
  - Runs one worker at a time.

**Tests to write first:**
- [ ] Charsets and caps.
- [ ] A hand-written PDF's text extracted.
- [ ] An encrypted PDF is skipped.
- [ ] A worker that never answers is terminated at the bound (use a short test timeout, a generous assertion).
- [ ] An out-of-memory worker → `unreadable` and the test process is fine.
- [ ] Round, daily and total budgets.
- [ ] No Spam or Trash, no `search` rows.
- [ ] A failed file is not retried until **Retry**.
- [ ] Clear deletes everything.
- [ ] With the server spike failed: PDFs produce no row.
- [ ] `npm run check` → commit.

### Task 9: Server RPCs

**Files:** `server.ts` (+ `server.test.ts`); `src/adapters/bb/downloads.ts` (+ test) for the `view` ticket; `src/adapters/bb/undo-book.ts` (+ test) for labels.

**Produces:**
- **`search`**
  - `refusePluginCaller` is added.
  - `parseQuery(query, now)`, cursor, notes.
  - `attachments` is passed to the store only from this RPC (spec resolution 4).
  - The CLI `search` command and `mail_search` / `agentSearch` take the new operators, and `agentSearchRefusal` runs on every free-text-bearing value (spec "Agents").
- **Job RPCs**: `server_search_start` / `more`, `history_load`, `conversation_load`, `server_job_poll` / `cancel`, `history_forget_check` / `history_forget`.
- **Saved searches.**
- **Folder RPCs**: `folder_create`, `folder_rename` (re-home), `folder_delete_check`, `folder_delete` and `folder_subscribe`.
  - All run through the account write queue, with the refusals and the special-use name check.
  - `folder_delete` has three paths: the Gmail label path (spec resolution 5); the empty path; and move-then-delete in 500-uid batches with the count recheck and "New mail arrived…".
  - After each operation: re-list and queue a sync.
- **`folder_prefs_set`, `messages_list`.**
- **Labels**: `labels_list`, and `labels_change` with the All Mail uid lookup, write queue, `labelDeltas` undo group, and no undo record on `LabelsRefused`.
- **View tickets**: `attachment_view_ticket` and the `/download` `view` kind, with server-side `sniffKind`, `409 not_viewable` on mismatch, SVG and HTML refused, the caps, and `BASE_HEADERS` unchanged (spec resolution 20).
- **Other read RPCs**: `files_list`, `attachment_text_status` / `retry` / `clear`, `related_messages` and `sender_card`.
- **Settings** from the spec table.
- **Shell limit**: the 3c accepted limit names the new server writes and fetching RPCs.

**Tests to write first:**
- [ ] Every new method refuses plugin callers, and so does `search`.
- [ ] **Attachment text is owner-only.** CLI outside a thread, `mail_search` and the agent path get no attachment hits for a matching attachment, and the page RPC with `attachments: true` does.
- [ ] **Folder writes go through the queue.** Folder operations run on the queue with fresh connections. Rename re-homes, including the AI scope.
- [ ] **Delete paths.**
  - Delete refuses a system folder, children and the snooze folder.
  - Move-then-delete stops when the count changes.
  - The Gmail label delete never moves.
  - A special-use-like name is refused.
- [ ] **Labels and undo.** Labels change and undo restores only the deltas, and a refused STORE gives an error and no undo.
- [ ] **View tickets.** Ticket sniffing per kind, mismatch `409`, SVG `not_viewable`, caps, single use.
- [ ] Settings bounds.
- [ ] **No names leak.** A canary query, folder name, label name and file name are absent from logs, agent log and realtime.
- [ ] `npm run check` → commit.

### Task 10: UI — search, rail, list, folders, drag, labels

**Files:**
- `src/ui/mail-page.tsx`, `src/ui/folder-list.tsx`, `src/ui/mail-sidebar.tsx`, `src/ui/thread-list.tsx`, `src/ui/routes.ts`, `src/ui/shortcuts.ts` (each + test).
- New `src/ui/search-help.tsx`, `src/ui/server-search-strip.tsx`, `src/ui/saved-searches.tsx`, `src/ui/files-view.tsx`, `src/ui/folder-dialogs.tsx`, `src/ui/history-forget-dialog.tsx`, `src/ui/drag-move.ts`, `src/ui/labels-dialog.tsx`, `src/ui/label-chips.tsx` (each + test).
- `app.tsx` wiring (+ `app.test.tsx`).

**Produces:**
- **Search header**: operator notes, help, **Save search**, **Search on the server** with the per-account strip, "from the server" marks, attachment-match excerpts. Only this page's search call passes `attachments: true`, and only when `indexAttachmentText` is on.
- **Rail**: **Saved** with counts, **Files** (`g f`, subPath `files`), saved routes `s/<id>`.
  - Folder and account menus: new, rename, subscribed, delete with the move step or the Gmail label text (spec resolution 5), group by conversation, forget older mail.
  - **More folders** for unsubscribed folders, drop targets.
- **Drag**: `application/x-makosh-mail-move` with `{ v: 1, pageId, threadIds }`. Only the same page's payload is accepted, role targets map to role actions, and the cap is 200.
- **List**: label chips (up to three), **Load 30 more days** with progress and **Stop**, single-message mode.
- **Shortcuts**: `g f`, `l`. `;` and `Shift+P` are added in Task 11.

**Tests to write first (jsdom):**
- [ ] Notes render as text.
- [ ] Strip states: partial, refused, cancel.
- [ ] Saved search routes, and a missing id shows the note.
- [ ] Files filters and paging.
- [ ] Folder dialogs: refusal texts, the move step, the Gmail label wording, the non-undo note.
- [ ] Drag payload: a foreign type or `pageId` is ignored, a drop on Trash means Delete, 201 messages are refused.
- [ ] Labels dialog: system labels absent, a new label validated.
- [ ] Routes parse and build `files` and `s/<id>`.
- [ ] `npm run check` → commit.

### Task 11: UI — reading: viewer, PDF, quotes, plain text, dark mail, sender card, related, print

**Files:**
- New `src/ui/attachment-viewer.tsx`, `src/ui/pdf-view.tsx` (only if Task 0's page part passed), `src/ui/sender-card.tsx`, `src/ui/related-mail.tsx`, `src/ui/print.ts` (each + test).
- `src/ui/reading-pane.tsx`, `src/ui/message-frame.tsx`, `src/ui/sanitize.ts`, `src/ui/mail-settings.tsx` (+ tests).
- New `src/adapters/bb/pdf-page.ts` (+ test), the `PdfEngine` over `pdfjs-dist` that only `app.tsx` imports.
- `app.tsx`.

**Produces:**
- **Viewer**
  - `fetch(ticket.url)` → `Blob` with the server's type → object URL, revoked on close and never navigated to.
  - Images go into `<img>` or the injected lightbox. Text goes through the injected `renderCode` (`HostSourceCode`), else `<pre>`.
  - SVG and HTML are not viewable (spec resolution 13).
- **PDF**
  - `pdf-view.tsx` takes `engine: PdfEngine | null`, and `null` means download-only.
  - `pdf-page.ts` runs `getDocument({ data, isEvalSupported: false, disableAutoFetch: true, disableStream: true, enableXfa: false })` with no `cMapUrl` / `standardFontDataUrl` / `wasmUrl`, `annotationMode: DISABLE`, at most 5 rendered pages and 500 pages.
  - It starts the blob worker with a start probe. A failure means download-only, never the main thread (spec resolution 2).
  - Links are `http(s)`/`mailto` only, listed and opened by click. The note "Some parts of this PDF may not display".
- **Quotes**: `quoteRanges` for plain text.
  - The sanitizer's `uponSanitizeAttribute` hook drops incoming `data-mk-*`, then marks quote blocks on the sanitized tree, and the `data-mk-quotes` toggle works through `contentDocument` (spec resolution 14).
  - **Expand all / Collapse all** with `;`.
- **Plain text / Original**, with `mailView`.
- **Dark mail**: `dark` is passed from `app.tsx` (`experimental_useCodeTheme().mode`), `declaresDarkSupport(rawHtml)` is read before sanitizing, and **Original colors**. The CSP and the sandbox are unchanged.
- **Sender card, Related mail.**
- **Print** (`Shift+P`)
  - A sandboxed frame with exactly `allow-same-origin allow-modals`, no remote images (spec resolution 19).
  - **Save printable page** goes through the injected `saveFile`.

**Tests to write first:**
- [ ] **Viewer.**
  - It renders per kind.
  - The blob is revoked on close and nothing navigates or calls `openUrl`.
  - SVG and HTML are refused.
- [ ] **PDF view** (fake engine).
  - The options are asserted.
  - Annotations are not rendered.
  - Links are filtered.
  - A `null` engine or a failed probe means download-only.
  - No main-thread path exists.
- [ ] **`pdf-page.ts`** against the real `pdfjs-dist` in jsdom where possible, else the option shape only.
- [ ] **Sanitizer.**
  - An incoming `data-mk-quote` is stripped.
  - Quote marks and the toggle work.
  - Nothing is hidden when everything would be.
  - `declaresDarkSupport` positives and negatives.
  - The dark style appears only when `dark` is set and the mail has no dark styles.
  - The CSP string is unchanged.
- [ ] **Print.** The document is escaped, the sandbox attribute is exact, the CSP has no `https:`, and the fallback download works.
- [ ] **Sender card and related.** The card's actions call the existing RPCs, and related reasons render.
- [ ] `npm run check` → commit.

### Task 12: Docs, listing and pins

**Files:**
- `plugins/mail/README.md`, `PLUGIN_OVERVIEW.md`, `package.json` (`description` / `bb.description`), root `marketplace.json` (the mail entry only), `skills/mail/SKILL.md`, `CHANGELOG.md`.
- `docs/mail-feature-backlog.md`.
- `src/adapters/bb/sqlite-store.test.ts` (pin).
- Root `THIRD_PARTY_NOTICES.md` (only if Task 0's entry needs the final paths).

**Steps:**
- [ ] **README and `PLUGIN_OVERVIEW.md` content**:
  - what goes to the owner's mail server: search words, older mail, hits and opt-in attachments;
  - each new server write and its limits;
  - the folder-delete residual risk (non-Gmail) and the Gmail label delete (spec resolution 5);
  - the crash-between-rename note (spec resolution 8);
  - attachment text: opt-in, local, the owner's searches only, the total cap, and PDF or text-only per Task 0;
  - the viewer's file types: SVG download-only, PDF preview or download-only per Task 0;
  - printing without remote images;
  - `@napi-rs/canvas` may be installed but is never used (spec resolution 21);
  - the shell limit with the new RPCs.
- [ ] **The listing and the skill**: `bb.description`, `PLUGIN_OVERVIEW.md` and the `marketplace.json` entry describe current behaviour and change together. `SKILL.md` documents the new operators for `mail_search` and says there is no server search and no attachment text for agents.
- [ ] **Backlog labels**: `[уже есть]` for 34, 35, 43, 49, 50, 54, 62, 63, 79, 84 (or "текст вложений; PDF — нет" per Task 0), 85, 86, 88 and 89. Item 83 is `[позже]` with "связанные письма — локально, срез 3h". Items 74 and 76 are `[кандидат]` with "срез 3j". Update the header's date line.
- [ ] **Pin**: `MIGRATIONS.slice(0, 14)` with the SHA of elements 12 and 13 added.
- [ ] **Build checks**: `npm run check`, `npm run build`, `node ../../scripts/check-manifests.mjs`. Record the `dist/app.js` and `dist/server.js` sizes before (Task 0's numbers) and after. `grep -c "napi-rs"` is 0 for `dist/server.js` and exactly 1 for `dist/app.js` (pdf.js's own Node-only `NodeCanvasFactory` literal, see "Task 0 result"), and `grep -ci skia dist/*.js` = 0.
- [ ] **Commit** (`docs(mail): 3h — …`).

### Task 13: Live check in the owner's BB — **owner-run**

Only the owner runs this, after the build and after deciding to load it. Agents prepare the checklist and record the results the owner reports. No agent installs the plugin, reads the owner's real mail or changes the owner's folders or labels.

- [ ] Operators on real mail: `to:`, `has:attachment`, `in:`, `larger:`, `newer_than:`, negation.
- [ ] Server search on Gmail and iCloud: an old message is found, fetched and opened. Cancel works, nothing is marked read, and a non-ASCII query on iCloud gives a result or the refusal text. Gmail `in:trash`.
- [ ] **Load 30 more days**, **Load the whole conversation**, **Forget older mail**. After a day, a message deleted on the server leaves loaded history.
- [ ] Saved search with a count.
- [ ] Folders on a test folder:
  - create, rename with a subfolder (record whether iCloud keeps UIDVALIDITY), subscribe toggle;
  - delete an empty folder;
  - delete a non-empty one through Trash, using test messages sent to self;
  - delete a Gmail test label with messages, which stay in All Mail;
  - a folder named `Trash` refused.
- [ ] Drag a conversation to a folder; Undo.
- [ ] Gmail labels: chips, add, remove, Undo, a new label.
- [ ] Viewer: an image, a text file, a PDF with a link. Record the PDF worker probe result in BB (CSP). An SVG and a renamed `.exe` are download-only.
- [ ] Files view filters; attachment text search on a PDF (or a text file per Task 0) with the setting on.
- [ ] Quotes hidden, plain text, dark mail in BB's dark mode, **Original colors**.
- [ ] Sender card; Related mail.
- [ ] Print and Save as PDF on macOS (no remote images); the fallback where print is missing.
- [ ] Shortcuts `g f`, `l`, `;`, `Shift+P` do what Mail says and nothing in BB fires. Record any conflict.

---

## Batches for implementation agents

Each batch is one implementation agent working through its tasks in order and committing per task. A batch starts only after the previous batch's commits are in. A Fable verification agent reviews each batch before the next starts.

| Batch | Tasks | Why together |
| --- | --- | --- |
| A | Task 0 | The gate. Its result decides what Tasks 8, 11 and 12 build. |
| B | Tasks 1, 2 | Pure core, no I/O. They share `search.ts`'s `ParsedQuery` and the index exports. |
| C | Tasks 3, 4 | Contract, model and ports, then the store and migration 13 that implement them. |
| D | Tasks 5, 6, 7 | Gateway, sync and the jobs that use both. These are the IMAP-facing pieces with the new-mail and no-expunge invariants. |
| E | Tasks 8, 9 | The attachment indexer and every server RPC. Task 9 wires Task 8. |
| F | Tasks 10, 11 | All UI and `app.tsx` wiring. One agent, because both tasks edit `app.tsx` and `reading-pane.tsx` / `thread-list.tsx` neighbours. |
| G | Task 12 | Docs, listing, pins and the final build checks. |
| — | Task 13 | Owner-run. No agent. |

## Task 0 result

Run on 2026-11-16 by batch A, Node v24.20.0, `bb plugin build` with BB's toolchain esbuild 0.28.2. The spike code lived in a scratch copy of the plugin outside the repository; only the dependency, the notice and this note are committed.

**Outcome: server PASS (method a), page PASS (blob worker, inlined).** Task 8 builds PDF text extraction; Task 11 builds `pdf-view.tsx` and `pdf-page.ts`. `pdfjs-dist` stays.

**Dependency.**
- `pdfjs-dist` 6.5.438 is an exact entry in `dependencies`. `npm run check` stayed green.
- `@napi-rs/canvas` 1.1.1 landed in `node_modules` (`@napi-rs/canvas` and `@napi-rs/canvas-darwin-arm64`). The lockfile gained the package and its 11 optional per-platform entries (spec resolution 21 accepts this).

**Build facts** (`bb plugin build` code, read from BB's installed toolchain).
- The server build has exactly one entry (`server.ts` → `dist/server.js`, ESM, `platform: "node"`). Only `node:` modules and the SDK are external. There is no second server entry, so method (b) is not available.
- The app build is one `outfile` with no `splitting` and `legalComments: "none"`. A dynamic `import()` is **inlined** into `dist/app.js` as a lazy wrapper: no separate chunk, but the module is only evaluated when called.
- esbuild 0.28.2 accepts `import src from "pdfjs-dist/build/pdf.worker.min.mjs" with { type: "text" }`, which embeds the worker as a string.

**Server worker: PASS with method (a).**
- The worker is `new Worker(source, { eval: true, resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 }, stdout: true, stderr: true, workerData, transferList })`. The source string is embedded in `dist/server.js`.
- The parent resolves `pdfjs-dist/legacy/build/pdf.mjs` and `pdf.worker.mjs` with `createRequire(import.meta.url).resolve(…)` and passes `file:` URLs. From `dist/server.js` this finds the plugin's own `node_modules`. `pdfjs-dist` has no `exports` map, so deep paths resolve. The worker `import()`s pdf.js and sets `GlobalWorkerOptions.workerSrc`, so pdf.js runs its "fake worker" inside that worker thread.
- Checks, all on the built `dist/server.js` under plain Node 24:
  - The hand-written two-page PDF gives `"Invoice INV-2041 for example.com\nSecond page made-up text\n"` in about 80 ms.
  - Heap bomb (360 KB, one Flate content stream that decodes to 120 MB of alternating `Tm … Tj` lines): `ERR_WORKER_OUT_OF_MEMORY` after about 1.9 s, and the parent survives.
  - A stuck worker (a busy loop) ends as `timeout` at 20 003 ms. `terminate()` works and the process exits.
  - `grep -c "napi-rs" dist/server.js` = 0.
- **`@napi-rs/canvas`: pdf.js tries to load it on import, so stubs alone do not stop it.** The legacy build's `node_utils` calls `require("@napi-rs/canvas")` at module load whenever it runs in Node, whatever `DOMMatrix`/`Path2D` are. Control run without a hook: `process.report.getReport().sharedObjects` lists `skia.darwin-arm64.node`.
  - The worker therefore calls `require("node:module").registerHooks({ resolve })` before importing pdf.js. The hook throws for `/^@napi[-]rs\//`; pdf.js catches the error and warns.
  - The worker also installs minimal `DOMMatrix`/`Path2D` stubs.
  - With the hook: one resolve attempt is blocked, no `napi`/`canvas` shared object is loaded, and `require.cache` has no entry for it.
  - Write the pattern as `napi[-]rs` (not the literal) so the grep check stays 0.
- **For Task 8:**
  - Capture the worker's stdout and stderr (`stdout: true, stderr: true`, then drain them). pdf.js prints warnings ("standardFontDataUrl", the blocked canvas), and nothing from a PDF may reach the plugin log.
  - Use `loadingTask.destroy()`, not `doc.destroy()`, which does not exist.
  - pdf.js skips text outside the page box, so test fixtures must draw text inside the `MediaBox`.
  - **Known limit:** `resourceLimits` caps the V8 heap but not `ArrayBuffer` memory. While the bomb ran, the process RSS rose to about 750 MB, from decoded stream buffers outside the heap. The 10 MB file cap, one worker at a time and the 20 s timer bound it, but they do not cap it. Task 8 should keep those three and may lower the per-file cap for PDFs.

**Page bundle: PASS.**
- `src/adapters/bb/pdf-page.ts` (scratch) imports the worker as text, `import()`s `pdfjs-dist` (the modern build bundled without trouble), and starts the worker as `new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" })), { type: "module" })`. It hands the worker to pdf.js as `new PDFWorker({ port: worker })` and calls `getDocument({ data, worker, isEvalSupported: false, disableAutoFetch: true, disableStream: true, enableXfa: false, useSystemFonts: false })`.
- `dist/app.js` grew from 878 033 bytes to 2 605 315 bytes (+1 727 282). The embedded worker string is about 1.27 MB of that, and the inlined library about 0.46 MB.
- The same entry was bundled with the same esbuild options as BB's app build (`format: "esm"`, `platform: "browser"`, `target: "es2022"`, `minify`, `legalComments: "none"`; same +1.73 MB). It was loaded in headless Chromium (Playwright's `chrome-headless-shell`) from a local page with no BB:
  - page 1 of the fixture was drawn to a canvas: 300×200, 1 176 dark pixels;
  - `globalThis.pdfjsWorker` was absent, so there was no fake worker on the main thread;
  - the only requests were the page, the bundle and the `blob:` worker. There was no CMap, font or wasm request.
- With a CSP of `worker-src 'self'`, Chromium refused the `blob:` worker. The refusal was **not** thrown and pdf.js did not fall back: `getDocument` hung with no result. **For Task 11:** the start probe must create the worker itself and wait for its first message, or an `error` event, with a short timeout before giving it to pdf.js. If the probe fails, the engine is `null` (download-only). Never rely on `getDocument` to reject.
- **`napi-rs` in `dist/app.js`: 1, not 0.** `pdfjs-dist`'s browser build (modern and legacy alike) contains a Node-only `NodeCanvasFactory` with the string literal `createRequire(import.meta.url)("@napi-rs/canvas")`. It sits behind pdf.js's `isNodeJS` check, which is false in a browser and in an Electron renderer. esbuild leaves it as a literal because it is not a bare `require` call.
  - No canvas code is bundled: `grep -ci skia dist/app.js` = 0, and the minified worker string has no `napi-rs`.
  - The plugin cannot rewrite the bundle, because `bb plugin build` takes no esbuild plugins.
  - **This differs from spec resolution 21's literal wording.** It needs owner acceptance. Task 12's check becomes: `dist/server.js` = 0; `dist/app.js` = exactly 1, and that one is pdf.js's `NodeCanvasFactory` literal; `grep -ci skia dist/*.js` = 0.
- **License header:** `legalComments: "none"` drops pdf.js's `@licstart` header from the inlined library. The embedded worker string keeps its own header. **For Task 11:** `pdf-page.ts` keeps pdf.js's license header as a string constant that the bundle retains (for example, exported and referenced), so the bundle carries it as the notice says.

**Session lead decisions on the Task 0 follow-ups (2026-11-16).**
- The single inert `napi-rs` string in `dist/app.js` (pdf.js's Node-only `NodeCanvasFactory`) is accepted. Task 12's check stands: `dist/server.js` 0, `dist/app.js` exactly 1, `skia` 0.
- Because the worker's V8 heap limit does not bound buffer memory, PDFs get a lower file cap for text extraction: **5 MB** (`ATTACHMENT_TEXT_CAPS.pdfFile` in `src/core/attachment-text.ts`, defined in Task 2). Other attachment types keep the general 10 MB cap. Task 8 enforces it.

## Batch D deviations

Recorded by batch E (2026-11-16); batch D's code is unchanged by this note.

- New store methods beyond Task 4: `clearWindowKept`, `keptIds`, `idsByDedupKey`.
- `ServerCriteria` gained `threadId` (Gmail conversation loads) and `headers` (References / Message-ID searches).
- A history step covers `[history_since, window start)`.
- Gmail labels are fetched on every Gmail session, not only on All Mail.
- `createImapflowGateway` takes a `createClient` option (tests).

## Batch E deviations

- **Store:** one new method, `copiesIn(folder, messageIds)`: a message's copy in a folder (by dedup key) with its uid. `labels_change` and label undo resolve All Mail uids with it.
- **Jobs:** `ServerJobs.cancelAll()` was added. The server cancels every job on dispose. Jobs and the indexer write through a store proxy that refuses every call once the plugin stopped.
- **RPC code:** the slice 3h handlers live in `src/adapters/bb/slice-3h-rpc.ts` (`createSlice3hRpc`). `server.ts` wraps each in `owner3h` (plugin callers refused, then fixed-text refusals).
- **View tickets** are minted with kind `view` on the existing `/download` route. The route sniffs the bytes, serves the sniffed raster or PDF type, and serves text as `text/plain` with a detected charset, cut to 2 MB. A mismatch answers `409` with the body `not_viewable`. Over the cap after the fetch it answers `409` with `too_large`. SVG and over-cap files are refused when the ticket is minted (`NOT_VIEWABLE_MESSAGE`, `VIEW_TOO_LARGE_MESSAGE`).
- **Attachment charset:** postal-mime does not report a part's charset. Text attachments are read as UTF-8 when valid, else as windows-1252 (`charsetOf`).
- **Indexer caps:** a part over a file or message cap gets a `skipped/too_large` row, so it does not stay pending. A fetch that fails for an account-level reason writes no row (`RetryLater`). Other fetch or part mismatches are `failed/unreadable`.
- **Gmail for folder rules** is `preset === "gmail"` or a `\All` folder under `[Gmail]` / `[Google Mail]`. Folder rules have no session to ask.
- **Delimiter:** `Folder` carries no delimiter, so name checks read it from the stored paths. Rename and delete use the fresh listing's delimiter inside the queue.
- **Kept rows:** `promoteKept` is added to `compose_prepare` (reply and reply all) and to `conversation_project_set` (bind). The store already promotes on open, flags, moves and snoozes.
- **Shell limit:** the new writes and fetching RPCs are named in `skills/mail/SKILL.md`. README's "The shell limit" section is Task 12's.

## Batch F deviations

Recorded by batch F (2026-11-16).

- **Group by conversation** is kept on the page (`localStorage`, key `makosh-mail.ungroupedFolders`) and mirrored to `folder_prefs_set`. No RPC returns `folder_prefs.grouping`, so the server copy is write-only. The menu is on folder rows only; merged role views (All accounts) have no grouping switch yet.
- **Menus** are small dialogs (`src/ui/action-menu.tsx`): the design system has no dropdown or popover. The search help is a dialog too. The options buttons are named "Folder options" / "Account options" (the folder name is the title) so existing `/Inbox/`-style queries stay unique.
- **Sender card** opens from an "About <sender>" button beside the message's flag (the sender name sits inside the expand button). It offers Search from this sender, Files, Always show images and Block…; **Bind to a project…** is not offered (no 3g RPC binds by sender without a project picker).
- **Save to project…** is not in the viewer or the Files view: the save dialog lives in the reading pane's BB dialogs. The attachment chip keeps it.
- **Expand all / Collapse all (`;`)** expands (or collapses to the newest) the conversation's messages and shows (hides) their quoted text.
- **Viewer and PDF**: `PdfEngine` and `PdfUnavailable` are declared in `src/ui/pdf-view.tsx` and implemented in `src/adapters/bb/pdf-page.ts`. Each opened PDF gets its own probed worker, terminated on close. The worker text import is in `src/adapters/bb/pdf-worker-source.ts` (typed by `pdf-worker-text.d.ts`), so tests replace it. `PDFJS_LICENSE` is kept by being a property of the engine.
- **Core:** `isAttribution` moved from `ai-input.ts` to `quotes.ts` (re-exported), so the page bundle does not pull `ai-input.ts` and zod. `grep -c ZodError dist/app.js` stays 0.
- **Build** (batch F end): `dist/app.js` 2 692 361 bytes; `napi-rs`: app 1, server 0; `skia`: 0 in both.
