# Makosh Mail — Slice 3i (part A: sender checks and spoofing warnings, trackers and link cleaning, read receipts, signed and encrypted mail recognised, secure delete; part B: Apple Mail keys, the next conversation after a delete, the earlier-messages stack) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** Mail reads the provider's own `Authentication-Results` and warns when a sender fails it, when Reply-To goes elsewhere, when a domain looks like one the owner writes to, mixes alphabets, or when a display name shows another address. A failed or disguised sender never drives a rule, a dev class, an alert or automatic images. Tracking pixels are dropped even when images are allowed, links are cleaned of tracking parameters and known wrappers, the real address shows on hover, and a deceptive link opens only after a dialog. Read receipts are never sent and the request is shown. Signed and encrypted mail gets an honest badge; an encrypted body never reaches an agent, a model, BB or the search index. Deleted rows are overwritten on disk. On top of that, Apple Mail's keys work beside the Gmail letters (arrows, Shift+arrows, Backspace/Delete, Command chords on a Mac), the next conversation opens after a removing action, and earlier messages of a conversation wait in one closed stack. No new dependency, no new network traffic, no server write.

**Architecture:** Same layers. New pure core modules: `sender-check.ts` (`senderCheckOf`, `orgDomain`, `autoImagesAllowed`), `sender-disguise.ts`, `punycode.ts`, `link-clean.ts`, `trackers.ts` (`TRACKER_HOSTS`, `TRACKING_REDIRECT_HOSTS`), `mail-crypto.ts`, `receipts.ts`; `unsubscribe.ts` gains the shared `trustedAuthResults` helper and a quote-aware `parseAuthResults`. New UI modules: `src/ui/trackers.ts` (`isTrackerImage`), `sender-warnings.tsx`, `link-status.tsx`, `successor.ts` (`successorRow`, `extendSelection`), `conversation-stack.ts`. The store gains migration element 14 and `hardenDatabase(db)`. One new owner RPC, `sender_check_refresh`. Host code stays in `app.tsx`, `server.ts` and `src/adapters/bb`.

**Specs:**
- Part A: `docs/superpowers/specs/2026-11-16-mail-slice-3i-security-privacy-design.md`. Its "Resolutions after the builder check" (1–21) override every section above them.
- Part B: `docs/superpowers/specs/2026-11-16-mail-slice-3i-part-b-keyboard-reading-flow-design.md`. Its "Resolutions after the builder check" (1–11) and "Interactions with part A" (I1–I11) override every section above them and bind part A too.
- The owner accepted every decision of both parts on 2026-11-16 and answered every open question (part A: as recommended plus the three builder-check answers; part B: ↓/↑ open the row, cursor only after a multi-selection action, bind ⌘R/⇧⌘R/⌘Z subject to the live check, the stack collapses all earlier messages). The slice 1, slice 2 and 3a–3h specs, with their resolutions, still hold where 3i does not change them.

## Global Constraints

- Slice-1, slice-2 and 3a–3h global constraints still bind (last: `docs/superpowers/plans/2026-11-16-mail-slice-3h-search-history-folders-attachments.md`).
- **Nothing is expunged, written to the server or sent.** 3i adds no IMAP write, SMTP send or outbound HTTP. The only new server traffic is `sender_check_refresh`'s read-only `BODY.PEEK[HEADER.FIELDS (...)]` through the account queue, one session per folder (part A resolution 7). No DNS, no `HEAD`, no redirect probe, no link prefetch.
- **No trust claim.** No text says a sender is genuine or a signature valid; a pass shows only in Details, in the provider's words. Every warning is fixed text with values (ASCII/punycode domains, addresses) shown as data.
- **A failed or disguised sender drives nothing** (part A resolutions 2, 5): no dev class (sync, backfill and refresh), no rule match, no alert, no automatic images (failed, lookalike, name-shows-address, and `unknown` until checked).
- **Encrypted bodies never reach a reader** (part A resolution 6): `prepareMessage` nulls them before the store; attachment-text candidates skip encrypted rows.
- **No content in logs or realtime.** The plugin log gets `sender_check: fetch failed (kind)` with the message id and `secure_delete: fts option unavailable`, nothing else; the agent log and realtime carry ids and codes only.
- **Keys:** no key BB owns (`HOST_RESERVED`), no capture-phase `window` listener, no BB patch, nothing destructive from a field, the composer, a dialog, a menu, a select or during IME composition, no expunge by key. `j`/`k` and every Gmail letter keep their behaviour.
- Every new RPC is owner-only (`refusePluginCaller`). Output keys never match `/pass|secret|seal|key/i` (the walker in `contract.test.ts`); also avoid `token` in new keys.
- **Migrations:** `MIGRATIONS` (`src/adapters/bb/sqlite-store.ts` 148) is append-only and SHA-pinned (`sqlite-store.test.ts` "shipped migration elements are unchanged", 761–788).
  - Elements 0–13 are pinned today (`MIGRATIONS.slice(0, 14)`).
  - 3i appends **element 14 only** (three `ALTER TABLE messages ADD COLUMN`: `sender_check_json TEXT`, `receipt_requested INTEGER`, `crypto TEXT`) and never edits or reformats an earlier element.
  - Task 12 pins elements 0–14 (`MIGRATIONS.slice(0, 15)`).
- `src/core` and `src/ui` stay host-free; `tests/architecture.test.ts` is unchanged. `src/ui` imports only React, DOMPurify, the TipTap packages, the design system and `src/core`. Platform detection uses the `navigator` DOM global, never a host import.
- No new dependency. `THIRD_PARTY_NOTICES.md` unchanged (the confusable table, tracker lists, parameter list and wrapper list are written for Mail; the punycode decoder is written from RFC 3492, not ported).
- Tests sit next to the code (`*.test.ts(x)`); page behaviour is tested in `app.test.tsx` (there is no `reading-pane` or `mail-page` test file).
  - Fixtures use invented addresses and domains on `example.com` / `example.org` / `example.net` only (and `example-esp.example` style hosts for trackers); A-R fixtures are hand-written in Gmail's format; no real message text.
  - Store tests run on real SQLite; server tests use `createFakePluginHost` / `createFakeSdk` overrides that record their arguments.
- Every task leaves `npm run check` green (in `plugins/mail`) and is committed on `feat/mail-imap-slice` with a message prefixed `feat(mail): 3i —` (docs: `docs(mail): 3i —`) and the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
  - `git add` only the task's own files by explicit path. The tree holds unrelated uncommitted changes (prompt-shaper, sidebar, telegram, taskboard, `marketplace.json`, `THIRD_PARTY_NOTICES.md`), and other sessions commit here.
  - Never push, tag or publish. Never touch the installed plugin, `.worktrees/live`, or another plugin.

## Recurring pitfalls (read before every task)

- **`tests/architecture.test.ts`** forbids host imports in `src/core` and `src/ui`. Its `IMPORT_SPECIFIER` regex also matches `from "…"`, `import "…"`, `import("…")` and `require("…")` **inside string literals and comments**. Never write example import lines in strings or comments there (watch doc comments in `link-clean.ts`, `punycode.ts`, `shortcuts.ts`). Never add packages to `ui.packages`.
- **No credential-shaped literals in tests.** Build made-up secrets from pieces at run time (3f review resolution 5), including in the canary block and agent-text tests.
- **Contract output keys** must not match `/pass|secret|seal|key/i`, and new keys avoid `token` too. Use `ok`/`failed`, `state`, `summary`, `warnings`, `authenticity`, `lines`, `authserv`, `refreshed`; never `pass`, `dkimKey`, `selectorKey`, `sortKey`. The walker checks every new output schema.
- **Keep `\u` escapes.** Tool-written files sometimes turn `\u0430`, `\u043e`, `\u03bf`, `\u200e`, `\u00a0` into raw characters. The confusable table, the mixed-script ranges, the punycode RFC samples, the Russian-layout key tests (`"\u043a"` for the Cyrillic letter on the R key) and any Unicode fixture are written as escapes. Before every commit run `grep -nP '[^\x00-\x7F]' <changed .ts/.tsx files>` and convert any hit that is not deliberate prose (the UI source writes its ellipsis, middle dot and arrow as `\u2026`, `\u00b7`, `\u2192`; keep that style). Agents writing through tools: if an escape keeps turning into a raw character, build it at run time (`String.fromCharCode`) or write the file with a script that emits the backslash explicitly.
- **Timing tests** time one call with a generous bound and never time the seeding (3f resolution 19): `disguiseWarnings` for a 200-message thread against 5 000 known domains; seeds go in one transaction.
- **Migration pins:** never touch elements 0–13. A migration test builds an old database with `MIGRATIONS.slice(0, 14)` and then runs `slice(14)`, like the existing test at `sqlite-store.test.ts` 5377.
- **Contract counts:** add `SLICE_3I_METHODS = ["sender_check_refresh"]` beside `SLICE_3H_METHODS`; the full method list (`contract.test.ts` 197–205) includes it and every "N earlier methods" count (`contract.test.ts` 518–519 and the like) filters it out.
- **Header schema defaults:** the four new `messageHeaderSchema` fields have zod defaults (part A resolution 17), so old fixtures and `src/core/testing/fakes.ts` keep compiling; do not hand-edit hundreds of fixtures.
- **`sync.ts` naming:** `PrepareContext.folderRole` is the role of the folder being synced; do not confuse it with `SpecialUse` values on `Folder`.
- **Frame listeners:** every listener added in `message-frame.tsx` `handleLoad` is removed in the same `detachRef`; a test reloads `srcDoc` and asserts one listener of each kind.
- **Key events in tests:** pass `code` and `key` both; Mac chords pass `{ mac: true }` explicitly to `matchShortcut`; never rely on jsdom's `navigator.platform`.

## Review Focus

- **Forged results are ignored.** Only the topmost trusted A-R header counts; worst result per method; `dmarc` only for the From domain; quote-aware split; two From lines never `ok`. Tasks 1, 5.
- **A failed sender drives nothing.** Dev class at sync, backfill and refresh; rule match; alert; automatic images (server and page paths, `unknown` included). Tasks 2, 4, 5, 7, 10.
- **Encrypted bodies go nowhere.** Null before the store; FTS empty; attachment-text candidates skip; agent/BB text print the placeholder. Tasks 4, 5, 6.
- **Links.** One choke point (`openLink`) refuses `null`; sanitize-time cleaning covers frame, print, saved page and plain view; byte-identical remaining parameters; exact wrapper hosts; the dialog rule per owner answers. Tasks 2, 10.
- **Receipts are never sent.** MIME for every compose kind; source scan. Task 2, 6.
- **No content in logs.** Canary block extended. Task 7.
- **Keys never fire in a field, dialog or IME; nothing BB owns is taken.** Tasks 8, 11.
- **The successor never opens the wrong thing.** Only when the open conversation is still the one acted on; failed conversations stay; selection → cursor only; drag through the advance ref. Tasks 9, 11.
- **The stack never hides the opened, newest or unread-at-open message.** Task 11.

---

### Task 1: Core sender check (pure)

**Files:** `src/core/unsubscribe.ts` (+ `unsubscribe.test.ts` unchanged and green), new `src/core/sender-check.ts` (+ `sender-check.test.ts`), `src/core/index.ts` exports.

**Produces:**
- `trustedAuthResults(headers, preset)` moved out of `trustOf` (same top-block rule); `trustOf` calls it, behaviour unchanged.
- `parseAuthResults` keeps every `spf`/`dkim`/`dmarc` entry with `smtp.mailfrom`, `header.from`, `header.d`, `header.i`, `header.s`; bounded first (4 KB per value, 20 entries); the `;` split and `stripComments` are quote-aware (part A resolution 4.4). The DKIM-only view `trustOf` needs is derived from it.
- `sender-check.ts`: `AuthResult`, `SenderCheck` (`state: "ok" | "failed" | "unchecked" | "unknown"`, `authserv`, `spf`, `dkim[]` ≤ 5, `dmarc`), `senderCheckOf(headers, preset, from, { folderRole })`, `orgDomain(domain)`, `autoImagesAllowed(check, warnings)`, `senderCheckSummary(check)` (fixed text such as "DMARC failed"), `authenticityLines(check)` (fixed-format lines for Details), `readStoredCheck(json, preset)` (NULL → `unknown`; stored `unchecked` with `authserv: null` on a preset that now has ids → `unknown`).
- Rules: topmost trusted A-R only; worst per method; `dmarc` counts only when `header.from` equals From's domain; relaxed alignment by `orgDomain`; two From lines or several From mailboxes never `ok`; Sent/Drafts role and outbox copies → `unchecked`.

**Tests to write first:**
- [ ] DMARC pass/fail; SPF fail with and without aligned DKIM; softfail and none → `unchecked`.
- [ ] Forged A-R below the trace block or below the topmost `DKIM-Signature` ignored; forged `Received:` + trusted-id A-R above From with no DKIM-Signature: only the topmost trusted header decides.
- [ ] Duplicate `dmarc` entries (fail wins); a `dmarc` entry for another domain does not decide; quoted `;` in `smtp.mailfrom`; unbalanced `)` in a comment.
- [ ] Untrusted authserv ignored; `other` and unpinned iCloud → `unchecked`; Sent/Drafts role → `unchecked`; a forged Inbox message from an owner address with trusted `dmarc=fail` → `failed`.
- [ ] Two From lines; caps on value size and entry count.
- [ ] `orgDomain`: `a.b.example.co.uk`, `example.com`, `xn--` labels.
- [ ] `readStoredCheck` → `unknown` for NULL and for the re-pinned preset case; `autoImagesAllowed` truth table.
- [ ] `unsubscribe.test.ts` passes unchanged.
- [ ] `npm run check` → commit.

### Task 2: Core disguise, punycode, links, trackers, crypto, receipts, pre-send, rules (pure)

**Files:** new `src/core/punycode.ts`, `sender-disguise.ts`, `link-clean.ts`, `trackers.ts`, `mail-crypto.ts`, `receipts.ts` (each + test); `src/core/presend.ts` (+ test); `src/core/mail-rules.ts` (`RuleRow.senderFailed`, + `rules.test.ts`); `src/core/index.ts`.

**Produces:**
- **`punycode.ts`**: RFC 3492 decode of one label (≤ 63 input characters, bad digit and overflow refused → null), `toUnicodeDomain(ascii)`.
- **`sender-disguise.ts`**: `skeleton(label)` (lower-case, the confusable table as `\u` escapes — Cyrillic/Greek look-alikes, `rn`→`m`, `vv`→`w`, `0`→`o`, `1`→`l`; no `I` entry; drops `-`), `scriptsOf(label)`, `KnownDomains` built from a list (indexed by skeleton and by TLD + first-label length; ≤ 5 000), `disguiseWarnings({ from, replyTo (≤ 10 used), bulk, listId, check, known, own })` → at most 4 warnings in fixed order, and `isLookalikeHost(host, known)` for the link dialog.
- **`trackers.ts`**: `TRACKER_HOSTS` (open-tracking pixel hosts) and `TRACKING_REDIRECT_HOSTS` (ESP click hosts), exact host or `.suffix` match only; neither lists `tracker.example.org` or a bare `/pixel.gif` path. Review the two lists in the batch report.
- **`link-clean.ts`**: `cleanLink(href, visibleText, { clean, known? })` → `CleanLink | null` (`url`, `original`, `removedParams`, `unwrapped`, `trackingHost`, `host`, `deceptive`, `unusualHost: "punycode" | "mixed_script" | null`, `lookalike: string | null`, `needsDialog: boolean`). Order: unwrap one level (exact wrapper hosts; target http(s) only) → string-level parameter removal (other segments byte-identical, empty `?` dropped, fragment kept) → checks on the final URL. `needsDialog` = `deceptive` (not for a listed tracking host) or `mixed_script` or `lookalike`; punycode alone never. `cleanUrlsInText(text)` for agent/BB text.
- **`mail-crypto.ts`**: `cryptoKindOf(contentType, firstNonBlankLine)` with the nits (S/MIME `enveloped-data`/`authEnveloped-data`/absent only; opaque `signed-data` → `smime_signed` with `opaque: true`; inline armor only on the first non-blank line), using `parseStructuredHeader`; `isEncrypted(kind)`.
- **`receipts.ts`**: `RECEIPT_HEADERS` and `receiptRequested(headers)`.
- **`presend.ts`**: issue `{ kind: "reply_to_elsewhere"; addresses }`; `PresendInput.replyToElsewhere: string[]`; raised for reply/reply-all while To still holds one of them.
- **`mail-rules.ts`**: `RuleRow.senderFailed`; `mailRuleMatches` false for it whatever the rule matches.

**Tests to write first:**
- [ ] `punycode.test.ts`: RFC 3492 §7.1 samples (Unicode as `\u` escapes), bad input, 63-character bound.
- [ ] `sender-disguise.test.ts`: Reply-To rules (bulk with list domain, bulk with failed check, 11 Reply-To addresses → only 10 judged); lookalike by skeleton (Cyrillic as escapes) and by one edit; not for short labels, other TLDs or known domains; mixed script; name shows another address; 4-warning cap; **timing**: 200 messages × 5 000 known domains, one call, generous bound.
- [ ] `link-clean.test.ts`: each parameter and case; remaining parameters byte-identical (`%2B`, `+`, order kept); empty query; fragment kept; Google/SafeLinks/Facebook unwrap; nested wrapper not followed twice; `javascript:` and `mailto:` targets not unwrapped; `google.evil.example` not a wrapper; deceptive text vs target; listed tracking host → no dialog + `trackingHost`; punycode-only → no dialog; mixed script and lookalike → dialog; `clean: false`; `null` for refused schemes; `cleanUrlsInText`.
- [ ] `trackers.test.ts`: host/suffix matching; the `tracker.example.org/pixel.gif` fixture is not a tracker.
- [ ] `mail-crypto.test.ts`: each content type; armor quoted further down not flagged; `compressed-data`/`certs-only` not encrypted.
- [ ] `receipts.test.ts`: the three headers detected, case-insensitive.
- [ ] `presend.test.ts`: raised, and cleared when the owner edits To. `rules.test.ts`: `senderFailed` never matches.
- [ ] `npm run check` → commit.

### Task 3: Contract, model, ports and fakes

**Files:** `src/core/contract.ts` (+ `contract.test.ts`), `src/core/model.ts`, `src/core/ports.ts`, `src/core/sync.ts` (types only: `PrepareContext.folderRole`), `src/core/testing/fakes.ts`.

**Produces:**
- `messageHeaderSchema` gains `senderCheck: { state, summary }`, `warnings: DisguiseWarning[]`, `receiptRequested`, `crypto` (with `opaque` flag for S/MIME signed-data), all with zod defaults.
- `messageBodySchema.remoteImagesAllowed` semantics documented (already present); `message_source` output gains `authenticity: { authserv; lines }`.
- `sender_check_refresh { messageIds: string[] (1–50); force?: boolean } → { refreshed: number; failed: number }`; `SLICE_3I_METHODS`.
- Settings schema gains `cleanLinks: boolean` (default true).
- `FetchedMessage` gains `receiptRequested`, `contentType`; `SECURITY_HEADER_FIELDS` in `unsubscribe.ts` (or `ports.ts` beside `fetchHeaderFields`).
- `MailStore` port additions used by Tasks 4–7: `knownDomainList(limit)`, `senderCheckRows(ids)`, `writeSenderCheck(id, { check, receipt, crypto, force })`; fakes implement them (`InMemoryMailStore` parity).

**Tests to write first:**
- [ ] The full method list with `SLICE_3I_METHODS`; earlier counts filter it.
- [ ] The credential-key walker over every new output schema.
- [ ] `sender_check_refresh` input bounds (0 and 51 ids refused).
- [ ] Defaults: a header without the new fields parses with `unknown`, `[]`, `false`, `null`.
- [ ] `npm run check` → commit.

### Task 4: Store and migration element 14

**Files:** `src/adapters/bb/sqlite-store.ts` (+ `sqlite-store.test.ts`), `src/core/testing/fakes.ts` parity.

**Element 14** = the three `ALTER TABLE messages ADD COLUMN` lines of the part A spec, nothing else. Do not touch elements 0–13.

**Produces:**
- Writes of `sender_check_json` (≤ 2 KB serialized, else not stored), `receipt_requested`, `crypto` on upsert.
- A failed row's dev columns stored as `''` (`dev: null`); `devUnclassified` excludes failed rows (part A resolution 2).
- `writeSenderCheck`: only where `unknown` unless `force`; in the same transaction clears dev columns of a newly failed row and nulls `body_text`/`body_html`/snippet of a newly encrypted row (the FTS update trigger runs).
- `attachmentTextCandidates` skips encrypted rows.
- `knownDomainList(limit)`: own identity domains plus `sent_recipients` and Sent-role To/Cc, one query, ≤ 5 000.
- `hardenDatabase(db)` → `{ pragma, fts }`: `PRAGMA secure_delete = ON` and the FTS5 `secure-delete` option on `messages_fts` and `attachment_text_fts`, each in try/catch.

**Tests to write first:**
- [ ] Elements 0–13 still match the pin.
- [ ] Migration on a database built with `MIGRATIONS.slice(0, 14)`: the three columns exist and are NULL on old rows.
- [ ] Failed row → dev `''`; `devUnclassified` skips it; refresh to `failed` clears dev columns.
- [ ] Encrypted refresh nulls the body and the FTS no longer finds a body word; attachment candidates skip encrypted rows.
- [ ] `writeSenderCheck` without `force` leaves a stored check; with `force` overwrites; 2 KB cap.
- [ ] `knownDomainList` dedups and caps.
- [ ] `hardenDatabase`: pragma reads back 1; both FTS options set (read back from the FTS config table).
- [ ] `npm run check` → commit.

### Task 5: Gateway and sync

**Files:** `src/adapters/bb/imapflow-gateway.ts` (+ test), `src/core/sync.ts` (+ `sync.test.ts`), `src/adapters/bb/server-search-jobs.ts` (+ test).

**Produces:**
- Gateway: `receiptRequested` and `contentType` from `parsed.headers` as separate `FetchedMessage` fields (the kept trace/unsubscribe lines unchanged).
- `prepareMessage`: `senderCheck` (from `unsubscribeHeaders`, preset and `folderRole`), `crypto` (Content-Type + first non-blank text line), `receiptRequested`; for `failed` sets `dev: null` regardless of `classifyDev`; for encrypted nulls `bodyText`, `bodyHtml` and the snippet.
- `syncFolder` passes the folder's role; `server-search-jobs.ts` (323) and the history jobs pass theirs.

**Tests to write first:**
- [ ] Gateway: a fixture with `Disposition-Notification-To` sets `receiptRequested`; `unsubscribeHeaders` are unchanged by it.
- [ ] `sync.test.ts`: failed row has `dev: null` with `classifyDev: true`; encrypted bodies are null; Sent role → `unchecked`; Inbox forged-own-address → `failed`.
- [ ] Jobs pass `folderRole` (fake records the context).
- [ ] `npm run check` → commit.

### Task 6: Agent and BB text, pre-send input (core)

**Files:** `src/core/agent-text.ts` (+ test), `src/core/bb-text.ts` (+ test), `src/core/sending-settings.ts` (`checkDraft`, + test), `src/core/agent-proposals.ts` (+ test), `src/core/ai-input.ts`, `src/core/agent-propose.ts`, `src/core/translate.ts` only if a direct `htmlToText` caller needs the encrypted guard (bodies are already null; add a test, not code, if so).

**Produces:**
- One Mail line after `From:`: `Sender check: failed` or `Sender warning: reply-to elsewhere | lookalike domain | mixed alphabets | name shows another address` (fixed words); `renderInboxForAgent` rows get the stored `failed` marker only; BB text the same lines.
- `[encrypted message — not readable]` for encrypted rows.
- `cleanUrlsInText` over the rendered body text **before** `redactSecrets` (`agent-text.ts` 393), always `{ clean: true }`.
- Pre-send is computed in core, not the page: `checkDraft` (`sending-settings.ts` 204–225) and the agent proposal checks (`agent-proposals.ts` 535) fill `PresendInput.replyToElsewhere` for a reply or reply-all from the source message's stored From and Reply-To through `disguiseWarnings` (known domains from `store.knownDomainList`, own addresses as today).

**Tests to write first:**
- [ ] The fixed lines, never a header value or domain; position directly after `From:` and after `UNTRUSTED_NOTICE`.
- [ ] A UTM link in the body reaches agent text cleaned; redaction counts unchanged.
- [ ] Encrypted placeholder in agent, BB thread and task prompt text.
- [ ] `checkDraft` and the agent proposal card raise `reply_to_elsewhere` for a reply whose source has a foreign Reply-To still in To, and not after the owner removes it.
- [ ] `npm run check` → commit.

### Task 7: Server

**Files:** `server.ts` (+ `server.test.ts`), `src/adapters/bb/bb-rpc.ts` (+ test), `src/adapters/bb/slice-3h-rpc.ts` only where it builds headers.

**Produces:**
- `thread_get` header fields: `senderCheck` (`readStoredCheck` + summary), `warnings` (from a known-domain cache: built lazily, rebuilt after a send or a sync round that inserted Sent rows, at most once a minute), `receiptRequested`, `crypto`.
- `message_body.remoteImagesAllowed = stored && autoImagesAllowed(...)`.
- `message_source.authenticity` from the full raw headers, storing the check where `unknown`.
- `sender_check_refresh` (owner only): groups ids per account and folder, one read-only PEEK session per folder through the account queue, UIDVALIDITY guard, in-flight dedup per message id, `force` semantics, the same write fills receipt/crypto and applies the dev/body consequences; log only `sender_check: fetch failed (kind)` with the id.
- `hardenDatabase(db)` called once per load right after `migrate` (1133–1134); `secure_delete: fts option unavailable` logged once when `fts` is false.
- `cleanLinks` setting after `hideQuotes` (601–621), default true.
- `devLinks` cleaned in `bb-rpc.ts` 1364; rule evaluation passes `senderFailed`.

**Tests to write first:**
- [ ] `thread_get` returns the four fields; a failed row's warning summary; lookalike against a seeded Sent recipient.
- [ ] `message_body`: always-show sender with failed / lookalike / unknown → `remoteImagesAllowed: false`.
- [ ] `sender_check_refresh`: PEEK only, one session per folder for 50 ids in two folders, UIDVALIDITY mismatch skipped, stores only where unknown, `force` overwrites, refuses plugin callers, logs only the kind.
- [ ] The server calls `hardenDatabase` (recording fake database).
- [ ] **Canary block** (`server.test.ts` from 5187): `sender_check_refresh`, `thread_get` warnings and the agent line leak no canary into the plugin log, agent log or realtime.
- [ ] `npm run check` → commit.

### Task 8: Keys (part B)

**Files:** `src/ui/shortcuts.ts` (+ `shortcuts.test.ts`), `src/ui/shortcut-sheet.tsx` (+ test), `src/ui/compose-toolbar.tsx` (`modKeyLabel` uses `isMacPlatform`; + test unchanged and green).

**Produces:**
- `ShortcutCommand` gains `select_down`, `select_up`, `message_next`, `message_previous`, `toggle_read`; `next`/`previous` gain `arrow?: true`.
- `isMacPlatform()`; `matchShortcut(event, afterG, { mac })`; `keyZone(target)`.
- `matchKey` order (part B design + resolution 3): IME (`isComposing`, `key === "Process"`, `keyCode === 229`) and typing → null first; Mac chords by `event.code` with exact modifier sets; arrows by zone (arrow-owning roles → null); Shift+arrows; Backspace/Delete → `delete`; existing keys unchanged.
- Repeat rule: only list and header moves repeat.
- `HOST_RESERVED`; `SHORTCUT_SHEET` rows and `mac?: string[]`; the sheet's "On a Mac, Apple Mail keys work too." line, Apple chords shown only on a Mac.

**Tests to write first:** every case in part B "Testing → `shortcuts.test.ts`" plus: `keyCode: 229` → null; arrows inside `[role="tablist"]`/`[role="radiogroup"]` → null; arrows produce `arrow: true`, `j`/`k` do not; Russian-layout chords with `key` written as `\u` escapes. Sheet: Apple chords with `mac: true` only.
- [ ] `npm run check` → commit.

### Task 9: Successor, selection extension and page wiring (part B)

**Files:** new `src/ui/successor.ts` (+ `successor.test.ts`); `src/ui/mail-page.tsx`; `app.test.tsx` for page-level cases that need no `app.tsx` change.

**Produces:**
- `successorRow(rowsBefore, isRemoved, current)`; `extendSelection({ order, base, anchor, to })` (part B resolution 4). The `shownRows` effect uses `successorRow`.
- Mail page: `data-mail-reading` + `tabIndex={-1}` on the Conversation section (1156); `step(delta, repeat, arrow)` and an `onKeyUp` on the root that opens after a held-arrow run (two columns, no selection; one column: cursor only); `select_*`, `message_*`, `toggle_read`; `runAction` passes `then` for a removing action or snooze on the open conversation with no selection; `afterSelection` cursor for selections; `onThreadsAction(ids, action, destination?, then?)`, `inbox.onSnooze(ids, until, then?)`; `drag.onStart` computes the advance and calls `onDragAccounts(accountIds, advance)`.
- The `app.tsx` side is Task 11; until then the extra arguments are ignored (types allow it).

**Tests to write first:**
- [ ] `successor.test.ts`: the part B cases plus `extendSelection` (first press selects two, turning back shrinks, a `base` from `x` kept).
- [ ] `app.test.tsx`: ↓ with nothing open opens the first row and marks it read (`message_open` called); held ↓ (`repeat`) opens nothing until `keyup`; `j` with nothing open opens nothing; Shift+↓ selects two rows; ↓ on a message header moves focus to the next header; Backspace in the search field, the composer and the Move… dialog filter calls no RPC.
- [ ] `npm run check` → commit.

### Task 10: UI for part A

**Files:** `src/ui/sanitize.ts` (+ test), new `src/ui/trackers.ts` (+ test), `src/ui/print.ts` (+ test), `src/ui/message-frame.tsx` (+ test), new `src/ui/link-status.tsx` and `src/ui/sender-warnings.tsx` (+ tests), `src/ui/reading-pane.tsx`, `src/ui/mail-page.tsx` (status line placement, Details block wiring), `src/ui/composer.tsx` / `src/ui/presend-dialog.tsx` and `src/ui/agent-send-card.tsx` (the new issue), `src/ui/mail-settings.tsx` (`cleanLinks`), `app.tsx` (`openLink` choke point, refresh call, settings), `app.test.tsx`.

**Produces:**
- `sanitizeEmailHtml({ ..., cleanLinks })`: hrefs rewritten through `cleanLink`, `data-mk-cleaned`/`data-mk-unwrapped` marks; trackers removed in allowed mode and counted in both; `blockedRemoteImages` excludes trackers; comment at 436–437 corrected. `htmlToPlainText` cleans `<url>`s.
- `print.ts` uses the non-tracker blocked flag.
- `message-frame.tsx` `handleLoad`: click/auxclick report `{ href, text }`; hover/focus report for the status line; all removed by `detachRef`. Image bar: tracker count, "not loaded automatically because …" text, no **Always show** for a gated message.
- `link-status.tsx`: sticky status line at the bottom of the Conversation section; the dialog (vendored `dialog.tsx`) per part A resolution 10.
- `sender-warnings.tsx`: strip and lines, values in code-like spans, no links.
- `reading-pane.tsx`: `remoteImages` gate with `autoImagesAllowed`; crypto chip, encrypted and opaque-signed placeholders; receipt line; Details Authenticity block with **Check again** (`force`).
- `app.tsx`: `openLink({ href, text })` → `cleanLink` (null → refuse) → dialog → `navigate.openUrl(clean.url)`; PDF, alert and dev links pass `text: null`; `sender_check_refresh` for expanded `unknown` messages after 600 ms open (part B I3; timer cleared on thread change); refresh result reloads the thread headers.
- Pre-send line in the composer's "Before you send" and on the agent send card.

**Tests to write first:**
- [ ] `sanitize.test.ts`: cleaned hrefs and marks; incoming `data-mk-cleaned` stripped; tracker counts in both modes; trackers-only → no Show images; quote + pixel decides as without the pixel; `tracker.example.org/pixel.gif` fixture still kept in allowed mode; plain view cleaned.
- [ ] `print.test.ts`: printed and saved page hrefs cleaned; remote-image note uses the non-tracker flag.
- [ ] `message-frame.test.tsx`: hover reports `{ href, text }`; status clears on mouseout and new `srcDoc`; one listener of each kind after reload.
- [ ] `app.test.tsx`: `cleanLink` null → `openUrl` not called; deceptive link → dialog, Cancel opens nothing, Open opens the cleaned URL; listed tracking host → no dialog; always-show sender with failed / lookalike / unknown message loads no images and hides Always show; **Show images** still loads; Details shows Authenticity and **Check again** calls `sender_check_refresh` with `force`; arrow-free open of an old message calls the refresh once after 600 ms, not when another conversation opens first; receipt line; encrypted placeholder; pre-send line.
- [ ] `npm run check` → commit.

### Task 11: App flow, frame forwarding, stack and composer (part B)

**Files:** `app.tsx`, `src/ui/message-frame.tsx` (+ test), new `src/ui/conversation-stack.ts` (+ test), `src/ui/reading-pane.tsx`, `src/ui/mail-page.tsx` (stack state beside `quotesAll`, load-whole-conversation opening), `src/ui/composer.tsx` (+ test), `app.test.tsx`.

**Produces:**
- `threadsAction` / `snoozeThreads` run `then` where they call `closeThread()` today, only when `latest.current.reading.threadId === snapshot.threadId`; `dropThreads` passes the drag advance ref; `reopenByUndo` map and the reopen after undo (wait for the row up to `MOVING_BACK_MAX_MS`; cancelled by any owner open/close).
- `message-frame.tsx`: `keydown` forwarder in the same `handleLoad`/`detachRef` as Task 10's listeners; not for Enter, Space, Tab, arrows, Page Up/Down, Home, End; drops IME and typing-target keys; parent-realm `KeyboardEvent`.
- `conversation-stack.ts`: `splitConversation(messages, { anchorIds, expandedIds, open })`, `stackSummary(messages)` (names via `addressLabel`, address for a `name_shows_address` message, "· sender warning" marker).
- Reading pane: anchors captured on first render per thread; the stack button (`data-mail-stack`, `aria-expanded`, `aria-controls`), focus to the first revealed header; `data-mail-message-toggle` on headers; no stack in the single-message view.
- Mail page: `stackOpen` `{ threadId, open }` beside `quotesAll`; Expand all opens, Collapse all closes; a finished "Load the whole conversation" that added messages opens it.
- Composer: ⇧⌘D on a Mac sends through `send()`.

**Tests to write first:** every `app.test.tsx` case in part B "Testing" (Backspace opens below / above / empty state; failed action keeps it open; another conversation opened meanwhile stays; search hit successor; selection of three → cursor only; undo via toast and `z` reopens, not after another open; ⌘N not prevented; the six-message stack, click, `;`, Collapse all; citation into the stack; print with a closed stack prints six; key in the frame runs the hotkey, a key in a field does not) plus: drag of the open conversation to a folder opens the successor; Enter on a focused link in the frame opens the link only (no row opens); a stacked message's warning shows as the marker; `conversation-stack.test.ts` cases from part B; composer ⇧⌘D with `mac: true` sends, without it does not.
- [ ] `npm run check` → commit.

### Task 12: Docs, listing and pins

**Files:** `plugins/mail/README.md`, `PLUGIN_OVERVIEW.md`, `package.json` (`description` / `bb.description`), root `marketplace.json` (the mail entry only, and only if the one-line description changes), `skills/mail/SKILL.md`, `CHANGELOG.md`, `docs/mail-feature-backlog.md`, `src/adapters/bb/sqlite-store.test.ts` (pin).

**Steps:**
- [ ] **README "Security and privacy"**: what the sender check reads (provider results only, trusted ids, Gmail; iCloud after the live pin; others Not checked), its limits (`orgDomain` heuristic, forwarders and lists can fail DMARC, the residual risk of a provider not stripping forged A-R), what a failed or disguised sender stops, trackers and their limit (style-hidden images), link cleaning, the dialog rule and the tracking-redirect note, the `cleanLinks` setting, read receipts never sent, signed/encrypted recognised only (3k for the rest), `secure_delete` and what it does not cover (WAL, backups, BB's files, and the FTS index if the option is unavailable), the shell-limit list gains `sender_check_refresh`.
- [ ] **README hotkeys**: arrows, Shift+arrows, Backspace/Delete, Apple chords on a Mac, what is not bound and why, arrows open and mark read (one column: cursor only), the next conversation opens after the B5 actions only (list them), undo reopens, the stack.
- [ ] **Listing and skill**: `bb.description`, `PLUGIN_OVERVIEW.md` and `marketplace.json` change together or not at all. `SKILL.md`: the "Sender check" / "Sender warning" lines are Mail's header-block lines only; a body sentence claiming a check is the sender's; Mail never prints a positive result; encrypted placeholder.
- [ ] **Backlog**: 39, 40, 72 `[уже есть]` with "Срез 3i"; 92 and 97 `[позже]` with "распознавание — срез 3i; подпись и шифрование — срез 3k"; 93 `[позже]` with "затирание удалённого — срез 3i"; 15 and 54 gain "Срез 3i (часть B)"; the header's date line.
- [ ] **Pin**: `MIGRATIONS.slice(0, 15)` with the SHA of element 14 added.
- [ ] **Escapes**: `grep -nP '[^\x00-\x7F]'` over every `.ts`/`.tsx` file 3i touched; only deliberate prose may remain (none expected in `src/core`).
- [ ] **Build checks**: `npm run check`, `npm run build`, `node ../../scripts/check-manifests.mjs`. Record `dist/app.js` and `dist/server.js` sizes before and after.
- [ ] Commit (`docs(mail): 3i — …`).

### Task 13: Live check in the owner's BB — **owner-run**

Only the owner runs this, after the build and after deciding to load it. Agents prepare the checklist and record the results the owner reports; no agent installs the plugin or reads the owner's mail.

- [ ] Part A live steps 1–7 (iCloud authserv-id pinned from a header name and id only, then a code commit; Gmail pass in Details; foreign Reply-To; trackers; links incl. a Google `/url?q=` link and a newsletter's tracking redirect with no dialog; a receipt request; signed mail if available; an old message fills its check).
- [ ] Part B live steps 1–6. Step 1 decides ⌘R / ⇧⌘R / ⌘Z (part B resolution 10); step 6 also records whether arrow keys in a clicked message body scroll the pane.
- [ ] Record whether the FTS `secure-delete` option took (`secure_delete: fts option unavailable` absent from the log).

---

## Batches for implementation agents

Each batch is one implementation agent working through its tasks in order and committing per task. A batch starts only after the previous batch's commits are in (one worktree, one branch, other sessions commit here too). A Fable verification agent reviews each batch before the next starts.

| Batch | Tasks | Why together |
| --- | --- | --- |
| A | 1, 2 | Pure core, no I/O; Task 2's link and disguise checks use Task 1's `orgDomain`. |
| B | 3, 4 | Contract, model, ports and fakes, then the store and migration 14 that implement them. |
| C | 5, 6, 7 | Gateway and sync, the core text renderers and pre-send input, then every server change. The only batch that edits `server.ts`. |
| D | 8, 9 | Part B keys and the page wiring that uses them (`shortcuts.ts`, `successor.ts`, `mail-page.tsx`); touches none of the big shared files except `mail-page.tsx`, which only Batch F edits again, later. |
| E | 10 | Part A UI: the batch that edits `sanitize.ts` and first edits `app.tsx`, `reading-pane.tsx` and `message-frame.tsx`. |
| F | 11 | Part B app flow, frame forwarding and stack: the same big files after E, strictly sequential (interactions I1, I11). |
| G | 12 | Docs, listing, pins and the final build checks. |
| — | 13 | Owner-run. No agent. |

Batch D depends only on Batch A's exports being stable (it imports nothing new from B or C) and may run right after A if the session lead wants; it must still finish before E starts, because E and F rebase their `mail-page.tsx` edits on D's.

## Commands

From `plugins/mail`:

- `npm run check` — typecheck and tests, after every task.
- `npm run build` — `bb plugin build`, in Task 12 (and any task that wants a build sanity check).
- `node ../../scripts/check-manifests.mjs` — in Task 12, and in any task that touches `package.json`, `PLUGIN_OVERVIEW.md` or `marketplace.json`.
- `grep -nP '[^\x00-\x7F]' <files>` — before each commit, on the task's `.ts`/`.tsx` files.

## Implementation notes: Batches A and B (Tasks 1-4)

Deviations from the text above, and why. Later batches build on these.

- **`SenderCheck` carries more than the spec's shape**: `basis` (`results` / `no_results` / `provider` / `own`), `decidedBy`, `otherDmarc` (DMARC for another domain, Details only), `multipleFrom`, `malformed`, `alsoPresent`. `readStoredCheck` re-reads as `unknown` only a stored `unchecked` with `basis: "provider"` (the preset trusted no id then) once the preset trusts one; the literal rule ("`unchecked` with `authserv: null`") would have made every Gmail Sent copy and every Gmail message without a trusted A-R `unknown` forever, refreshed on each open.
- **DMARC answers**: only `pass` and `fail` decide; `none`, `neutral`, `temperror`, `permerror` fall through to the SPF-fail and aligned-DKIM rules. Result words outside RFC 8601's set (`bestguesspass`) read as `neutral`. A value over 4 KB is cut, more than 20 entries are cut, and an open quote or comment marks the header `malformed`; a malformed header is never `ok`. Quoted strings are tracked inside comments too.
- **Optional until Batch C wires them**: `RuleRow.senderFailed`, `PresendInput.replyToElsewhere`, `PrepareContext.folderRole`. Batch C should pass them on every path (and may make them required).
- **`reply_to_elsewhere`** is checked against all recipients (`PresendInput.recipients`, To/Cc/Bcc; the input has no To-only list) and sits after outside/new, before BB files. Its zod variant, the dialog line ("Reply-To differs from the sender: …") and the composer's Fix (marks the addresses, like `outside_conversation`) landed in Task 2, because the RPC schemas and the dialog's exhaustive switch would not typecheck otherwise. Task 10 still owns the agent send card line.
- **Header types**: `MessageHeader` keeps the four 3i fields optional (`MessageHeaderView` is the full parsed type) and `ThreadDetail.messages` is `MessageHeader[]`, so fixtures and fakes compile without churn. Page code must read them with a default (`header.senderCheck ?? { state: "unknown", summary: null }`, `?? []`, `?? false`, `?? null`).
- **`crypto` in the header view** is `{ kind, opaque } | null`. The `messages.crypto` column stores the kind, with `smime_signed_opaque` for S/MIME signed-data.
- **Server stubs**: `message_source.authenticity` has a zod default (`{ authserv: null, lines: [] }`); `sender_check_refresh` is registered in `server.ts` as an owner-only refusal ("not available yet") until Task 7 replaces it.
- **Store port**: the three `MailStore` methods landed in Task 4's commit (SQLite has to implement them in the same commit). `knownDomainList` returns organizational domains. `writeSenderCheck` gains an optional `guard: { uidValidity }` (attached row, folder's stored UIDVALIDITY); "unknown only" means `sender_check_json IS NULL`, so the server passes `force` for a stored check that reads `unknown` (the re-pinned case). Receipt and crypto fill where NULL, or over with `force`.
- **Backstops in the store**: an upsert never stores an encrypted body (and a refetch that did not judge crypto does not bring one back); a failed check on upsert clears the dev class even when the fetch carried one; `attachmentTextStatus().pending` excludes encrypted rows like the candidates.
- **Settings**: there is no core settings schema; `cleanLinks` stays with Task 7 (`server.ts`) and Task 10 (`mail-settings.tsx`).
- **Contract test**: the key walker now looks through zod defaults, so defaulted fields are checked too.
- **Receipts**: the source scan lives in `receipts.test.ts` (headers named only in `receipts.ts` and its test); `SECURITY_HEADER_FIELDS` spreads `RECEIPT_HEADERS` to keep it so.
- **Links**: with `cleanLinks` off nothing is removed or unwrapped, but the checks still judge a known wrapper's own target (no false "says X but opens google.com"). `hostMixesAlphabets` is exported from `sender-disguise.ts` for `link-clean.ts`.
- **Tracker lists** (`src/core/trackers.ts`): `TRACKER_HOSTS` = `.ct.sendgrid.net`, `.list-manage.com`, `mandrillapp.com`, `.exct.net`, `.rs6.net`, `.awstrack.me`, `.mjt.lu`, `r.superhuman.com`, `mailstat.us`, `t.yesware.com`, `mailtrack.io`. `TRACKING_REDIRECT_HOSTS` = `.ct.sendgrid.net`, `.list-manage.com`, `mandrillapp.com`, `.exct.net`, `.rs6.net`, `.awstrack.me`, `.mjt.lu`, `.hubspotlinks.com`, `.createsend1.com`, `t.yesware.com`. Criteria in the file's comment; neither lists an `example` host or a path shape.

## Implementation notes: Batch D (Tasks 8-9)

- **Key map as bound** (`src/ui/shortcuts.ts`). All platforms: Down/Up (page zone: `next`/`previous` with `arrow: true`; on `[data-mail-message-toggle]`/`[data-mail-stack]`: `message_next`/`message_previous`; inside `[data-mail-reading]` or an arrow-owning role: null), Shift+Down/Up (`select_down`/`select_up`, page zone only), Backspace and Delete (`delete`, no Shift). Mac only, exact modifier sets by `event.code`: Cmd+R reply, Shift+Cmd+R reply all, Shift+Cmd+F forward, Ctrl+Cmd+A archive, Shift+Cmd+J spam, Shift+Cmd+U `toggle_read`, Shift+Cmd+L flag, Opt+Cmd+F search, Ctrl+Cmd+M move, Cmd+Z undo, Cmd+Backspace delete. Every Gmail key unchanged. `HOST_RESERVED` lists 48 BB chords (the owner's list plus the rest of the part B table: Shift+Cmd+P/O/T/[/]/E/X/C/M, Cmd+,/\/L/./Enter, Shift+Cmd+Enter, Opt+M/P/T, Ctrl+Cmd and Shift+Ctrl+Cmd arrows, Escape); a test pins each to null on both platforms.
- **`matchShortcut(event, afterG, platform = { mac: false })`**: the platform argument defaults to "not a Mac" so old callers and tests stay deterministic; `useShortcuts` reads `isMacPlatform()` once. `isMacPlatform(platform?)` keeps `compose-toolbar.tsx`'s wider rule (`mac|iphone|ipad|ipod`), so `modKeyLabel` is unchanged in behaviour.
- **Sheet**: the "On a Mac, Apple Mail keys work too." line shows on every platform; the chords (rendered "or ⌘R") and the Mac-only row "Mark read or unread" (Shift+Cmd+U) show only with `mac`. New rows: Down/Up open, Down/Up on a header, Shift+Down/Up, "Delete, as #" (Backspace, Delete). The composer's Shift+Cmd+D is **not** on the sheet yet: Task 11 binds it and adds `mac` to the "Send (in the composer)" row (the `HOST_RESERVED`/sheet test then expects 12 chords).
- **Selection after a removing action (B6)**: `afterSelection` is consumed by the first change of the rows (a failed action leaves nothing stale); it moves the cursor only when one of the removed rows is gone. The existing test "hotkeys work after the bar's Delete clicked with the mouse" now expects the cursor on the row after the removed one (so `j` moves on from there), as B6 says.
- **Shift+arrow run** starts from the cursor row (the first row when there is none) and ends on any other command, a row click or a checkbox; it restarts when the selection no longer holds its anchor.
- **`toggle_read`** treats the open conversation as read (it was marked read on open), so on it Shift+Cmd+U marks unread; selected and cursor rows use the list's `unreadCount`.
- **Not done here (needs reading-pane.tsx, Batch F)**: the `app.test.tsx` case "Down on a message header moves focus to the next header" — the headers get `data-mail-message-toggle` in Task 11; `focusMessage` in `mail-page.tsx` already queries `[data-mail-message-toggle], [data-mail-stack]` inside the Conversation section (`conversationRef`).
- **For Batch F (`app.tsx`)**: the page now calls `onThreadsAction(ids, action, destination, then)` with `then: (() => void) | null` only for a removing action (`REMOVING_ACTIONS`, incl. `not_spam`) on the open conversation with no selection — `destination` may be `undefined` in that call; `null` means "nothing left, show the empty state" (close as today). `inbox.onSnooze(ids, until, then)` likewise (from the snooze menu). `slice3h.onDragAccounts(accountIds, advance)` passes `advance` (or null) at drag start; keep it in a ref, hand it to `threadsAction` from `dropThreads`, clear it on drag end (`onDragAccounts(null)`). `then` sets the page cursor and calls the page's `openRow` from the render the action started in (search hits keep their hit). Run it where `closeThread()` runs today and only while `latest.current.reading.threadId === snapshot.threadId`; record `reopenByUndo` there.

## Implementation notes: Batch C (Tasks 5-7)

- **`PrepareContext.folderRole` is required now**; `syncFolder` passes `folder.specialUse`, the 3h jobs pass the role of the folder each fetch lands in (`fetchInto` looks it up; the account context is `Omit<PrepareContext, "folderRole">`). `RuleRow.senderFailed` and `PresendInput.replyToElsewhere` stay optional in the types (22 rule fixtures, many pre-send fixtures); every production caller passes them.
- **`prepareMessage`** judges the sender check only when the fetch read headers (`unsubscribeHeaders` present) and crypto only when `contentType` is present (the gateway sets both together, `contentType` capped at 2 048 characters); a fetch without headers leaves the stored values alone. A failed check returns `dev: null` before classification, whatever `classifyDev` says.
- **`src/core/sender-view.ts`** (new, pure over the store port): `securityViews` (stored check through `readStoredCheck`, summary, warnings computed at read time, none for a Sent or Drafts copy), `replyToElsewhereOf` (builds the known set only when the source has a Reply-To; takes a set or a thunk), `failedSenderIds` (the agent Inbox marker and rule evaluation), `knownDomainsOf`.
- **Agent line wording**: "Sender check: failed"; "Sender warning: reply-to elsewhere, lookalike domain, mixed alphabets, name shows another address" (only the kinds present, comma-joined, fixed order); both together read "Sender check: failed; sender warning: …". `ENCRYPTED_PLACEHOLDER` is exported from `agent-text.ts`. `taskText` gained an optional `security` (the line after "From mail:"); thread, rule and incident prompts get the line through the renderer. `InboxEntry.senderFailed` is required.
- **Server** (`src/adapters/bb/sender-checks.ts`, new): the known-set cache, `secure(headers)`, `refresh`, `fromRaw`. Header views reach `thread_get`, every agent read (`readForAgent` takes a `secure` function), the CLI read, mentions, Hand to agent, and BB text through `BbRpcDeps.security` / `RuleDeps.security` (optional in the type, passed by the server). `message_body` computes the view only when the stored rule allows images. `sender_check_refresh` counts a row not written (gone, detached, UIDVALIDITY changed, not returned) as `failed`; ids already in flight and rows not `unknown` (without `force`) are dropped silently and counted nowhere. It publishes `mail-changed` for an account where it wrote. `message_source.authenticity` judges the full header block filtered like the gateway (unsubscribe names plus provider trace prefixes, no 64-line cap) and writes without a guard (the raw fetch was UIDVALIDITY-guarded).
- **Known set staleness**: marked stale by an outbox row reaching `done` and by a round whose inserted rows include a Sent-role row (a failed lookup marks it stale too, without a log line, so only resolution 18's two lines exist).
- **Logs**: `sender_check <id>: fetch failed (<kind>)`, one line per failed folder group naming its first id; `secure_delete: fts option unavailable` when `hardenDatabase` reports `fts: false` or throws.
- **FTS `secure-delete`**: took on the test SQLite (better-sqlite3 in `node_modules`); the server test asserts the log line is absent and the pragma reads back 1. The host BB's SQLite is still unverified (live step).
- **Tests changed on purpose**: "images allowlist round trip" now seeds a judged (unchecked) row, since an `unknown` row no longer auto-loads (resolution 5); the 3g dev-link fixture's issue link carries `utm_` parameters that `thread_get` must drop.
- **Server tests and the AI scope**: a second `createSqliteStore` on the plugin's connection resets the in-memory AI scope; the 3i canary test writes its rows with raw SQL for that reason.
- **For Batch E**: the page reads `header.senderCheck`, `warnings`, `receiptRequested`, `crypto` (defaults as in the B notes), calls `sender_check_refresh({ messageIds })` for expanded `unknown` messages after 600 ms, and `{ messageIds: [id], force: true }` for Details' Check again, then reloads the thread. `message_source` now returns `authenticity`. The `cleanLinks` setting is declared in `server.ts` (default true, label "Remove tracking from links I open"); `mail-settings.tsx` still needs its line.

## Implementation notes: Batches E and F (Tasks 10-11)

- **Zod stays out of the page bundle**: `sender-check.ts` reaches zod through `unsubscribe.ts` and `agent-propose.ts`, so the page could not import `cleanLink` or `autoImagesAllowed` through it. New `src/core/sender-basics.ts` holds `asciiDomainOf`, `addressDomain`, `orgDomain`, `autoImagesAllowed` and `SenderCheckState` (no zod chain); `sender-check.ts` re-exports them, and `link-clean.ts` and `sender-disguise.ts` import them from there. UI and `app.tsx` import these core modules directly, never `core/index.ts` for values. `dist/app.js` has no zod (2 699 716 bytes before E, 2 724 139 after F).
- **Link dialog's known domains**: the page receives no known-domain set. `openLink` builds one from the owner's account domains and the `like` domains of the open thread's `lookalike` warnings (those are the server's known domains), so a link to a lookalike of a domain the owner writes to is caught when the thread itself carries such a warning; other lookalike links rely on the sender-side warning. `openLink(url, text?)` keeps a positional signature (PDF, alert and dev links pass no text); refused links toast "This link cannot be opened here.".
- **Sanitizer**: `cleanLinks` is opt-in (`false` when absent) so reply and forward quoting keep the original links (part A resolution 20); the frame, print, the plain view and the saved page pass the setting. Link cleaning is a post-pass over the sanitized body (not a DOMPurify hook). Trackers (`ui/trackers.ts`, https remote images only) are removed in both modes, never counted in `blockedRemoteImages`.
- **Images gate**: `imagesHeldReason` in `sender-warnings.tsx`. The bar's "not loaded automatically because the sender check has not run yet" shows only for a sender the page knows is allowed (the server does not say when it gated its own always-show rule); failed, lookalike and name-shows-address always say why and hide Always show.
- **Refresh**: one effect in `app.tsx`: expanded `unknown` messages, 600 ms after the last change of the open thread or its expanded set, each id once per page session (also after a failed call); a result with `refreshed > 0` reloads the thread and re-fetches those bodies in place. Details' Check again sends `force`, reloads the thread and the Details source.
- **Status line**: rendered by the reading pane (sticky at the bottom of its root inside the Conversation scroll area), state keyed by thread; the frame reports `{ href, text, removed, unwrapped }` from the `data-mk-*` marks.
- **Successor and undo**: `advanceOrClose` in `app.tsx` runs `then` only while the open conversation is the one the action started on and records `reopenByUndo` under the undo id (only when the action was undoable). A pending reopen waits for the row in `list.threads` up to `MOVING_BACK_MAX_MS` and is cancelled when the open conversation is no longer what it was at undo time. The cursor is not moved when nothing reopens (the page owns the cursor).
- **Stack**: anchors are recorded in pane state on the first render with a detail (newest, expanded, unread); the stack exists only with the 3h reading port (always in the app). "Load the whole conversation" opens the stack when the first thread load after the job ends has more messages than when it started.
- **Tests changed on purpose**: "Always show allows the sender, then shows the images" uses a judged (`unchecked`) sender; "Spam moves the folder's messages…" now expects the next conversation to open; "the message star toggles that message only" opens the stack first (two earlier read messages).
- **Not covered by an app test**: the citation chip into the stack (the boundary rule is in `conversation-stack.test.ts`; `cite` expands before highlighting, unchanged).
- **For Batch G**: README needs the status line, the dialog rule, trackers (and the style-hidden limit), the images "not loaded automatically" reasons, Check again, the stack, frame key forwarding, Shift+Cmd+D and the B5 action list (Archive, Delete, Spam, Not spam, Move, snooze, drag to a folder). The sheet's "Send (in the composer)" row now has `mac: [SHIFT, CMD, "D"]` (12 chords). Pin `MIGRATIONS.slice(0, 15)`.
