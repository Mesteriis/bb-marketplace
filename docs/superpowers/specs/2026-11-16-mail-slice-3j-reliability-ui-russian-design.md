# Makosh Mail — slice 3j: reliability, UI and Russian (big mailboxes and a windowed list, outbox retry, sync status, account diagnostics, backup, list density and pane position, the interface in Russian)

Status: builder's design, **awaiting the owner**. Every decision below is
marked *Proposed (owner to accept)* with a safe default; the open questions
at the end are compact and each has a recommended answer.

It follows 3a–3h and 3i (parts A and B), all on `feat/mail-imap-slice`.
Everything in the earlier specs holds unless this document changes it, and
their "Resolutions" sections are the binding form. In particular: nothing is
ever expunged except 3b's `expungeOwn`; every server fetch is `BODY.PEEK`;
3f's AI scope, redaction, untrusted framing and content-free agent log hold;
owner writes refuse plugin callers (`refusePluginCaller`); 3g's "no BB
patches, no host entry"; 3h's "no search words, folder, label or file names
in logs"; 3i's "warnings are fixed text, values shown as data", letters in
hotkeys match `event.code`, and "nothing resends on its own" — which 3j
changes only for the narrow case in decision 6. The owner's direction holds:
Mail fits into BB's own interface, BB is not patched, Tauri is not now.

Backlog (`docs/mail-feature-backlog.md`), checked on 2026-11-16 against the
file and the code. Groups "Надёжность и производительность" and "Настройки
и UX" (the backlog has no separate localisation group; #53 is in "Настройки
и UX"), every item that is not `[уже есть]`, plus #74 and #76, which the 3h
spec moved here (3h spec rows 40–41, resolution 22). No other spec defers
anything to "3j" by name (`rg -i 3j docs plugins/mail`).

| # | Item | Label now | Done today | In 3j |
| --- | --- | --- | --- | --- |
| 74 | List virtualization, big mailboxes | кандидат | keyset paging (`threads_list`, `messages_list`), Load more, store timing tests at about 6 000 rows (`sqlite-store.test.ts` 795–848) | yes: store and indexes checked at 50 000 rows, rethreading made incremental, a windowed list with scroll loading |
| 38 | Outbox with retry | кандидат | outbox, **Retry** / **Send again** by click; "Nothing resends on its own" (README 196) | yes: automatic retry of sends that never reached the server, within a window |
| 48 | Sync and error status | кандидат | "Synced …" label, a red `lastError` banner per account, **Update app password** (`mail-page.tsx` 1177–1232, 1839–1845) | yes: structured problems, a quiet offline state, a status panel |
| 75 | Account diagnostics | кандидат | no | yes: `bb makosh-mail doctor` (owner's terminal) |
| 94 | Backup and export | позже | `.eml` of one message (#31) | **partial (proposed)**: `bb makosh-mail backup <file>` (owner's terminal); mbox export stays `[позже]` |
| 76 | List density and pane position | кандидат | one density; reading pane right of the list | yes: compact / comfortable, pane right / bottom |
| 53 | Interface in Russian | кандидат | none: every label is English; dates follow the system locale (`toLocale…(undefined, …)`) | yes: an English/Russian catalog for the page, plurals and dates |

Points the builder could not verify are marked **[unverified]** and collected
in "Not verified" at the end.

## Owner's decisions

All *Proposed (owner to accept)*. Each has the safe default the builder
would ship if the owner says nothing else.

1. **Scope of 3j:** #74, #38, #48, #75, #76, #53 in full; #94 partly
   (database backup only). *Proposed (owner to accept).* These need no keys,
   no accounts and no owner action outside the code; none goes to 3k (3k
   stays PGP and S/MIME, 3i decision 2).
2. **No new dependency.** The windowed list is Mail's own small hook; plurals
   and dates use the `Intl` built-ins; the catalog is plain TypeScript.
   *Proposed (owner to accept).* `@tanstack/react-virtual` and `react-window`
   are not in `node_modules`; `@tanstack/query-core` and `react-query` are
   there (host SDK), which do not help. A library would only save about
   150 lines and would add a supply-chain entry for a hot UI path.
3. **Rethreading becomes incremental** (#74). A sync round that inserted,
   removed or re-homed no row skips rethreading; a round that did rebuilds
   only the threads whose membership changed. *Proposed (owner to accept).*
   Today every round, including each IDLE Inbox-only round, reads every row
   of the account, deletes all its thread rows and writes them again
   (`sync.ts` 261 and 303 → `sqlite-store.ts` `threadingInputs` 3522,
   `assignThreads` 3551, `refreshThreads(accountId, null)` 2373–2399). The
   store and the BB server share one thread, so at tens of thousands of rows
   this blocks the server for every round. The full rebuild stays as a
   repair path (`doctor --repair-threads`, decision 9).
4. **The list renders a window of rows once it holds more than 200** (#74),
   and loads the next page when the owner scrolls near the end; **Load
   more** stays as the fallback. Below 200 rows nothing changes.
   *Proposed (owner to accept).* The focused row, the open conversation and
   the checked rows are always rendered, so keys, selection and drag keep
   working.
5. **The store is measured at 50 000 messages** per account (two accounts,
   100 000 rows) behind an opt-in test, and at 20 000 inside `npm run
   check`. *Proposed (owner to accept).* Budgets are the existing `PAGE_MS`
   (250 ms per page call) and a new `ROUND_MS` (250 ms) for the store work of
   one no-change round.
6. **Automatic retry, only for sends that never reached the server** (#38):
   SMTP kinds `connect`, `timeout_before_data` and `temporary` (4xx), and
   only when the account has an SMTP server. Backoff 1, 2, 5, 10, 15, 30
   minutes, then every 30 minutes, for **24 hours** after the owner pressed
   Send; then the row becomes **Not sent** as today. A successful sync round
   of the same account (the network is back) makes its waiting sends due at
   once. `tls`, `auth`, every rejection and `unknown_after_data` never
   retry. *Proposed (owner to accept); window in open question 2.* No
   message can arrive twice: none of these kinds can follow an accepted
   DATA (`smtp-transport.ts` `mapSendError` 88–111).
7. **Sync problems are stored as codes** (#48, #53): each account keeps a
   short structured list (`sync_problems`, migration element 15) next to
   the English `lastError` text, which stays as it is for the CLI and agents.
   The page renders the codes in its language. *Proposed (owner to accept).*
8. **Network failures are quiet for 30 minutes** (#48). A round that fails
   only with a network code shows a muted "Offline · synced 10:42" in the
   header instead of the red banner; after 30 minutes of failures, or for
   any other problem (password refused, credential unreadable, TLS, dropped
   or returned moves, a folder that failed), the banner shows as today.
   *Proposed (owner to accept).* A laptop going to sleep or changing Wi-Fi
   should not paint the page red.
9. **`bb makosh-mail doctor [accountId]`** (#75) runs in the owner's
   terminal only, like `remove`; it prints fixed checks and codes, never
   server text. Option `--repair-threads` runs the full rebuild of
   decision 3. *Proposed (owner to accept).* It opens a login, so an agent
   could otherwise use it to probe the account's server.
10. **`bb makosh-mail backup <file>`** (#94 partial) writes a consistent copy
    of the plugin's database with SQLite's online backup, owner's terminal
    only, to a path that must not exist yet. *Proposed (owner to accept);
    open question 4.* The copy holds mail in plain text and passwords
    sealed under `vaultKey`, which is not in the file. README says how to
    restore (stop BB, replace `data.db`). mbox export stays `[позже]`.
11. **Density and pane position are two BB settings** (#76):
    `listDensity` (`comfortable`, default; `compact`) and `readingPane`
    (`right`, default; `bottom`), also switchable from a **View** menu on
    the page, which writes the same settings through one owner-only RPC.
    *Proposed (owner to accept).* The bottom pane has a fixed split (list
    40 %, at least 8 rows); a draggable splitter is later.
12. **Russian through an English-keyed catalog in the page** (#53).
    Source strings stay English and are the keys (`t("Load more")`); a
    Russian table maps them, with plural forms. The server and every agent
    surface stay English; the page also translates the server's fixed
    refusal texts it shows, by the same keys. *Proposed (owner to accept).*
    No string ids to invent, the English UI keeps working with no table,
    and a test proves the table is complete.
13. **Setting `language`: `auto` (default), `ru`, `en`.** `auto` follows
    the system language BB reports to the page (`navigator.language`): `ru…`
    gives Russian, anything else English. *Proposed (owner to accept); open
    question 1.* Dates and numbers follow the chosen language, not the
    system locale, so a page is never half one, half the other.
14. **Untranslated on purpose:** BB settings labels (`server.ts`
    `defineSettings`, rendered by BB's own English settings page), the CLI,
    the `mail` skill, agent tool texts and agent text, log lines, search
    operators (`from:`, `has:`…), and mail content. *Proposed (owner to
    accept).* Text that agents and BB read stays one language; the owner's
    page speaks his.
15. **Mail that goes out does not change language** in 3j: `Re:`, `Fwd:`,
    the attribution line ("On …, X wrote:") and the forwarded-message block
    stay as today. *Proposed (owner to accept); open question 3.*
16. **One migration element (15)**, appended; element 15 joins the SHA pin.
    *Proposed (owner to accept).* Elements 0–14 stay frozen.

## Goals

1. The store answers in budget at 50 000 messages per account; a sync
   round that changed nothing costs no rethread (#74).
2. The list stays responsive with thousands of loaded rows and loads more
   on scroll (#74).
3. A send written without a network goes out when the network is back,
   without any risk of a second copy (#38).
4. The owner sees, per account, when mail last synced, when it syncs next,
   whether instant mail is live, and what failed, in his language; a short
   offline spell is quiet (#48).
5. One command tells the owner what is wrong with an account and the
   database (#75), and one makes a backup (#94 partial).
6. Compact or comfortable rows, reading pane right or below (#76).
7. The whole Mail page, its dialogs, toasts and the mail rail in Russian,
   with Russian plurals and dates (#53).

## Non-goals (later or backlog)

- mbox or `.eml` archive export of folders or accounts (#94 rest): it
  fetches every original from the server; stays `[позже]`.
- Restore from a backup inside Mail; scheduled backups.
- A draggable splitter, a resizable list column, a one-line table list
  ("classic" columns From | Subject | Date).
- Translating BB's settings page labels, the CLI, the skill, agent texts or
  logs (decision 14); other languages than English and Russian.
- Russian-aware search: е/ё folding, stemming, Russian aliases for search
  operators (proposed for later, see "Items proposed for another slice").
- Retrying `unknown_after_data` or a TLS failure automatically; resending
  anything the server may have accepted.
- Push notifications of sync problems (BB notifications); a sync history
  log in the page.
- Keeping more than one page's worth of conversations fresh by other means
  than today's refresh (decision in "Windowed list", point 6).

## Anti-goals

- **A second copy of a message.** Automatic retry only for kinds that
  cannot follow an accepted DATA; the 24-hour window is counted from the
  owner's Send, never extended by itself.
- **Server or mail text in the status, the doctor or the logs.** Codes,
  counts and folder names (already shown today) only; no IMAP or SMTP
  response text, no addresses besides the account's own, no subjects.
- **A BB patch or host entry** for i18n, layout or status (owner's
  direction). The SDK has no locale API (see facts), so the page decides
  the language itself.
- **A half-translated page.** A key without a Russian entry fails the test;
  the page never mixes Russian labels with English dates.
- **A layout that loses keyboard or screen-reader behaviour** to gain
  speed: windowing keeps DOM order for rendered rows, `aria-setsize` /
  `aria-posinset`, focus and the 3i part B keys.
- **A backup or doctor run from an agent thread.** Both refuse there, like
  `remove`.

## Design

### Code, SDK and host facts this design relies on

Line numbers are in the current tree (`plugins/mail/…`, HEAD `f2875cf2`)
unless marked "sdk" (`node_modules/@get-bb/plugin-sdk/bundled-types/…`, SDK
0.6.132; `app` = `bb-plugin-sdk-app.d.ts`, `server` = `bb-plugin-sdk.d.ts`).

| Fact | Where |
| --- | --- |
| No locale, language or i18n API in the SDK: `rg -i "locale\|i18n\|intl"` over the bundled types finds only code-fence and file "language" (syntax) fields. The page's own `navigator.language` is the only signal. | sdk app, server |
| App settings are read-only on the page: `useSettings()` → `{ values, isLoading }`, secrets excluded. The server writes them with `settings.experimental_set(values)` (used for `vaultKey` and translation settings). | sdk app `PluginSettingsState`; `server.ts` 1132, 1697; `app.tsx` 2613–2647 |
| Settings are BB-rendered descriptors (`type: "select"`, `options`, `experimental_optionLabels`), e.g. `mailView`, `darkMail`, `hideQuotes`, `cleanLinks`; Mail settings shows them read-only. | `server.ts` 450–635; `src/ui/mail-settings.tsx` 139–146 |
| The page can see its own link to the BB server: `useRealtimeConnectionState(): "connected" \| "connecting" \| "reconnecting"`. Not used today. | sdk app 22863, 24707 |
| Refusals carry only `code` (`conflict`, `forbidden`, `invalid`, `not_found`) and a `message`; no reason key. Mail's refusal texts are fixed English constants (`*_MESSAGE`, 29 in `server.ts`) or `refuse(code, text)` literals; the page shows `error.message` (`messageOf`). | sdk server `experimental_PluginRpcRefusal`; `server.ts` 776–793; `app.tsx` 281–283 |
| Dates are formatted with the system locale: `toLocaleDateString(undefined, …)` in `formatListDate`, `formatFullDate`, `formatUntil` and five more files. | `src/ui/thread-list.tsx` 28–69; `agent-activity.tsx`, `mail-settings.tsx`, `print.ts`, `reading-pane.tsx`, `sender-card.tsx` |
| Hotkey letters already match `event.code`, so they work on the Russian layout. | `src/ui/shortcuts.ts` 3–4, 145–205 |
| Reply and forward markers already strip `Ответ`, `Отв`, `Пересл`; replies add `Re:` / `Fwd:`; the attribution line is English. | `src/core/compose-subjects.ts` 9–14, 27–33; `src/core/compose-reply.ts` 92–96 |
| Search is FTS5 `trigram` (case folding for Cyrillic; no е/ё folding); `mail_lower` folds case in `LIKE` filters. | `src/adapters/bb/sqlite-store.ts` 245, 882, 2165 |
| The list: `ThreadList` renders every loaded row as a variable-height `<li>` (people/date, subject, snippet, optional labels, server mark, attachment matches, snooze line) inside the list `<section>`, which is the scroll container and also holds the selection bar, filters and strips. | `src/ui/thread-list.tsx` 218–353, 405–478; `src/ui/mail-page.tsx` 1233–1330 |
| Paging: `PAGE_SIZE = 50`, `MAX_PAGE = 100`; Load more appends a page; a mail change re-fetches from the top until at least as many rows as are shown (`loadList(view, "refresh")`), debounced. | `app.tsx` 192–193, 684–781, 1074–1083 |
| Keys focus a row by finding `[data-row-key]` in the DOM and calling `scrollIntoView`; rows, ranges and Select all work from data (`rowIds`, `pageIds`). | `src/ui/mail-page.tsx` 587–597, 874–876; `src/ui/selection-bar.tsx` 159–176 |
| Two-column layout is measured on the page root (`useWideLayout`, 768 px) and by container queries (`@3xl:w-80`, `@6xl:w-96`); the reading pane is to the right. | `src/ui/mail-page.tsx` 438–457, 1233–1240 |
| Store timing tests exist for about 6 000 rows (`PAGE_MS = 250`, seeding untimed, `SEEDING_TIMEOUT_MS = 60_000`). | `src/adapters/bb/sqlite-store.test.ts` 41–51, 795–848, 1385–1410 |
| Every sync round rethreads the whole account: `store.assignThreads(accountId, buildThreads(store.threadingInputs(accountId)))`; `threadingInputs` reads and JSON-parses every row; `assignThreads` updates every row (where changed) then `refreshThreads(accountId, null)`, which deletes and rebuilds every thread row. `refreshThreads` already takes a list of thread ids. `progress.changed` is set for every synced folder. | `src/core/sync.ts` 249–261, 303; `sqlite-store.ts` 2373–2420, 3522–3563 |
| Sync problems are free English text joined with `; ` into `lastError`, from five sites (folder failed, folder gone with dropped moves, renumbered with dropped moves, flags not saved, moves returned) and `describeError` (`Authentication failed`, `Sync failed (<code>)`); `DECRYPT_ERROR` from the sync service. | `src/core/sync.ts` 164, 257, 366, 403, 441, 509, 567, 936–945; `src/adapters/bb/sync-service.ts` 58, 194–203 |
| IMAP errors keep only a safe code (`SafeImapError(code)`, socket codes such as `ECONNREFUSED` pass through `SAFE_CODE`); transient login codes `UNAVAILABLE`, `INUSE`, `LIMIT`, `SERVERBUG`, `ALERT`; `LoginThrottled`; `TLSFailed`. | `src/adapters/bb/imapflow-gateway.ts` 917, 950–977 |
| Gateway `test(config)` logs in and out and returns `{ ok }` or a reason; sessions expose `capabilities(): { uidplus, gmail }` from imapflow's `client.capabilities` set. SMTP `verify(config)` connects, TLS and AUTH, sends nothing. | `src/core/ports.ts` 81–86, 196–197, 282–284; `imapflow-gateway.ts` 163–172, 760–764 |
| Outbox: states `queued`, `held`, `sending`, `sent`, `appending`, `failed`, `unknown`, `sent_no_copy`, `done` (state is free `TEXT` in SQL); `attempts` and `send_after` columns exist; claim takes `queued` rows only; start-up recovery turns `sending` into `unknown` and overdue `queued` into `held`. | `src/core/model.ts` 673–702; `sqlite-store.ts` 370–390, 4397–4430 |
| A row with no SMTP server or no payload fails with kind `connect` (or `auth`) before SMTP opens; transport failures map by stage; 10 sends per account per minute (Retry and Send again count). | `src/core/compose-outbox.ts` 35, 95–105, 386–441; `src/adapters/bb/smtp-transport.ts` 79–111 |
| Each ok round calls `onRoundOk(accountId, outcome, only)` in the server; `sync_now` wakes the loop. | `server.ts` 1279; `src/core/contract.ts` `sync_now` |
| The IDLE supervisor keeps one watch per account in memory (`attempt`, `lastStartedAt`); `unsupported` stops it until reload. | `src/adapters/bb/idle-service.ts` 1–60 |
| CLI: `accounts`, `search`, `read`, `sync`, `remove`; `remove` refuses inside an agent thread (`owner_terminal_only`); every command refuses rule threads. | `server.ts` 5394–5566 |
| `bb.storage.database()` is the host's better-sqlite3 handle (`Database.Database`), WAL, incremental auto_vacuum; better-sqlite3's `Database#backup(file)` is part of that type. | sdk server 19830–19843 |
| `MIGRATIONS` has elements 0–14 (14 = 3i); the pin test covers `MIGRATIONS.slice(0, 15)`. | `sqlite-store.ts` 152–; `sqlite-store.test.ts` 764–789 |
| The vendored design system has `Dialog`, `Select`, `Checkbox`, `Button`, `Input`, `Icon` and `ResponsiveOverlay`; no popover, menu or virtual list. | `components/ui/` |
| `tests/architecture.test.ts` checks non-test files only, so a test may read sources with `node:fs`. | `tests/architecture.test.ts` 24 |

### Big mailboxes: store and rethreading (#74, decisions 3 and 5)

1. **Scale test.** `sqlite-store.test.ts` gains a seeded mailbox: two
   accounts, each Inbox 20 000, All Mail or Archive 20 000, Sent 5 000,
   five user folders 1 000 each, 30 % in conversations of 2–8 messages,
   2 % flagged, 10 % unread, attachments on 5 %. Seeding is never timed.
   Size `SCALE_ROWS` is 20 000 per account in `npm run check` and 50 000
   when `MAIL_SCALE=1` is set (`describe.runIf`-style gate; seeding timeout
   raised for that run only). Timed alone, each within `PAGE_MS`:
   `listThreads` and `messages_list` pages (first, 20th), `listThreadsAll`
   for inbox, `unreadCount`, `listFolders`, search by word (FTS trigram), by
   `from:`, by `has:attachment`, `files_list`, `sender_card`, and a no-change
   round's store work within `ROUND_MS`. The plans of the list queries are
   pinned as today (no `CORRELATED`, the expected index). The builder writes
   the measured numbers into the spec's resolutions at build time.
2. **Rethread only on change.** `RoundProgress` gains `rowsChanged`
   (inserted, removed, re-homed or reattached rows, completed or cancelled
   moves), set where those happen, separate from `changed` (which also
   covers flag-only rounds). `syncAccount` calls the threading step only
   when `rowsChanged` is true.
3. **Refresh only touched threads.** `assignThreads` already updates a row
   only when its thread id differs; it collects the old and new ids of the
   rows it updated plus the threads of inserted rows (a new store argument
   `touched`), and calls `refreshThreads(accountId, ids)` instead of
   `null`. The full rebuild (`refreshThreads(accountId, null)`) stays for
   `doctor --repair-threads` and for a migration that needs it.
   `buildThreads` still reads every row when it runs (linking needs the
   whole account); its cost is measured at 50 000 and, if over
   `ROUND_MS`, the builder reports it as an open finding rather than
   rewriting the threader in 3j.
4. **Flag-only rounds** keep their thread counts right through the store's
   existing flag paths, which refresh the affected threads **[unverified:
   to be pinned by a test — a round that only changes `\Seen` on the
   server updates the thread's unread count with no rethread]**.

### Windowed list (#74, decision 4)

1. **`src/ui/windowed-rows.ts` (new):** `useWindowedRows({ keys,
   estimate, scrollRef, overscanPx, pinned })` returns `{ start, end,
   padTop, padBottom, measure, scrollToKey }`. Heights are measured per row
   key with one `ResizeObserver` and cached; unmeasured rows use
   `estimate` (comfortable 68 px, compact 44 px; the measured median
   replaces it once known). `pinned` keys (focused, open, checked rows,
   capped at 200) are always inside the rendered set: the window is the
   union of the visible range and those rows, with spacers in between.
   Without `ResizeObserver` (jsdom, old hosts) every row renders, as today.
2. **`ThreadList`, `SearchResultList` and the message list** render
   `<li aria-hidden className="…" style={{ height }}>` spacers around the
   window when the list has more than `WINDOW_MIN_ROWS = 200` rows; rows
   carry `aria-setsize` and `aria-posinset`. The scroll container stays the
   list `<section>` (`mail-page.tsx` 1233); the hook measures the offset of
   the `<ul>` inside it, so the strips above the list scroll away as today.
3. **Focus.** `focusRowElement` (`mail-page.tsx` 587) first asks
   `scrollToKey(id)` (computed offset, `block: "nearest"` semantics), then
   focuses the row after it renders (one animation frame); data-driven
   moves (`next`, `previous`, Shift+arrows, successor after delete) are
   unchanged because they work on `rowIds`.
4. **Scroll loading.** A sentinel `<li>` after the rows starts
   `onLoadMore` when it comes within 600 px of the bottom
   (`IntersectionObserver` rooted at the section), once per page and never
   while `loadingMore`; ↓ or `j` on the last loaded row loads more and moves
   on when the page arrives. **Load more** stays below the rows (keyboard
   users, no observer).
5. **Find in page** (the browser's ⌘F) sees rendered rows only; Mail's
   own search is the way to find a message. README says so.
6. **Refresh** keeps its semantics (re-read from the top to the number of
   rows shown, so order and membership stay right). The store test pins
   that re-reading 2 000 rows (20 pages) stays within 20 × `PAGE_MS`; the
   live check measures it on the page. If it is too slow live, the finding
   goes to the owner, not into a cache invented in 3j.

### Outbox retry (#38, decision 6)

1. **State `waiting`** is added to `outboxStateSchema` (no SQL change; the
   column is free text). `settle` in `compose-outbox.ts` turns a failure
   into `waiting` with `send_after = now + backoff(attempts)` when: the
   kind is `connect`, `timeout_before_data` or `temporary`; the account has
   SMTP (the "no SMTP" path at `compose-outbox.ts` 399–402 gets its own
   fixed kind `no_smtp` so it never retries); and `now <
   created_at + RETRY_WINDOW_MS` (24 h). Otherwise `failed`, as today.
2. **Claiming:** `claimDueOutbox` takes `queued` **or** `waiting` rows
   whose `send_after` has passed; `attempts` already counts tries.
   Start-up recovery leaves `waiting` alone (nothing was in flight).
   The rate limit applies unchanged.
3. **Network back:** the server's `onRoundOk` for an account sets that
   account's `waiting` rows due now and wakes the outbox worker.
4. **Outbox row:** "Waiting for the network · next try 10:42 (try 3)" with
   **Send now**, **Edit** and **Discard**; **Edit** and **Discard** stop the
   retry (the row leaves `waiting` first, by the same state transition the
   other actions use). No "Sending in N s" toast for `waiting` rows. The
   sidebar Outbox count includes them.
5. **README** replaces "Nothing resends on its own" with the exact rule:
   which failures retry, the schedule, the 24-hour end, and that a send
   which may have reached the server never retries.

### Sync status (#48, decisions 7 and 8)

1. **Problem codes** (`src/core/sync-problems.ts`, new):
   `SyncProblem = { code, folder?: string, count?: number }` with codes
   `auth_failed`, `credential_unreadable`, `network` (socket and DNS codes:
   `ECONNREFUSED`, `ECONNRESET`, `ENOTFOUND`, `EAI_AGAIN`, `ETIMEDOUT`,
   `EHOSTUNREACH`, `ENETUNREACH`, `EPIPE`, and the gateway's connection-lost
   code **[unverified: the exact code names the gateway emits are pinned in
   the task from `imapflow-gateway` tests]**), `server_busy` (the transient
   login codes and `LoginThrottled`), `tls`, `server` (any other code, kept
   as `detail` when it matches `SAFE_CODE`), `folder_failed`,
   `folder_gone_moves_dropped`, `renumbered_moves_dropped`,
   `flags_not_saved`, `moves_returned`, `listing_broken`. Each `problems.push`
   site in `sync.ts` pushes a `SyncProblem` and its English text is made
   from it by one function, so `lastError` keeps its current wording.
2. **Store:** migration element 15 adds `accounts.sync_problems TEXT`
   (JSON, at most 20 entries, folder names capped at 200 characters) and
   `accounts.error_since TEXT` (first failure of the current failing run;
   cleared by an ok full round). `recordSyncResult` writes both.
3. **`status_get`** account entries gain `syncProblems`, `errorSince`,
   `nextSyncAt` (from the sync loop's schedule) and `instantMail: "live" |
   "starting" | "off" | "unsupported"` (from a new `state(accountId)` on the
   IDLE supervisor, in memory). Nothing else; no server text.
4. **Header:** "Synced 10:42" stays; with only `network` problems and
   `errorSince` younger than 30 minutes it reads "Offline · synced 10:42"
   in muted text with an icon, and no banner. The page's own BB link
   (`useRealtimeConnectionState() === "reconnecting"`) shows "Reconnecting
   to BB…" there instead.
5. **Banner:** as today, `role="alert"`, for every other problem and for
   `network` after 30 minutes; it shows the problems in the page's
   language (folder names as data), **Update app password** for
   `auth_failed`, and **Sync now** for the rest.
6. **Status panel:** the header label is a button that opens **Mail
   status** (`ResponsiveOverlay`, so a sheet on a phone-sized window): per
   account its address, synced at, next sync, instant mail, problems,
   waiting and failed sends (links to the Outbox), and **Sync now**.
   Read-only besides Sync now.

### Diagnostics (#75, decision 9)

`bb makosh-mail doctor [accountId] [--json] [--repair-threads]`, refused
inside agent threads (`owner_terminal_only`) and rule threads. Per account,
each line `ok`, `warn` or `fail` with a fixed text:

- vault ready; credential opens (no password printed, ever);
- IMAP login (`gateway.test`), with capabilities from a new
  `ImapTestResult.capabilities` on success — a fixed set only: `IDLE`,
  `MOVE`, `UIDPLUS`, `CONDSTORE`, `QRESYNC`, `SPECIAL-USE`, `X-GM-EXT-1`;
  a missing `MOVE` or `IDLE` is `warn` with what Mail does instead;
- SMTP `verify` when the account has SMTP;
- the stored folder roles found (Inbox, Sent, Drafts, Trash, Spam,
  Archive), the snooze folder;
- last sync, `sync_problems`, instant mail state;
- database: `PRAGMA quick_check` (time-boxed; `skip` past 20 s **[unverified
  cost at 100 000 rows]**), row counts (messages, threads, outbox by state,
  pending moves), file size and free pages, `MIGRATIONS` applied,
  thread-row consistency (threads with no messages, messages whose thread
  row is missing).

`--repair-threads` runs the full rebuild for the account (or all) through
the account's queue and prints counts. Network checks run through the
account queue, so they never race a sync round. Nothing is written to the
agent log; the plugin log gets `doctor <accountId>: ok|warn|fail` only.

### Backup (#94 partial, decision 10)

`bb makosh-mail backup <file> [--json]`, owner's terminal only. The path
must be absolute, its directory must exist, the file must not; the copy is
made with `db.backup(file)` (an online, consistent copy that includes the
WAL), file mode 0600 **[unverified: better-sqlite3 creates the file itself;
the mode is set right after]**. It prints the size and the row count of
`messages`. README: what the copy contains (mail text, sealed passwords
without the key, settings live in BB not in the file), how to restore
(quit BB, replace `<dataDir>/plugins/makosh-mail/data.db`, start BB), and
that the file should be kept like the mailbox itself.

### Density and reading pane (#76, decision 11)

1. **Settings** (`defineSettings`): `listDensity` select `comfortable` /
   `compact` (labels "Comfortable", "Compact"), `readingPane` select
   `right` / `bottom` ("Right of the list", "Below the list"). Mail settings'
   Reading section lists them read-only like the others.
2. **View menu:** a **View** button in the list header (beside the quick
   filters) opens a small `Select`-based panel with the two choices; a
   change calls `view_settings_set` (owner only, `refusePluginCaller`),
   which validates and calls `settings.experimental_set`. The page reads the
   values back through `useSettings()`.
3. **Compact rows:** two lines (people · count · date; subject), no
   snippet, label chips moved to the end of the subject line (truncated),
   `py-1` instead of `py-2`; the snooze line and attachment matches stay
   (search keeps comfortable rows, since matches are the point there).
4. **Bottom pane** (only when the page is wide, `useWideLayout`): the list
   takes the full width and 40 % of the height (at least 8 rows), the
   reading pane or the docked composer fills the rest. Narrow windows keep
   today's single column in both settings. The 3i part B reading flow
   (arrows, successor, stack) is unchanged.

### Russian (#53, decisions 12–15)

1. **Catalog** (`src/ui/i18n/`, new, host-free): `index.tsx` with
   `I18nProvider({ lang })`, `useT()` returning `t(text, params?)`,
   `tn(count, forms, params?)` (plural by `Intl.PluralRules`),
   `formatDate(kind, iso)` and `formatNumber` (by `Intl.DateTimeFormat` /
   `NumberFormat` in the chosen language); `ru.ts`, a `Record<string,
   string | PluralForms>` keyed by the English source text; English needs
   no table. Placeholders are `{name}`; values are inserted as text, never
   as HTML.
2. **Every owner-facing string in `src/ui` and `app.tsx`** goes through
   `t` / `tn`: labels, buttons, `aria-label`, `title`, placeholders, empty
   states, toasts, confirm dialogs, the shortcut sheet's descriptions (key
   names stay), the outbox states, the sender warnings and the status. The
   date helpers in `thread-list.tsx` take the language instead of
   `undefined`.
3. **Server texts the page shows** — refusal messages, `NEEDS_KEY_MESSAGE`
   and the other `*_MESSAGE` constants, `DECRYPT_ERROR`, the old free-text
   `lastError` of accounts not yet re-synced — are looked up by exact text
   (`t(message)`); unknown text is shown as it came (English). Messages
   with values (`notAllIn(account, folder)` and similar) become fixed text
   with the values moved to the page, or stay English; the task lists each.
4. **`lang`:** the page root gets `lang="ru"` or `lang="en"`; the message
   frame keeps its own document and its own language.
5. **Style:** Russian follows the backlog's wording ("письмо", "цепочка",
   "папка", "входящие", "черновик", "отправить", "переместить в…");
   typographic quotes «»; the ellipsis character; no title case.
   Russian text runs about a quarter longer: buttons with fixed width and
   truncated chips are checked in the rendered preview.

### Data model and migration

Element 15 (appended):

```sql
ALTER TABLE accounts ADD COLUMN sync_problems TEXT;
ALTER TABLE accounts ADD COLUMN error_since TEXT;
```

No other schema change: the outbox's `waiting` state, the settings and the
catalog need none. The SHA pin covers `MIGRATIONS.slice(0, 16)`.

### RPC contract (`src/core/contract.ts`)

- `status_get`: account fields `syncProblems`, `errorSince`, `nextSyncAt`,
  `instantMail` (decision 7, "Sync status" 3).
- `outbox_list` and the outbox change payload: state `waiting` and
  `nextTryAt`; `sendErrorKindSchema` gains `no_smtp`.
- `view_settings_set` (new, owner only): `{ listDensity?, readingPane? }` →
  the two values.
- The credential-key walker (`contract.test.ts`) keeps passing: no new key
  matches `/pass|secret|seal|key/i`.

### Settings added

`listDensity` (`comfortable`), `readingPane` (`right`), `language` (`auto`;
options `auto` "Same as the system", `ru` "Русский", `en` "English"). BB
renders them; their labels stay English (decision 14).

### UI (summary) and rendered previews

New or changed: compact rows, bottom pane, View menu, header offline state,
status panel, problem banner texts, outbox `waiting` row, the whole page in
Russian. The owner's global instructions route product UI through
`product-design` (then `ui-build`, with `ui-business-apps` priorities, and
`playwright-visual-qa`); the UI tasks follow that route at build time. The
builder shows the owner a **rendered preview** before the UI tasks are
merged for these decisions, where a picture decides better than text:

- **P1 Density:** the same list in comfortable and compact, light and dark,
  with a Gmail label row, an unread row and a snoozed row.
- **P2 Reading pane below:** a wide window with the bottom split and the
  docked composer.
- **P3 Status:** header "Offline · synced 10:42", the alert banner with two
  problems, the Mail status panel (desktop and phone-sized sheet).
- **P4 Russian:** list header, selection bar (compact actions), quick
  filters, the mail rail, reading pane actions, composer toolbar, Outbox,
  Mail settings — at 768 px and 1280 px, to catch truncation.
- **P5 Outbox:** a `waiting` row beside `failed` and `unknown`.

The windowed list, scroll loading, retry logic, doctor and backup need no
preview (behaviour, checked by tests and the live steps).

### Security and privacy

- **Retry** never resends what may have reached the server; the window is
  fixed; the rate limit still caps every send. An agent with shell access
  (3c accepted limit) gains nothing new: it could already press Retry.
- **Status** carries codes, counts, times and folder names (already shown);
  never server text. `nextSyncAt` and `instantMail` say nothing about mail.
- **Doctor and backup** refuse inside agent and rule threads. Doctor
  prints no credential, no server response text and no addresses besides
  the account's own; backup writes only to a path the owner typed, never
  over an existing file. Logs: the command name, account id and outcome.
- **Catalog:** values are inserted as text; no translated string is HTML
  or Markdown; mail data never becomes a catalog key.
- **Windowing** renders fewer rows; nothing leaves the page.
- **Server changes:** none to the mail server; doctor's login and SMTP
  verify are the same calls as **Test** in the account form.

## Testing

Core with fakes, the store on real SQLite, adapters with fakes, UI with
Testing Library and jsdom, as before. Fixtures use made-up text on
`example.com` / `example.org` / `example.net`; Russian test strings with
letters that look Latin are written as `\u` escapes where the test is about
the letters.

- **Store at scale** (`sqlite-store.test.ts`): the seeded mailbox, every
  timed call within `PAGE_MS`, query plans pinned; 20 000 rows in `npm run
  check`, 50 000 with `MAIL_SCALE=1`.
- **Rethreading** (`sync.test.ts`, store): a no-change round does not call
  `threadingInputs` or `assignThreads`; a round with one new reply
  refreshes only that conversation's thread rows (others keep their
  `rowid`); a move between folders refreshes the old and new threads;
  `--repair-threads` gives the same threads as today's full rebuild on the
  same rows; flag-only round updates unread counts.
- **Windowed rows** (`windowed-rows.test.ts`, `thread-list.test.tsx`): 199
  rows render all; 5 000 rows render a window plus pinned rows; spacer
  heights add up; `aria-setsize`/`posinset`; `scrollToKey` then focus;
  focused, open and checked rows stay rendered; no `ResizeObserver` →
  everything renders; sentinel calls `onLoadMore` once per page, never
  while loading; ↓ on the last row loads and moves.
- **Outbox retry** (`compose-outbox.test.ts`, store, worker): each kind
  retries or not; `no_smtp` never; schedule; the 24-hour end; claim of
  `waiting`; recovery leaves `waiting`; rate limit; `onRoundOk` makes rows
  due; Edit and Discard stop it; a `temporary` after DATA retries,
  `unknown_after_data` does not.
- **Sync problems** (`sync.test.ts`, `sync-problems.test.ts`): each site
  pushes its code; `lastError` text unchanged for every existing test;
  `error_since` set on the first failure and cleared by an ok full round;
  network vs other classification.
- **Status UI** (`mail-page.test.tsx`): offline under 30 minutes is quiet,
  over 30 minutes or any other code shows the banner; reconnecting state;
  status panel content; Sync now.
- **Doctor and backup** (`server.test.ts`): refused in agent and rule
  threads; capability lines from a fake gateway; no server text in output
  (fixture errors carry a secret-looking string that must not appear);
  backup refuses an existing file and a relative path, writes a readable
  copy whose `messages` count matches.
- **Density and pane** (`thread-list.test.tsx`, `mail-page.test.tsx`):
  compact rows have no snippet; bottom layout only when wide;
  `view_settings_set` refuses plugin callers and validates values.
- **Russian** (`i18n.test.ts`, `tests/i18n-catalog.test.ts`): plural forms
  for 1, 2, 5, 11, 21, 22, 25; dates in `ru` and `en`; `auto` from
  `navigator.language`; **catalog completeness** — every literal passed to
  `t(`/`tn(` in `src/ui`, `app.tsx` and the server's `*_MESSAGE` constants
  has a Russian entry, no Russian entry is unused, placeholders match;
  **no stray English** — a pseudo-language test renders the list, reading
  pane, composer, settings, status and outbox with every `t` output wrapped
  in markers and fails on any visible text node outside markers that is not
  fixture data.
- **Contract** (`contract.test.ts`): new fields, the `waiting` state,
  `view_settings_set` refused for plugin callers, the credential-key walker.
- **Migration:** element 15 on a copy of an element-14 database; the SHA
  pin for 0–15.

### Live verification (owner's BB, after the build)

1. A large real folder (Gmail All Mail or Archive with the window raised,
   or loaded history): scroll to 3 000 rows, keys and selection still
   instant; refresh after new mail does not stall the page (the builder
   records timings, no mail content).
2. Wi-Fi off: header goes "Offline", no banner; compose and Send → the
   Outbox shows "Waiting for the network"; Wi-Fi on → the message goes out
   once (check the recipient side and Sent).
3. Status panel in both languages; instant mail shows live for Gmail.
4. `bb makosh-mail doctor` for each account; `backup` to a new file and
   open it with `sqlite3` read-only to check the counts.
5. Density and bottom pane through the View menu; BB's settings page shows
   the same values.
6. `language: ru`: walk the page, dialogs and toasts; the owner reads the
   Russian (open question 5 is about who proofreads).

## Tasks

Each task ends with `npm run check`. The last also runs `npm run build` and
`node ../../scripts/check-manifests.mjs`. Paths are under `plugins/mail/`.

1. **Store at scale and incremental rethreading.** Seeded scale test,
   `MAIL_SCALE` gate, `rowsChanged`, touched-thread refresh, repair path
   (+ tests, measured numbers recorded).
2. **Windowed list and scroll loading.** `windowed-rows.ts`, `ThreadList`,
   `SearchResultList`, message list, focus path, sentinel, ↓ at the end
   (+ tests).
3. **Outbox retry.** `waiting`, `no_smtp`, settle and claim, recovery,
   `onRoundOk` wake, Outbox row, README rule (+ tests).
4. **Sync problems and status.** `sync-problems.ts`, sync sites, migration
   15, `status_get` fields, IDLE `state`, header, banner, status panel
   (+ tests).
5. **Doctor and backup.** Gateway `capabilities` on test, CLI commands,
   README (+ tests).
6. **Density and pane.** Settings, `view_settings_set`, View menu, compact
   rows, bottom layout (+ tests). Rendered previews P1, P2.
7. **Russian.** `src/ui/i18n`, `language` setting, every string through
   `t`, date helpers, server-text lookup, `lang`, `ru.ts`, catalog and
   pseudo-language tests. Rendered previews P3, P4, P5 (in both languages).
   Done last so every string from tasks 2–6 is in the catalog.
8. **Docs and listing.** `README.md` (big mailboxes and the windowed list,
   the retry rule, status, `doctor`, `backup` and restore, density and pane,
   language; "Not yet" loses "a virtualized list"), `PLUGIN_OVERVIEW.md`,
   `package.json` `bb.description` and `marketplace.json` together (only if
   the one-line description changes), `skills/mail/SKILL.md` (doctor and
   backup are not for agents), `CHANGELOG.md`, `docs/mail-feature-backlog.md`:
   74, 38, 48, 75, 76, 53 `[уже есть]` with "Срез 3j"; 94 `[позже]` with
   "резервная копия базы — срез 3j; выгрузка в mbox — позже"; the header's
   date line. `THIRD_PARTY_NOTICES.md` unchanged (nothing ported).

## Calls made by me (not the owner)

- Retry kinds and "SMTP configured" as the line between safe and unsafe;
  the network-back signal is an ok sync round of the same account, since
  Node gives no reliable online event.
- Codes stored beside `lastError` rather than replacing it, so the CLI,
  agents and every existing test keep their text.
- 30-minute quiet period and the list of network codes.
- Windowing threshold 200 rows, estimates 68 / 44 px, 600 px sentinel
  margin; pinned rows instead of virtual focus.
- Refresh semantics unchanged; measured instead of redesigned.
- Rethreading: skip when no row changed, refresh touched threads; the
  threader itself not rewritten in 3j.
- English source text as catalog keys (gettext style) rather than ids; the
  page, not the server, translates; BB settings labels stay English.
- `doctor` and `backup` owner-terminal-only, like `remove`.
- `@tanstack/react-virtual` considered and not proposed (decision 2).
- Compact rows keep the snooze line and attachment matches; search results
  stay comfortable.

## Open questions for the owner

1. **Language default:** `auto` — Russian when the system is Russian
   (proposed) — or always `ru`? *Recommendation:* `auto`; set `ru` in BB's
   settings if the system is English.
2. **Retry window:** 24 hours after Send (proposed), 2 hours, or no
   automatic retry? *Recommendation:* 24 hours.
3. **Outgoing text:** keep `Re:`/`Fwd:`, "On …, X wrote:" and the forward
   header in English (proposed), or write the attribution and forward
   header in the interface language ("…, X написал(а):")?
   *Recommendation:* English in 3j; `Re:`/`Fwd:` stay English either way.
4. **Backup in 3j:** add `bb makosh-mail backup` (proposed), or leave #94
   entirely for later? *Recommendation:* add it; mbox stays later.
5. **Russian proofreading:** the builder writes `ru.ts` and the owner reads
   it in the live step (proposed), or the owner wants to review the table
   as a file before the build? *Recommendation:* live step.

## Items proposed for another slice

- **#94 rest: mbox / `.eml` archive export** → `[позже]` (fetches every
  original from the server; needs its own design for size and progress).
- **Russian-aware search:** е/ё folding (a new FTS tokenizer option means
  rebuilding the index) and Russian operator aliases → later, unscheduled.
- **Draggable splitter and resizable list column** → later, unscheduled.
- **A faster threader** if task 1 shows `buildThreads` over `ROUND_MS` at
  50 000 rows → a follow-up with the numbers.
- No 3j item needs owner action outside the code, so nothing moves to 3k
  (3k stays PGP and S/MIME).

## Not verified

- That BB desktop's page reports the system language in
  `navigator.language` and that its `Intl` has Russian plural and date data
  (Electron ships full ICU as far as the builder knows; Node 24 in tests
  does).
- That `useRealtimeConnectionState` turns `reconnecting` when the BB server
  is unreachable, and how quickly.
- Which socket codes `imapflow` surfaces through `describeImapError` for a
  lost network (`ECONNREFUSED`, `ENOTFOUND`, `ETIMEDOUT` expected; pinned in
  task 4 by tests).
- That flag-only rounds keep thread unread counts right without a rethread
  (pinned by a test in task 1 before the skip lands).
- The cost of `buildThreads` and `PRAGMA quick_check` at 50 000 and 100 000
  rows on the owner's machine.
- That `Database#backup` on the host-provided handle works while the
  plugin's own statements run (better-sqlite3 documents it as online), and
  the file mode it creates.
- That `ResizeObserver` and `IntersectionObserver` rooted at the list
  section behave in BB desktop as in Chromium generally; jsdom has neither,
  so tests cover the fallbacks and fakes.
- That BB's settings page shows new `select` settings with
  `experimental_optionLabels` in Cyrillic correctly (`"Русский"`).
- Real-mail scrolling performance with thousands of rows (live step 1).

## What was built (2026-11-17), and where it departs from the design above

The owner accepted the proposed decisions with the recommended defaults
(language `auto`, 24-hour retry, English outgoing text, backup in 3j, owner
proofreads Russian live). The slice was then built in one session, without a
separate builder check or plan; this section is the record of the result and
overrides the Design section where they differ.

1. **Rethreading (decision 3).** As designed, with the dirty flag kept by
   the store (`threadsStale`): an insert (`upsertMessages`) or a delete
   (`deleteRows`) makes an account stale, `assignThreads` clears it, and a
   round rethreads stale accounts only. `assignThreads` rewrites only the
   threads a row left or joined; the first assignment after a load rebuilds
   every thread row. `repairThreads` is the full rebuild for doctor. There
   is no `rowsChanged` on `RoundProgress`.
2. **Windowed list (decision 4) is not a windowing hook.** Rows stay in the
   document and get `content-visibility: auto` with an intrinsic size, so
   the browser skips layout and paint of rows far from view. This keeps the
   3i keyboard flow, focus, drag and selection untouched, at the cost that
   React still holds every loaded row. Scroll loading uses an
   `IntersectionObserver` mark; Load more stays. No `aria-setsize`.
3. **Scale test (decision 5):** one store test at 20 000 rows (50 000 with
   `MAIL_SCALE=1`) for the incremental rethread; the other timed calls keep
   their existing 6 000-row tests. No numbers were recorded.
4. **Outbox retry (decision 6):** as designed (`waiting`, `no_smtp`, 24
   hours, backoff 1/5/15/30/60 minutes, release on an ok round, staggered 7
   seconds apart, the shared cap moves an automatic try back by a minute).
5. **Sync problems (decision 7) need no migration.** There is no element
   15 and no `sync_problems` or `error_since` column. `parseSyncProblems`
   reads the stored `lastError` line back into codes; "quietly offline" is
   decided from `lastSyncAt` (network or busy only, last good sync under 30
   minutes old). `status_get` is unchanged; `nextSyncAt` and `instantMail`
   were not added.
6. **Doctor (decision 9):** as designed except that server capabilities
   (IDLE, MOVE and the rest) are not listed, and `quick_check` is not
   time-boxed.
7. **Backup (decision 10):** as designed.
8. **Density and pane (decision 11):** two BB settings only. There is no
   View menu and no `view_settings_set` RPC; Mail settings does not list
   them.
9. **Russian (decisions 12-14):** `src/ui/i18n` with `tx`, `txn`, `msg`
   and a catalog keyed by the English text; a module-level language set by
   every slot component from the `language` setting. Static texts were
   wrapped by a script, tables are marked with `msg` and shown with `tx`,
   server refusals are looked up by exact text. A test checks that every
   literal text passed to `tx`/`txn`/`msg` has an entry. Not covered: texts
   built in `src/core` and shown as they come (parts of pre-send issues,
   durations such as "3 days", some lowercase fragments), which stay
   English; sentences split around a link or a bold word are translated
   piece by piece.
10. **Rendered previews P1-P5 were not made.** The owner sees the result
    in the live check.
11. **Migrations:** unchanged, elements 0-14; the pin stays
    `MIGRATIONS.slice(0, 15)`.
