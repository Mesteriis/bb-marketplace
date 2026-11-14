# Makosh Mail — Slice 2 (folders, images, actions) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** All folders of each account on the Mail page, owner-only Spam / Not spam / Archive / Delete, and images (inline always, remote on consent).

**Architecture:** Generalize slice-1 INBOX sync to any folder; add folder discovery, cross-folder dedup, a pending-move queue pushed by the sync loop, inline image parts, and a remote-images sanitizer mode. Same layering (core / adapters / server / ui).

**Spec:** `docs/superpowers/specs/2026-11-15-mail-folders-images-actions-design.md` — its "Resolutions after the builder check" section overrides the sections above it. Slice-1 spec and code remain in force.

## Global Constraints

- All slice-1 Global Constraints (docs/superpowers/plans/2026-11-14-mail-imap-first-slice.md) still bind, except: server writes now allowed are `\Seen` on owner-opened messages **and** moves the owner clicked (Spam/Not spam/Archive/Delete). Never expunge; Delete moves to Trash.
- MIGRATIONS: append only. Never edit or reformat an existing element.
- Agents, mentions and CLI never move, delete or flag mail; `message_action` and image RPCs are registered with `experimental_discoverable: false` if the option exists (otherwise default) and are not exposed as tools/CLI.
- Inline image caps: 512 KB per part, 2 MB per message. Remote images: only `https:` `<img src>`; CSP `img-src data: https:` only in allowed mode.
- Move failures: only server refusals count; cancel after 3; vanished uids count as done.
- Dedup key: `gm:<X-GM-MSGID>` | `mid:<Message-ID>` | `id:<row id>`.
- Badge: distinct unread messages in Inbox folders of all accounts.
- Velo header on any file porting Velo code (e.g. folder mapping from `src/services/imap/folderMapper.ts`); list it in THIRD_PARTY_NOTICES.md.
- Commit per task on `feat/mail-imap-slice` with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; never push; never touch the installed plugin.

## Review Focus

- **Gmail duplicates:** a message in INBOX and All Mail counts once in thread counts, unread badge, search, mentions, and opening marks both copies read locally. Test in Task 2.
- **Move vs reconcile race:** a message moved by the owner must never be deleted locally before the server confirms, never reappear after a successful move, and keep a pending `\Seen`. Tests in Task 4.
- **Folders appearing/disappearing:** a folder removed on the server drops its rows; a renamed folder resyncs; a `\Noselect` parent is listed but not synced. Test in Task 4.
- **Hostile remote images:** allowed mode keeps only `https:` img src — no srcset, CSS url(), http:, data: SVG with script. Test in Task 6.
- **Large inline parts:** over-cap parts are dropped without failing the batch. Test in Task 3.

---

### Task 1: Core contract for slice 2

**Files:** Modify `src/core/model.ts`, `src/core/ports.ts`, `src/core/contract.ts`, `src/core/index.ts`; adapt `src/core/testing/fakes.ts` so the project compiles (new methods may throw "not implemented" only where no test uses them yet — Task 2/4 fill them); keep `server.ts`/`app.tsx` compiling. Tests: `src/core/contract.test.ts`.

**Produces (exact names):**
- `specialUseSchema = z.enum(["inbox","sent","drafts","junk","trash","archive","all"])`; `folderSchema = z.object({ accountId, path, name, specialUse: specialUse.nullable(), selectable: boolean, unreadCount: int, totalCount: int })`.
- `messageActionSchema = z.enum(["spam","not_spam","archive","delete"])`.
- `FetchedMessage` gains `gmMsgId: string | null`, `inlineParts: { contentId: string; mimeType: string; data: Uint8Array }[]`.
- `RemoteFolder = { path: string; name: string; delimiter: string; specialUse: SpecialUse | null; selectable: boolean }`.
- `ImapGateway`: `listFolders(config): Promise<RemoteFolder[]>`; `openFolder(config, path, { readOnly }): Promise<FolderSession>`; keep `test`. Remove `openInbox` (update all callers).
- `FolderSession` = slice-1 `InboxSession` renamed, plus `fetchFlags` result items gain `gmMsgId: string | null`, plus `moveMessages(uids: number[], destination: string): Promise<{ moved: Map<number, number> | null }>` (null map when the server returned no COPYUID; throws on refusal).
- `MailStore` additions: `saveFolders(accountId, folders: RemoteFolder[]): { removed: string[] }` (upsert; drop folders not in the list with their rows; return removed paths); `listFolders(accountId): Folder[]` (system order inbox, sent, drafts, junk, archive, all, trash, then others by name; counts by distinct dedup key in the local window); `listThreads(accountId, folder, cursor, limit)` (replaces the old signature); `pendingMoves(accountId, folder): { uid: number; id: string; destination: string }[]`; `queueMove(messageIds: string[], destination: string): { accountId: string; folder: string } | null`; `completeMove(accountId, folder, destination, moved: Map<number, number> | null, uids: number[]): void` (re-home rows; detach when map null); `failMove(accountId, folder, uids: number[]): { cancelled: string[] }` (increment failures, cancel at 3 → clear move_pending, return cancelled ids); `inlineParts(messageId): { contentId: string; mimeType: string; data: Uint8Array }[]`; `isImageSenderAllowed(accountId, address): boolean`; `allowImageSender(accountId, address): void`; `disallowImageSender(accountId, address): void`. `markOpened` marks every row with the same dedup key read locally, `seen_pending` only on the given row. `unreadCount(accountId)` counts the badge definition.
- RPC changes in `rpcSchemas`: `threads_list` input gains `folder: string` (default handled by UI as the inbox path); new `folders_list({ accountId }) → { folders: Folder[] }`; new `message_action({ messageIds: string[] 1..200, action }) → { queued: number; destination: string }`; `message_body` output gains `remoteImagesAllowed: boolean` and `html` has `cid:` already replaced by `data:`; new `images_allow_sender({ messageId }) → { address: string }`; new `images_disallow_sender({ accountId, address }) → { removed: boolean }`. `messageSummary`/`messageHeader` gain `folder: string`.

- [ ] Tests: contract method set is exactly the slice-1 eleven plus `folders_list`, `message_action`, `images_allow_sender`, `images_disallow_sender`; no credential-like keys (existing walker). **Run** `npm run check` (FAIL) → implement → `npm run check && npm run build` (PASS) → commit.

### Task 2: Store — migrations and folder/dedup/move/image/inline methods

**Files:** `src/adapters/bb/sqlite-store.ts` (append migrations; implement Task 1 store methods), `src/adapters/bb/sqlite-store.test.ts`; update `src/core/testing/fakes.ts` FakeMailStore to the same semantics.

Decisions: new columns `messages.gm_msgid`, `messages.dedup_key NOT NULL DEFAULT ''` (backfilled in the same migration step: `'mid:'||message_id` or `'id:'||id`), `messages.move_pending TEXT NULL`, `messages.move_failures INTEGER NOT NULL DEFAULT 0`; tables `folders`, `image_senders(account_id, address, created_at, PRIMARY KEY(account_id, address))`, `inline_parts(message_id, content_id, mime_type, data BLOB, PRIMARY KEY(message_id, content_id))` with cascade on message delete; indexes `(account_id, folder, uid)` exists, add `(account_id, dedup_key)`, `(account_id, folder, move_pending)`. Rows with `move_pending` are excluded from their folder's list and counts. Thread derivation counts distinct dedup keys; thread `folder` membership = any row in the folder not pending a move. `upsertMessages` stores `gm_msgid`, sets `dedup_key`, replaces inline parts within caps. `applyFlags` backfills `gm_msgid`/`dedup_key` when provided. `search` dedupes by dedup key preferring Inbox copy.

- [ ] Tests (real SQLite): `migrations append and backfill dedup keys of slice-1 rows`; `gmail copies in INBOX and All Mail count once in thread, folder and badge counts`; `markOpened marks every copy read and only the opened copy pending`; `listThreads filters by folder`; `listFolders orders system folders first`; `saveFolders drops removed folders with their rows`; `queueMove hides rows from the source folder without deleting them`; `completeMove re-homes rows with new uids keeping id and pending read`; `completeMove without a uid map detaches rows into the destination`; `failMove cancels after 3 refusals and the message reappears`; `inline parts are stored within caps and dropped over caps`; `image sender allowlist add/remove/check`; `search returns one hit per dedup key`. → commit.

### Task 3: Gateway — folders, moves, Gmail ids, inline parts

**Files:** `src/adapters/bb/imapflow-gateway.ts`, `src/adapters/bb/imapflow-gateway.test.ts`.

- `listFolders`: imapflow `list()`; map `specialUse` (`\Inbox`→inbox, `\Sent`, `\Drafts`, `\Junk`→junk, `\Trash`, `\Archive`, `\All`→all); skip folders whose flags include `\Flagged` or `\Important`; `\Noselect`/`\NonExistent` → `selectable: false`.
- `openFolder` = old openInbox with a path. `moveMessages`: imapflow `messageMove(uids, dest, { uid: true })`; `false`/`undefined` → throw `SafeImapError("MoveFailed")`; result `uidMap` → `Map`, absent → `null`.
- Fetch: map `emailId` → `gmMsgId`; `fetchFlags` returns `gmMsgId` (request `emailId` in the flags query).
- Inline parts: from postal-mime attachments with `contentId` and image MIME type (or `disposition: "inline"`), strip `<>` from contentId, cap 512 KB per part / 2 MB per message (drop extras), never fail the batch.

- [ ] Tests (mapper/stub client): special-use mapping incl. name fallback (`specialUseSource`), Gmail virtual folders skipped, Noselect not selectable, move throws on false/undefined, uidMap mapped, gmMsgId mapped in fetch and flags, inline parts extracted and capped. → commit.

### Task 4: Sync — every folder, push order, moves

**Files:** `src/core/sync.ts`, `src/core/sync.test.ts`, `src/core/testing/fakes.ts` (scripted gateway: folders, moves, uid maps).

- `syncAccount`: `listFolders` (one session-less call) → `saveFolders` (removed folders dropped) → for each selectable folder in store order: `syncFolder` (slice-1 algorithm with `INBOX` replaced by the folder path; per-folder sync state). Per folder, before reading: on a writable session after the UIDVALIDITY check, push pending `\Seen`, then pending moves grouped by destination: `moveMessages` → `completeMove`; refusal → `failMove` (cancelled ids reported in the outcome and `lastError` text "Could not move N message(s); they were returned to <folder>"); connection errors do not call `failMove`.
- Outcome gains `folders: number`. One failing folder records the error and continues with the next folder; an `ImapAuthError` stops the account (slice-1 rule).
- Rebuild threads once per account after all folders.

- [ ] Tests: `syncs every selectable folder with its own state`; `a folder removed on the server is dropped locally`; `noselect folders are not opened`; `pushes reads before moves`; `a successful move re-homes and the next round does not refetch or delete it`; `a move refused 3 times is cancelled and reported`; `a connection error during a move does not count as a failure`; `a moved message's pending read survives the move`; `a uidvalidity change skips the move push`; `one failing folder does not stop the others`. → commit.

### Task 5: Server — RPCs, actions, images, agent surfaces

**Files:** `server.ts`, `server.test.ts`, `src/core/agent-text.ts` (folder line), `skills/mail/SKILL.md`.

- `folders_list`; `threads_list` by folder; `message_action`: resolve each message's account and source folder, compute destination by special use per spec resolution 3 (refuse with a clear message when missing / not in Spam for not_spam / Gmail archive without INBOX copy), `queueMove`, realtime notify, `wake(accountId)`; `message_body`: replace `cid:` refs in HTML with `data:` URLs from `inlineParts` (only `image/*`), set `remoteImagesAllowed` from the allowlist for the sender; `images_allow_sender`, `images_disallow_sender`.
- Agent text, search hits, mention items and CLI output include `Folder: <name>`. No new tools/CLI for actions.
- Badge source `status_get.unreadCount` = new definition.

- [ ] Tests: `message_action queues a move and hides the message`; `not_spam outside Spam is refused`; `archive on gmail moves INBOX copies to All Mail`; `delete moves to Trash`; `actions are not exposed as tools or CLI`; `message_body inlines cid images as data URLs and never other mime types`; `images allowlist round trip`; `agent text shows the folder`. → commit.

### Task 6: UI — folders, actions, images

**Files:** `src/ui/sanitize.ts` (+ test), `src/ui/message-frame.tsx`, `src/ui/mail-page.tsx`, `src/ui/thread-list.tsx`, `src/ui/reading-pane.tsx`, new `src/ui/folder-list.tsx`, `app.tsx`, `app.test.tsx`.

- `sanitizeEmailHtml(html, { remoteImages }) → { html: string; blockedRemoteImages: boolean }`; CSP constant per mode; allowed mode keeps only `https:` `<img src>`.
- Folder list column (icons per special use, unread counts, selection; narrow → select in header); thread list by folder; toolbar Spam / Not spam (only in junk) / Archive / Delete; images bar ("Images are hidden to protect your privacy." [Show images] [Always show from <address>]); toasts for action results.

- [ ] Tests: sanitizer modes (hostile set from slice 1 stays clean in both modes; allowed mode keeps https img only; blockedRemoteImages flag); app: folder switch calls `threads_list` with the folder; Spam button calls `message_action` and the message disappears; Not spam shown only in Spam; images bar shows only when blocked and "Always show" calls `images_allow_sender`. → commit.

### Task 7: Docs

**Files:** `plugins/mail/README.md`, `PLUGIN_OVERVIEW.md`, `CHANGELOG.md`, `package.json` + `marketplace.json` descriptions (≤140 chars, equal), root READMEs plugin row, `THIRD_PARTY_NOTICES.md` if new Velo-ported files. Verify every claim against code. Run `node scripts/check-manifests.mjs`, `npm run check && npm run build`, `gitleaks git --no-banner --redact`. → commit.
