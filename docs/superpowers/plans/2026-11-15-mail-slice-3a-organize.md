# Makosh Mail — Slice 3a (organize & read) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** All accounts view, server-synced read/unread and flags, multi-select with bulk actions and Move to…, attachment and .eml downloads, a headers panel, and hotkeys.

**Architecture:** Same layers. Store gains desired-state flag intents (migration element 3) and cross-account listing; gateway gains flag add/remove and raw fetch; sync pushes intents; server gains extended `message_action`, `download_ticket` + HTTP download route, `message_source`; UI adds the unified rail, selection bar, dialogs and a page-scoped keydown handler.

**Spec:** `docs/superpowers/specs/2026-11-15-mail-slice-3a-organize-design.md` — its "Resolutions after the builder check" override the sections above it. Slice 1 and 2 specs still hold.

## Global Constraints

- Slice-1 and slice-2 global constraints still bind (see `docs/superpowers/plans/2026-11-14-mail-imap-first-slice.md` and `2026-11-15-mail-folders-images-actions.md`), extended: server writes allowed = `\Seen` on owner-opened mail, owner-clicked moves, owner-clicked/hotkeyed `\Seen` and `\Flagged` add/remove. Never expunge.
- MIGRATIONS: elements 0–2 frozen (shipped). Append element 3 only.
- Owner-only writes: new write RPCs (`message_action` extensions, `download_ticket`) refuse plugin callers (`refusePluginCaller`), are non-discoverable, not tools/CLI/mentions. Agents gain nothing in 3a.
- Downloads: never written to disk by the plugin; bytes never in logs, realtime or agent text; tickets 60 s, single use, in memory; route `auth: "local"`; headers `Content-Disposition: attachment; filename*=UTF-8''…`, `X-Content-Type-Options: nosniff`, `Cache-Control: no-store`, `Content-Security-Policy: default-src 'none'`; HTML/SVG/JS-like MIME served as `application/octet-stream`; raw cap 50 MB.
- Details/.eml/attachment downloads never set `\Seen`.
- Hotkeys: page-scoped listener, ignore inputs/textareas/contenteditable and Ctrl/Alt/Meta; letters by `event.code`; symbols by char with code fallback.
- Commit per task on `feat/mail-imap-slice`, trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; never push; never touch the installed plugin.

## Review Focus

- **Toggle during push:** owner flags then unflags while a STORE is in flight — final server state must match the last click (compare-and-clear). Test in Task 4.
- **Stale uid download:** a folder renumbered since the last sync must not serve another message's bytes. Test in Task 5.
- **Hostile filenames/MIME:** `../`, CR/LF, quotes, RTL override, very long names, `text/html` attachments — safe headers and filename. Test in Task 5.
- **Hotkeys while typing:** typing "jkes#" in the search box or BB composer does nothing. Test in Task 6.
- **Cross-account batch:** 250 selected threads across two accounts and several folders — chunked, each group applied once, partial failures reported. Test in Task 5/6.

---

### Task 1: Contract

**Files:** `src/core/model.ts`, `ports.ts`, `contract.ts`, `index.ts`, `contract.test.ts`; stubs so it compiles (store/fake/gateway/server/app).

**Produces:**
- `messageActionSchema` adds `"mark_read" | "mark_unread" | "flag" | "unflag" | "move"`; `message_action` input: `{ messageIds: id[] 1..200, action, folder?: string, role?: SpecialUse, destination?: string }` (exactly one of `folder`/`role`; `destination` required iff `move`); output `{ groups: { accountId, folder, queued, destination: string | null, error: string | null }[] }`.
- `threads_list` input `{ scope: { kind: "account", accountId, folder } | { kind: "all", role: SpecialUse }, cursor, limit }`; `threadSummary` gains `accountId` (already) and `flagged: boolean` (any message flagged in the scope).
- `folders_list({ accountId: string | null })` → `{ folders: Folder[]; roles: { role: SpecialUse; unreadCount: int; totalCount: int }[] }` (`roles` filled only for null).
- `messageSummary`/`messageHeader` `isFlagged` already exists; `messageHeader` gains `attachments[].partId` (exists) — no change.
- `message_source({ messageId })` → `{ headers: [string, string][]; structure: string[]; size: int; uid: int; folder: string; accountEmail: string }`.
- `download_ticket({ kind: "attachment" | "eml", messageId, partId?: string })` → `{ url: string; fileName: string }`.
- Ports: `FolderSession.setFlags(uids, change: { seen?: boolean; flagged?: boolean }): Promise<void>` (throws SafeImapError "StoreFailed" on refusal); `FolderSession.fetchRaw(uid, maxBytes): Promise<Uint8Array>`; `ImapGateway.openFolder` unchanged. MailStore: `setDesired(messageIds, change: { seen?: boolean; flagged?: boolean }): { accountId: string }[]` (all copies by dedup key; attached rows get desired values; local `is_read`/`is_flagged` updated at once on all copies); `pendingFlagIntents(accountId, folder): { uid: number; seen: boolean | null; flagged: boolean | null }[]`; `clearFlagIntents(accountId, folder, pushed: { uid; seen: boolean | null; flagged: boolean | null }[]): void` (compare-and-clear); `listThreadsAll(role, cursor, limit)`; `listRoles(): { role; unreadCount; totalCount }[]`; `rawRef(messageId): { accountId; folder; uid; size; messageId: string | null; uidValidity: number | null } | null` (null when detached or pending move); `markOpened` keeps its slice-2 meaning on the new columns.

- [ ] Tests: method set (eleven slice-1 + four slice-2 + `message_source`, `download_ticket`); exactly-one-of folder/role; destination iff move; credential walker. → `npm run check` → commit.

### Task 2: Store

**Files:** `src/adapters/bb/sqlite-store.ts` (+test), `src/core/testing/fakes.ts`, `src/core/store-rules.ts` if shared rules move there.

Element 3 per spec resolution 6 (two `ALTER TABLE … ADD COLUMN`, backfill, `CREATE INDEX threads_date ON threads(last_date, id)`). Implement every Task 1 store method and convert every `seen_pending` reader/writer (list in spec resolution 6) to `seen_desired`/`flag_desired`; `applyFlags`/upsert never overwrite non-NULL desired fields; move re-home carries both; `listThreadsAll` keyset `(last_date DESC, id DESC)` across accounts over threads having a non-pending member in a folder of that special use (Archive: `archive` only, never `all`); thread `flagged` per scope; roles sums.

- [ ] Tests: migration on a slice-2 DB (elements 0–2 hash-pinned; backfill); desired wins over reconcile and refetch; compare-and-clear; re-home carries intents; markOpened semantics unchanged; listThreadsAll merges two accounts with paging and excludes Gmail All Mail from Archive; roles counts; starred thread; rawRef null for detached/pending; fake parity via `describe.each`. → commit.

### Task 3: Gateway

**Files:** `src/adapters/bb/imapflow-gateway.ts` (+test), `package.json` (pin `postal-mime` exact).

`setFlags` via `messageFlagsAdd`/`messageFlagsRemove` (verify in dist) with `{ uid: true }`, falsy → `SafeImapError("StoreFailed")`, read-only session refused; `fetchRaw(uid, maxBytes)` via imapflow `fetchOne`/`download` with `BODY.PEEK[]` semantics (verify; must not set `\Seen`), stop and throw `SafeImapError("TooLarge")` past `maxBytes`; export `parseMail(bytes)` (the exact parser and options used by fetch) for reuse.

- [ ] Tests: add/remove calls and refusal; read-only refusal; fetchRaw peek option and cap; parseMail parity with fetch mapping. → commit.

### Task 4: Sync

**Files:** `src/core/sync.ts` (+test), fakes.

Per folder push order: `\Seen` legacy path now reads intents → push seen+/seen−/flag+/flag− with `setFlags` (one call per set) → compare-and-clear → moves (unchanged). UIDVALIDITY guard as before. Refusal → problem line, intents kept, no strike.

- [ ] Tests: four sets pushed; toggle during push (fake STORE awaits a gate; owner toggles; final state = last click after next round); refusal keeps intents; push skipped on UIDVALIDITY change; slice-2 tests green. → commit.

### Task 5: Server

**Files:** `server.ts` (+test), `src/core/actions.ts` (+test), new `src/adapters/bb/downloads.ts` (+test) for tickets/route/filenames, `src/core/headers.ts` (+test) for header/structure rendering.

`message_action`: group ids by (account, source folder) — source = `folder` or the message's copy in a folder of `role`; per group apply move rules (slice 2) or `setDesired`; return per-group results; refuse plugin callers, authFailed accounts, vault not ready (per group). `threads_list`/`folders_list` new shapes. `message_source`: `rawRef` → stale guard (spec res. 5) → `fetchRaw` (50 MB) → headers (plain text, unfolded, 256 KB cap) + structure. `download_ticket`: validate (rawRef, part exists by stored metadata), mint ticket; route `GET /download?t=` resolves the ticket once, fetches raw, for attachments re-parses with `parseMail` and checks index+filename+MIME+size, responds with the constrained headers; filename sanitizing (strip path separators, control/bidi chars, trim to 120 chars, keep extension; `.eml` name `YYYY-MM-DD subject.eml`).

- [ ] Tests: per-group results and refusals; cross-account 250-id batch chunking is UI-side but the server groups any 200-id mix; stale guard (renumbered folder, detached, pending, size mismatch); hostile filenames/MIME → safe headers; ticket single use and 60 s expiry (fake clock); no `\Seen`; no bytes in logs; route refuses missing/unknown ticket. → commit.

### Task 6: UI

**Files:** `src/ui/*` (new: `selection-bar.tsx`, `move-dialog.tsx`, `details-panel.tsx`, `shortcuts.ts`, `shortcut-sheet.tsx`), `app.tsx`, `app.test.tsx`.

All accounts option (default when >1 account) with role rail + per-account folders; account marker on rows; selection (checkbox, shift-range, `x`, select page) and selection bar (Mark read/unread, Flag/Unflag, Archive, Spam/Not spam, Delete, Move to…), chunking >200 ids; row star and unread dot; reading pane: Mark unread, Flag, Move to…, Details (headers as text, monospace, copy button), Download .eml, attachment download buttons via `download_ticket` + `experimental_saveFile` (fallback `<a download>`); hotkeys per spec + resolution 1 with `?` sheet (3b keys "soon"); toasts for per-group errors.

- [ ] Tests: unified rail and switching; account marker; selection + bar + chunking; Move to… lists only same-account selectable folders; Details renders header text with `<script>` as text; downloads call ticket then save; hotkeys work by `event.code` on a Cyrillic layout, ignore inputs, `g` sequences time out. → commit.

### Task 7: Docs

README, PLUGIN_OVERVIEW, CHANGELOG, descriptions (≤140, equal), root READMEs; note download/RPC limit for agents with shell access. Run check-manifests, `npm run check && npm run build`, gitleaks. → commit.
