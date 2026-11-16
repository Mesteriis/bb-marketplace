# Makosh Mail — slice 3e: inbox triage (IDLE, notifications, unsubscribe, snooze, block, filters, agent triage)

Status: decisions made by the owner (2026-11-15); this document is the
builder's design for review. It follows 3a (organize and read), 3b (write and
send), 3c (agent proposals and translation) and 3d (sending polish), all on
`feat/mail-imap-slice`. Everything in the slice-1, slice-2, 3a, 3b, 3c and 3d
specs holds unless this document changes it, and their "Resolutions" sections
are the binding form (3c resolutions 1–29, 3d resolutions 1–20 included).
Backlog: `docs/mail-feature-backlog.md` items 20, 25, 26, 41, 42, 44 and 73.

Points the builder could not verify are marked **[unverified]** and collected
in "Not verified" at the end. "Open questions for the owner" lists the places
that need an owner call. Each has a recommendation, and the design below
follows it.

## Owner's decisions

Recorded verbatim (2026-11-15).

1. **Scope of 3e:** IMAP IDLE (backlog #20), BB notifications for new mail (#26), List-Unsubscribe (#41), snooze (#42), block sender/domain (#73), quick list filters (#44), and agent inbox triage with the owner's approval (#25).
2. **Notifications: in-app toast + the existing unread badge.** BB gives plugins no system-notification API (verify in the SDK and say so with line refs). A toast "New mail from …" with Open, only for important senders (people the owner has written to) and never for bulk mail; quiet hours in settings.
3. **Unsubscribe: one click + mailto.** Only on the owner's click and confirmation. If the message has RFC 8058 `List-Unsubscribe-Post: List-Unsubscribe=One-Click` and an https URL in `List-Unsubscribe`, POST to it — only when the message passed DKIM covering those headers (decide how to verify: the server's Authentication-Results from the owner's provider is the practical source; specify trust rules). Otherwise send an unsubscribe email to the mailto address through the normal 3b outbox with Undo. Never use links from the message body. State the privacy risk (confirms a live address).
4. **Snooze: a server folder.** The message moves to a "Snoozed" folder (created on the owner's confirmation) and at the due time returns to the Inbox unread. On the phone it disappears from the Inbox too. Return works while BB runs; overdue returns happen at the next start.
5. **Agent triage in 3e:** the agent proposes a batch (archive / reply / snooze / mark read / spam / unsubscribe) and the owner approves — reuse the 3c pattern (a card in the agent's thread via ui.requestInput, nothing happens without the owner's click; replies still go through mail_propose cards). Per-item checkboxes on the card; the owner can approve a subset.

## Goals

1. **New mail in seconds.** While BB runs, each account keeps one IMAP IDLE
   connection on its Inbox. A new message (or a change made on another
   device) wakes an Inbox-only sync round at once. Polling stays as the
   fallback and keeps covering every other folder.
2. **Notifications inside BB.** When new unread mail from someone the owner
   has written to arrives in an Inbox, every open BB window shows a toast
   "New mail from <name>" with the sender's address and **Open**. Bulk mail,
   spam, blocked senders, strangers and the owner's own mail never toast.
   Quiet hours (a setting) silence toasts; the unread badge on the Mail nav
   entry keeps counting either way.
3. **Unsubscribe.** A message with a `List-Unsubscribe` header shows
   **Unsubscribe**. After the owner confirms (the dialog states the privacy
   risk), the plugin either POSTs the RFC 8058 one-click request — only when
   the provider's Authentication-Results show a passing DKIM signature that
   covers both list headers — or queues an unsubscribe email to the header's
   `mailto:` address through the 3b outbox with its 10 s Undo. Nothing from
   the message body is ever used.
4. **Snooze.** **Snooze** (key `b`, toolbar, selection bar) moves the
   conversation's Inbox messages to the account's Snoozed folder, which is
   created on the owner's confirmation the first time. At the chosen time
   they move back to the Inbox, unread. Return works while BB runs; overdue
   snoozes return at the next start. **Return now** brings one back early.
   Snoozing is undoable with `z`.
5. **Block a sender or a domain.** **Block** moves the conversation to Spam
   and adds a local rule; new Inbox mail from that address or domain is moved
   to Spam by each sync round. Undoable with `z`; rules are listed and
   removed in Mail settings.
6. **Quick filters.** Toggles above the conversation list — **Unread**,
   **Flagged**, **Attachments** — narrow the current folder or merged role,
   served by the store with the same paging.
7. **Agent inbox triage.** With the new setting `agentTriage` on, an agent can
   list Inbox messages (`mail_inbox`) and propose a batch (`mail_triage`).
   The owner sees a card in the agent's thread with one checkbox per item,
   approves a subset, and only the approved items run, through the same code
   paths as the owner's own clicks. Reply items only permit the agent to draft
   replies through `mail_propose` cards. The applied batch is undoable from
   the thread row.

## Non-goals (later or backlog)

- OS notifications (macOS Notification Center, sounds, Dock badges). The SDK
  has no API for them (see the facts table); a BB change is out of scope.
- Toasts while no BB window is open, or on another device.
- IDLE on folders other than the Inbox; NOTIFY (RFC 5465); QRESYNC.
- Server-side filters (Sieve, Gmail filters) for blocking, and snooze returns
  while BB is not running. Both are local rules applied by this plugin.
- Our own DKIM signature verification (DNS lookups and crypto). The plugin
  trusts the owner's provider's Authentication-Results (Open question 4).
- One-click unsubscribe on accounts of the "other" preset (no trusted
  authserv-id in 3e, Open question 3); they get the mailto path only.
- Unsubscribe from a link in the body, or an "unsubscribe from everything"
  sweep.
- Agents creating, changing or removing block rules, creating the Snoozed
  folder on their own, deleting mail, or forwarding mail through triage.
- Snooze of Sent, Drafts, Spam or Trash mail; snooze to a folder other than
  the Inbox; recurring snoozes ("every Monday").
- Saved searches or filters beyond the three toggles; per-folder remembered
  filters across restarts.
- Changes to BB.

## Anti-goals

- **An outbound request the owner did not click.** The one-click POST runs
  only from the owner's confirmed click or an item the owner ticked on a
  triage card. No sync, agent or timer makes an HTTP request.
- **An HTTP client that follows the mail.** No redirects, no cookies, no
  body read beyond a small drain, no URL from the body, no plain `http:`, no
  private or loopback address, no port other than 443.
- **Trusting headers the sender wrote.** A forged `Authentication-Results`
  or `DKIM-Signature` alone never enables one-click (see "Trust rules").
- **A toast that leaks mail.** A toast carries the sender's name and address
  only, never the subject or text (Open question 1). Realtime carries a
  token only.
- **Permanent deletion.** Snooze, block, triage and their undo only move and
  set flags. No `\Deleted`, no EXPUNGE.
- **A folder the owner did not agree to.** The Snoozed folder is created only
  after the owner's confirmation, in Mail or as a ticked item on a triage
  card. The plugin never deletes or renames a folder.
- **An agent acting alone.** Every triage action waits for the owner's tick
  and click; the card shows the store's data, not the agent's words, as the
  description of each message.
- **Mail text, addresses or URLs in logs**, realtime payloads or error texts,
  as in 3b–3d. Rule values, unsubscribe hosts and addresses go to the page
  only.

## Design

### Code, SDK and host facts this design relies on

Line numbers are in the current tree (`plugins/mail/…`) unless marked "sdk"
(`node_modules/@get-bb/plugin-sdk/bundled-types/bb-plugin-sdk.d.ts`, SDK
0.6.132), "app" (`…/bb-plugin-sdk-app.d.ts`), "imapflow" (2.11.0,
`node_modules/imapflow/dist/esm/…`) or "host" (BB 0.49.0).

| Fact | Where |
| --- | --- |
| **No notification API for plugins.** `BbPluginApi` (the whole server API) has `log, settings, storage, http, rpc, realtime, background, cli, agents, providers, ui, events, experimental_hooks, experimental_environments, experimental_machines, experimental_serverAccess, status, server, hosts, experimental_aiServices, sdk, onDispose, onInstall` — no notification member. `PluginUi` has only `requestInput` and `registerMentionProvider`. The only "notification" strings in the SDK are BB's own keybinding id `notifications.open` and experiment flags `dismissReadNotifications` / `skipFocusedThreadNotifications`, none callable by a plugin. | sdk 21673–21759 (`BbPluginApi`), 21381–21403 (`PluginUi`), 367, 702–708; app 282, 611–617 |
| `bb.realtime.publish(channel, payload)` broadcasts to every connected client; nothing is persisted. | sdk 20516–20523 |
| `bb.background.service(name, {start(signal)})` runs a long-lived service restarted with capped backoff on a crash, including an unlistened `'error'` event; `schedule(name, cron, fn)` exists with 5-field cron. | sdk 20524–20546 |
| `PluginServerApi` offers URLs and the data dir only; the SDK has **no HTTP client** for plugins and no outbound-network policy. The plugin server is Node: IMAP (imapflow) and SMTP (nodemailer) already open sockets from adapters. | sdk 21410–21445 |
| A nav panel's `experimental_useBadge` hook is called by the host **once in the plugin's scope for every registered panel, including hidden ones**, and may own RPC queries and realtime subscriptions through the ordinary SDK hooks. Mail already uses it for the unread count. | app 20066–20079, `ExperimentalBadge` 20017–20035; `app.tsx` 2061–2073, 2189–2197 |
| `sonner` is a host runtime slot: the bundle reads `globalThis.__bbPluginRuntime.sonner`, so a plugin `toast()` renders in BB's own toaster wherever the call runs. | `dist/app.meta.json` `runtimeSlots`; `dist/app.js` (runtime check) |
| `bb.ui.requestInput`, `PluginInteractionRequest`, `describeSubmission`, the `pendingInteraction` and `experimental_timelineRenderer` slots, and the shell-answer limit. | 3c "SDK and host facts", 3c resolutions 1, 8, 21, 22 |
| imapflow `idle(options?)`: with `disableAutoIdle` a manual call runs `IDLE` and does not return until IDLE ends; `maxIdleTime` restarts IDLE every N ms; `{ whenFree: true }` waits for a free connection. | imapflow `imap-flow.d.ts` 385–401, 169–170; `types.d.ts` 46, 113–114, 773–782; `imap-flow.js` 3033–3042 |
| imapflow events: `exists` `{path, count, prevCount}`, `expunge`, `flags`, `mailboxOpen` (also on a new UIDVALIDITY), `close`, `error` (at most once, then the connection closes). `idlingAtClose` and `closedByClient` tell a server drop from our own close. | imapflow `types.d.ts` 812–860, 944–975; `imap-flow.d.ts` 148–165 |
| imapflow `socketTimeout` (default 5 min): on a quiet socket while idling it sends a recovery `NOOP` (which breaks IDLE with `DONE`); a NOOP that does not settle by the next timeout closes the connection. With `disableAutoIdle` nothing restarts IDLE. `missingIdleCommand` (default NOOP) is the fallback on servers without IDLE. | imapflow `imap-flow.js` 27, 1250–1300; `types.d.ts` 131, 147 |
| imapflow `mailboxCreate(path)` → `{ path, mailboxId?, created }` (`created: false` when it existed); the namespace prefix is added automatically. | imapflow `imap-flow.d.ts` 287–297; `types.d.ts` 389–396 |
| The gateway connects per call (`openFolder`, `listFolders`), uses TLS only, `disableAutoIdle: true` and `socketTimeout` 60 s, and logs safe codes only. | `src/adapters/bb/imapflow-gateway.ts` 121–164, 450–470, 508–545 |
| Sync parses the whole source with postal-mime, so any header is available at sync with no extra fetch (`toBulkHeaders`, `toDeliveredTo`). | imapflow-gateway.ts 547–621 |
| A sync round of an account runs inside its write queue; `wake(accountId)` queues a round of that account (all folders), coalesced by `WAKE_WINDOW_MS` = 10 s; after an ok round the same task backfills bulk marks and resolves send checks; `onRoundEnd` runs after the task. | `src/adapters/bb/sync-service.ts` 46, 111–119, 143–195; `account-queue.ts` 8–37 |
| `syncAccount` lists folders, then pushes and syncs every selectable folder; `upsertMessages` returns nothing today. | `src/core/sync.ts` 128–170, 480–556; `src/core/ports.ts` 254 |
| The bulk mark (`classifyBulk`, `isBulkRow`) and the bulk backfill over `BODY.PEEK[HEADER.FIELDS (…)]`. | `src/core/contacts.ts` 37–54; `src/core/bulk-backfill.ts` 21; 3c resolutions 24, 29 |
| `addressesSentTo(addresses)` = Sent-role rows ∪ `sent_recipients`. | `ports.ts` 577; 3d resolution 18 |
| Undo: `UndoRecord`, `planUndo`, the in-memory `UndoBook` (one slot, 10 min), `action_undo({undoId})`. | `src/core/undo.ts` 17–80; `src/adapters/bb/undo-book.ts` 8–62; 3d resolutions 4, 8, 20 |
| `message_action` input (`messageIds` ≤ 200, `folder` or `role`, `destination`, `undoId`); `threadsAction` sends chunks of 200. | `src/core/contract.ts` 184–208; `app.tsx` 102–103 |
| Settings descriptors (`string`, `boolean`, `number`, `select`) and the plugin's current settings. | `server.ts` 265–332 |
| Presets are `icloud`, `gmail`, `other`. | `src/core/presets.ts` 28– |
| `revealHidden` (strip and count invisible characters) for untrusted text shown to the owner. | `src/core/agent-propose.ts` 232; 3c resolution 20 |
| `threadSubPath(accountId, threadId)` routes the Mail page to a conversation. | `src/ui/routes.ts` 20 |
| Migration elements 0–7 are SHA-pinned. | `src/adapters/bb/sqlite-store.ts` 100–428; `sqlite-store.test.ts` 697–710 |
| Mail page keys in use: `j k o u x e s v c r a f t z / ?`, Enter, Shift+U, Shift+I, `#`, `!`, `g`-chords. `b` is free. | `src/ui/shortcuts.ts`; 3d |

### User flows

1. **New mail.** A message arrives in the iCloud Inbox. Within seconds the
   IDLE connection sees `EXISTS`, an Inbox-only round fetches it, the badge
   goes up, and — if the sender is someone the owner has written to and it is
   not bulk — a toast "New mail from Anna Petrova · anna@example.com ·
   **Open**" appears in every BB window. Open goes to the conversation.
2. **Unsubscribe.** In the reading pane of a newsletter: **Unsubscribe** →
   dialog "Unsubscribe from <list name>?" with the method ("One click to
   news.example.com" or "An email to unsubscribe@example.com from
   <your address>"), the privacy line, **Unsubscribe** / **Cancel**. Result:
   "Unsubscribed" (one click), "Unsubscribe email queued · Undo" (mailto), or
   a failure with the next option. Afterwards the pane shows "You asked to
   unsubscribe on <date>" and **Archive all from this list** (an ordinary
   archive of the stored messages of that list in this Inbox).
3. **Snooze.** `b` (or **Snooze** in the toolbar or selection bar) opens a
   menu: Later today, Tomorrow morning, This weekend, Next week, Pick a date
   and time. The first time per account a dialog asks "Create a folder
   'Snoozed' in <account>? Snoozed mail waits there and comes back to the
   Inbox at the time you pick." with **Create folder**, **Use an existing
   folder…** and **Cancel**. Then a toast "Snoozed until Tue 08:00 · Undo".
   The Snoozed folder in the rail lists them with "until Tue 08:00"; **Return
   now** brings one back.
4. **Block.** **Block** in the reading pane's sender menu or the toolbar
   overflow → dialog: **Block <address>** or **Block everyone at <domain>**
   (domain hidden for public mail providers), a note when the owner has
   written to them ("You have written to this sender 4 times"), a checkbox
   "Also move the N stored messages from them to Spam" (checked), **Block** /
   **Cancel**. Toast "Blocked · Undo". Mail settings → **Blocked senders**
   lists rules with **Unblock**.
5. **Filters.** Above the list: `Unread` `Flagged` `Attachments` toggles; the
   list reloads; an empty result says "No unread conversations here" with
   **Clear filters**.
6. **Agent triage.** The owner asks: "go through my inbox". The agent calls
   `mail_inbox`, maybe `mail_read`, then `mail_triage` with 12 items. The
   thread shows a card "Review 12 inbox actions": groups (Archive 5, Mark
   read 3, Snooze 1, Spam 1, Unsubscribe 1, Reply 1), each row with sender,
   subject, date, account, the agent's note and a checkbox. The owner unticks
   two and clicks **Apply 10**. The row then shows "Applied 10 of 12 ·
   Undo". The agent learns which items ran and which reply ids it may draft,
   and drafts that reply with `mail_propose` (its own card).

### Data model and migration

Migration element **8** is appended to `MIGRATIONS` in
`src/adapters/bb/sqlite-store.ts`. Elements 0–7 are frozen and keep their SHA
pins in "shipped migration elements are unchanged"; element 8's hash joins
the pin in the docs-and-listing task. As in 3c resolution 17, the new tables
carry no `REFERENCES`; deletes are explicit. Timestamps are ISO TEXT.

```sql
-- unsubscribe methods and their trust, parsed at sync; NULL = not known
-- (synced before element 8, or a source without headers)
ALTER TABLE messages ADD COLUMN unsubscribe_json TEXT;

-- the account's snooze folder; NULL until the owner created or chose one
ALTER TABLE accounts ADD COLUMN snooze_folder TEXT;

-- why the plugin made a draft the owner did not write: 'unsubscribe' or NULL
ALTER TABLE compose_drafts ADD COLUMN purpose TEXT;

CREATE TABLE snoozes (
  message_id TEXT PRIMARY KEY,      -- messages.id (kept across our own moves)
  account_id TEXT NOT NULL,
  return_to TEXT NOT NULL,          -- folder path to return to (the Inbox it came from)
  due_at TEXT NOT NULL,
  state TEXT NOT NULL,              -- 'moving' | 'snoozed' | 'returning'
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX snoozes_due ON snoozes(state, due_at);
CREATE INDEX snoozes_account ON snoozes(account_id);

CREATE TABLE block_rules (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,               -- 'address' | 'domain'
  value TEXT NOT NULL,              -- lower case; domain in ASCII (punycode)
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX block_rules_value ON block_rules(kind, value);

CREATE TABLE unsubscribes (
  account_id TEXT NOT NULL,
  list_key TEXT NOT NULL,           -- normalized List-Id, else the From address
  method TEXT NOT NULL,             -- 'one_click' | 'mailto'
  state TEXT NOT NULL,              -- 'done' | 'redirected' | 'failed' | 'queued' | 'sent' | 'cancelled'
  outbox_id TEXT,                   -- mailto: the outbox row
  requested_at TEXT NOT NULL,
  PRIMARY KEY (account_id, list_key)
);

CREATE TABLE triage_batches (
  id TEXT PRIMARY KEY,              -- = the card's request id and the undo id
  thread_id TEXT NOT NULL,
  state TEXT NOT NULL,              -- pending | confirming | applying | applied | cancelled | expired | changed | interrupted
  content_hash TEXT NOT NULL,
  view_token_hash TEXT,
  approved_json TEXT,               -- positions the owner approved
  create_snooze_folder_json TEXT,   -- account ids the owner ticked "create Snoozed folder" for
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX triage_batches_thread ON triage_batches(thread_id, state);

CREATE TABLE triage_items (
  batch_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  message_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  action TEXT NOT NULL,             -- archive | reply | snooze | mark_read | spam | unsubscribe
  snooze_until TEXT,
  note TEXT,                        -- the agent's note, ≤ 200 characters, shown as agent text
  outcome TEXT,                     -- after apply: done | skipped_moved | skipped_gone | failed | not_approved
  PRIMARY KEY (batch_id, position)
);
```

- `deleteRows` (every message removal path) also deletes the rows' `snoozes`.
  `deleteAccount` deletes the account's `snoozes`, `unsubscribes` and
  `triage_items`, and every `triage_batches` row left with no items. Block
  rules are not per account (Open question 5). Store tests pin all of it.
- `unsubscribe_json` shape (core type `UnsubscribeInfo`, ≤ 4 KiB, else NULL):
  `{ listKey, listName | null, https: string | null, oneClick: boolean,
  mailto: { address, subject, body } | null, trust: "covered" | "not_covered"
  | "no_dkim" | "untrusted_provider" }`. `trust` is computed at sync from the
  headers (see "Trust rules") and stored, so the reading pane needs no fetch.
- `view_token_hash` stores a SHA-256 of the view token, as 3c's proposals do.
- Caps: 1 000 block rules; 2 000 live snoozes per account; 50 items per
  triage batch; 200 characters per note.

### IMAP IDLE

**Port.** `src/core/ports.ts` gains on `ImapGateway`:

```ts
/** Watches one folder until signal aborts or the connection ends; never writes. */
watchFolder(
  config: ImapConfig,
  path: string,
  onChange: (change: "exists" | "expunge" | "flags" | "reset") => void,
  signal: AbortSignal,
): Promise<WatchEnd>;
type WatchEnd =
  | { kind: "aborted" }
  | { kind: "unsupported" }            // no IDLE capability
  | { kind: "auth" }                   // login refused (ImapAuthError)
  | { kind: "throttled" }              // transient login refusal ("too many connections")
  | { kind: "dropped"; code: string }; // server or network ended it; safe code only
```

**Adapter** (`imapflow-gateway.ts`): a dedicated `ImapFlow` per call with the
usual `toImapflowOptions` plus `socketTimeout: IDLE_SOCKET_TIMEOUT_MS` (5 min)
and `maxIdleTime: IDLE_RESTART_MS` (20 min); `disableAutoIdle` stays true.

1. Connect; without `IDLE` in `client.capabilities` → logout, `unsupported`.
2. `mailboxOpen("INBOX", { readOnly: true })` (EXAMINE): the watch never
   changes flags or `\Recent`.
3. Listeners: `exists` with `count > prevCount` → `"exists"`; `expunge` →
   `"expunge"`; `flags` → `"flags"`; `mailboxOpen` after the first (a new
   UIDVALIDITY) → `"reset"`. Payloads are never read beyond these fields.
4. Loop `while (!signal.aborted && client.usable) await client.idle()`.
   `idle()` resolves whenever IDLE ends: the 20-minute restart, the 5-minute
   recovery NOOP on a quiet socket (imapflow 1250–1300), or a server
   untagged response that ends it; the loop simply enters IDLE again. Every
   restart is a client write, so neither Gmail's nor iCloud's ~29-minute IDLE
   cut-off is reached **[unverified for iCloud's exact value]**.
5. `close` or `error` → resolve `dropped` with the error's safe code
   (`describeImapError`). An abort → `logout` with a 2 s cap, then `close`,
   `aborted`.

The session object of `createSession` is not used: the watch exposes no
commands, so nothing can write through it.

**Supervisor** (`src/adapters/bb/idle-service.ts`, new), started in the
`sync` background service beside the loop and the outbox worker:

- Watches one connection per account on its Inbox, for accounts that are not
  `authFailed`, while the vault is ready and the new setting `instantMail`
  (default on) is true. It starts an account's watch only after that
  account's first ok round of this process (the initial sync does not
  compete with it) and refreshes on account add, remove, password change,
  `authFailed` and setting changes.
- `onChange` → `loop.wake(accountId, { only: "inbox" })`, debounced per
  account: 1 s for `exists` and `reset`, 30 s for `expunge` and `flags` (a
  read on the phone updates the badge without a burst of rounds). The loop's
  10 s wake window still bounds rounds.
- Reconnect backoff (pure, `src/core/idle-policy.ts`): 5 s, 30 s, 2 min,
  5 min, then 15 min; reset after a watch that lasted 10 minutes.
  `throttled` jumps to 15 min. After every reconnect the supervisor wakes an
  Inbox round, so mail that arrived while disconnected (a sleeping Mac) is
  fetched at once.
- `auth` stops the account's watch and wakes a full round, which records the
  refusal as today; the watch never retries a refused login by itself (no
  lockout amplification). `unsupported` stops the watch until the next
  plugin load and logs it once.
- Log lines: `idle <accountId>: watching | dropped (<code>) retry in <n>s |
  unsupported | stopped`. No folder names beyond INBOX, no server text.

**Inbox-only round.** `SyncLoop.wake(accountId, options?: { only?: "inbox" })`.
The pending set becomes a map `accountId → "inbox" | "all"` ("all" wins when
both are asked). `syncAccount(deps, accountId, { ...options, only: "inbox" })`
skips the folder listing and syncs the stored Inbox folder only (pushes, then
fetch, then the window reconcile). The scheduled full round and every other
wake are unchanged. The round runs through the account's write queue, so it
never overlaps SMTP, APPEND, expunge, undo or snooze moves.

**Connections per account.** One watch, plus the existing sequential sync
session (and its listing connection), plus short-lived sessions for undo
copies, folder creation and raw reads. Gmail allows 15 simultaneous IMAP
connections per account; iCloud's limit is not documented **[unverified]**;
the design stays at about four. A throttled login on any connection backs the
watch off to 15 minutes.

### New-mail notifications

**Which messages.** `upsertMessages` returns `{ inserted: string[] }` (rows
created, not rows reattached or re-homed). `syncAccount`'s ok outcome gains
`newInbox: string[]`: rows inserted into the account's Inbox folder by an
**incremental** fetch in this round (never by an initial sync or a folder
reset, which would toast hundreds of old messages).

After an ok round, inside the same queue task (after block rules, below), the
pure core `notifiable(rows, ctx)` (`src/core/notify.ts`, new) keeps a row
when all hold:

- unread, attached, not moving (`move_pending` NULL), still in the Inbox;
- not bulk (`isBulkRow(bulk, from)` false);
- From is not one of the owner's addresses (`ownerAccounts()` addresses);
- From is in `addressesSentTo` — someone the owner has written to;
- no block rule matches;
- `date` (else the fetch time) is at most 6 hours old, so mail fetched after
  BB was off for days is not toasted.

**Delivery.** The server's `NewMailBook` (`src/adapters/bb/new-mail-book.ts`,
memory only, 20 entries, 10-minute TTL) stores the kept rows' ids under a
random token, unless `notifyNewMail` is off or the server's local time is
inside `quietHours`. It publishes `mail-new` (`NEW_MAIL_CHANNEL`) with
`{ token }` only.

**Toast.** A new hook `useNewMailToasts()` runs inside `useUnreadBadge` (the
hook the host mounts in the plugin's scope whether or not the Mail page is
open, app 20066–20079). On `mail-new` it calls `new_mail_get({ token })` and
shows, with `toast()` from the host's sonner (id = token, so a repeated
signal does not stack):

- one sender: title "New mail from <name>", description `<address>`;
- several: "New mail from <name> and N more", description "<n> messages";
- action **Open** → `navigate.toPluginPanel("mail", { subPath:
  threadSubPath(accountId, threadId) })` of the newest one; duration 8 s.

`new_mail_get` returns `{ items: { accountId, threadId, messageId, name,
address }[] }`, newest first, at most 3, plus `more: number`. `name` is the
From display name with `revealHidden` applied, cut to one line and 60
characters, the address when empty. The address is shown so a forged display
name ("Your bank") cannot pass as someone else. The hook skips the toast when
the Mail page is mounted, visible and showing an Inbox (`mailPageLink`), since
the list itself updates there. Every open BB window shows the toast; the
plugin cannot tell windows apart (accepted).

**Settings** (`defineSettings`):

| Key | Type | Default | Text |
| --- | --- | --- | --- |
| `instantMail` | boolean | true | "Instant new mail (IMAP IDLE)" — "Keeps one connection per account open to the Inbox, so new mail appears in seconds." |
| `notifyNewMail` | boolean | true | "Notify about new mail from people you write to" |
| `quietHours` | string | `""` | "Quiet hours" — "HH:MM–HH:MM in this computer's time, e.g. 22:00–08:00. Empty: off." Validated by `experimental_schema` (`^([01]\d|2[0-3]):[0-5]\d[-–]([01]\d|2[0-3]):[0-5]\d$` or empty); a range may cross midnight; equal ends mean off. |
| `agentTriage` | boolean | false | "Let agents propose inbox actions for you to approve" |

During quiet hours nothing is queued for later: when they end, the new mail is
simply unread, and the badge has counted it all along.

### Unsubscribe

**Parsing at sync** (`src/core/unsubscribe.ts`, new, pure; the gateway hands
it `parsed.headers` as `{ key, value }[]`):

- `List-Unsubscribe`: the angle-bracketed entries (RFC 2369), at most 5,
  each ≤ 2 048 characters. The first `https:` entry is `https`; the first
  `mailto:` entry is `mailto`. Other schemes, `http:` included, are ignored.
- `https` must parse with `URL`, have no userinfo, a DNS host (no IP
  literal), no port or 443; anything else → `https: null`.
- `mailto` (RFC 6068): exactly one address, valid per `parseAddress`, ASCII
  domain; `subject` (decoded, one line, ≤ 200, default "unsubscribe") and
  `body` (decoded, ≤ 1 000 characters, plain text); every other parameter
  (`cc`, `bcc`, `in-reply-to`, …) is dropped.
- `oneClick`: `List-Unsubscribe-Post` is exactly `List-Unsubscribe=One-Click`
  (case-insensitive name, trimmed value) and `https` is not null.
- `listKey`: the `List-Id` angle-bracketed id lower-cased, else the From
  address. `listName`: the `List-Id` phrase, else the From name, revealed
  and cut to 80 characters.
- No `List-Unsubscribe` → `unsubscribe_json` stays NULL with no method; a
  source with no headers → NULL (not known).

**Trust rules** (`trustOf(headers, preset)`), decide `trust`:

1. **Trusted authserv-ids** per preset (`TRUSTED_AUTHSERV` in core):
   `gmail` → `mx.google.com`; `icloud` → the id(s) iCloud writes, pinned at
   the live check **[unverified]**; `other` → none, so `trust =
   "untrusted_provider"` (Open question 3).
2. **Which Authentication-Results count.** For each trusted authserv-id, only
   the **topmost** `Authentication-Results` header carrying that id (the one
   the provider added last). RFC 8601 §5 requires the receiving MTA to remove
   forged headers bearing its own authserv-id; the topmost rule also defends
   when it does not **[unverified: live check that a forged
   `Authentication-Results: mx.google.com; dkim=pass` sent from outside does
   not survive or does not sit above Google's own]**. Any A-R with another
   authserv-id is ignored.
3. **A passing signature.** In that header, a `dkim=pass` result with
   `header.d` (and `header.s` / `header.b` when present). No pass →
   `"no_dkim"`.
4. **Covering both headers.** A `DKIM-Signature` header of the message whose
   `d=` equals that `header.d` (case-insensitive), whose `s=` equals
   `header.s` when given, and whose `b=` starts with `header.b` when given,
   must list both `list-unsubscribe` and `list-unsubscribe-post` in its `h=`
   tag (case-insensitive, colon-separated). The A-R vouches that the
   signature verified; the signature's own `h=` names what it covered, which
   is what RFC 8058 §4 asks. Yes → `"covered"`; no → `"not_covered"`.
5. **Domain sense.** `header.d` must equal, or be a parent domain of, the
   From domain or the `https` host (label-wise suffix match on ASCII
   domains). A signature by an unrelated domain → `"not_covered"`. This keeps
   a sender who signed with some throwaway domain from vouching for a URL on
   another host while still accepting the common case of a mailing service
   signing its own unsubscribe host.

One-click is offered only when `oneClick && trust === "covered"`. Otherwise
the mailto method is offered when present. With neither, **Unsubscribe** is
not shown. Unsubscribe is never shown for a message in Spam or Trash (it
would confirm the address to a spammer); the pane says "Use Spam or Block
for mail you never signed up for" there.

**Mail synced before element 8.** `backfillBulk`'s machinery gains a second
pass, `backfillUnsubscribe`: Inbox rows with `bulk = 1` and
`unsubscribe_json` NULL, highest uid first, budget 200 per account and round,
fetching `BODY.PEEK[HEADER.FIELDS (From List-Id List-Unsubscribe
List-Unsubscribe-Post Authentication-Results DKIM-Signature)]` by UID. Same
UIDVALIDITY guard, same `fillWhereNull` rule. When the owner opens such a row
before the backfill reached it, `unsubscribe_info` fetches that one message's
fields the same way through the account queue (PEEK; never `\Seen`).

**The one-click request** (`src/adapters/bb/one-click.ts`, new; the core port
`UnsubscribePoster.post(url, signal): Promise<PostOutcome>`):

- `node:https` `request`, method POST, body exactly `List-Unsubscribe=One-Click`,
  headers `Content-Type: application/x-www-form-urlencoded`,
  `Content-Length`, `User-Agent: Makosh-Mail`, `Accept: */*`. No cookies,
  no `Referer`, no `Authorization`, no agent keep-alive (`agent: false`).
- The URL is the stored `https` value, re-validated (rules above).
- **Address check.** A custom `lookup` resolves the host (`dns.lookup`,
  `all: true`) and refuses when any result is loopback, private (RFC 1918),
  link-local, CGNAT (100.64/10), unique-local (fc00::/7), multicast,
  unspecified, benchmarking (198.18/15), the IETF block (192.0.0/24) or an
  IPv4-mapped form of these; the connection goes to the vetted address, so a
  second lookup cannot rebind it. The BB loopback server is therefore never
  reachable.
- TLS: Node's default CA store and hostname check, `minVersion: "TLSv1.2"`,
  SNI = the host.
- Time limits: 5 s to connect (DNS included), 10 s overall; then the request
  is destroyed and the outcome is `timeout`.
- Response: the status code only. The body is drained up to 16 KiB and
  dropped, never decoded, logged, stored or shown. Response headers are not
  read (no `Set-Cookie`, no `Location`).
- Outcomes: 2xx → `done`; 3xx → `redirected` (not followed: "The list
  answered with a redirect, so it may not have unsubscribed you"); 4xx/5xx →
  `failed` with the code class; network, TLS, address or timeout → `failed`
  with a fixed reason. A failure offers the mailto method when present.
- At most one request per message per 10 minutes and 30 per hour in total
  (`UnsubscribeRate`, memory), so a looped client caller cannot turn the
  plugin into a request generator.

**The mailto request.** `unsubscribe_run` with `method: "mailto"`:

- Creates a draft with `purpose = 'unsubscribe'` through
  `createComposeDraft`: From by `replyIdentity` (the address the list mail
  came to, 3d), To the mailto address, the mailto subject and body as plain
  text, no signature, no quote, no attachments.
- Queues it at once with `queueSend` (origin `owner`, or `agent` when it
  comes from a triage card), so it keeps the 10 s Undo and the Outbox row
  ("Unsubscribe request"). Pre-send checks are skipped.
- `writeServerCopy` and the outbox worker's server-copy tick skip
  `purpose = 'unsubscribe'` drafts, so they never reach the account's Drafts
  folder. Undo of the send discards the draft (it does not become an owner
  draft). Sent copies follow the account's `sentCopy` policy like any send.
- The `unsubscribes` row moves `queued → sent | cancelled | failed` with the
  outbox row.

**Privacy.** The dialog always says: "Unsubscribing tells the sender this
address is read. Do it only for lists you signed up for; for anything else
use Spam or Block." The mailto method adds "An email from <your address>
goes to <address>." and, when the mailto domain is not the From domain or a
parent of it, "This address is not at the sender's domain."

### Snooze

**Folder.** `accounts.snooze_folder` holds the path. With it NULL a snooze
call answers `needsFolder` and the page shows the confirmation dialog:

- **Create folder** → `snooze_folder_create({ accountId })`: a new
  `ImapGateway.createFolder(config, name)` (imapflow `mailboxCreate`) inside
  the account queue with the name "Snoozed"; if the server refuses that name
  or it exists as a non-selectable folder, "Snoozed (Makosh)" is tried once
  (Open question 8). `created: false` (it already existed) is accepted:
  the owner asked for that folder. Then the listing is refreshed and the
  path stored.
- **Use an existing folder…** → a folder picker (the move dialog) →
  `snooze_folder_use({ accountId, path })`; refused for Inbox, Sent, Drafts,
  Spam, Trash and All Mail.
- The rail shows the folder like any folder; the store gives it the virtual
  role `snoozed` only for display (an icon and the "until" column).

`CREATE` is a new server write. README and `PLUGIN_OVERVIEW.md` "What it
changes on the server" gain: "Snooze creates one folder, 'Snoozed', when you
confirm it, and moves snoozed mail there and back."

**Snoozing** (`message_snooze`): input like `message_action` (`messageIds`,
`folder` or `role`, `undoId`) plus `until` (ISO, `now + 5 min` to `now + 365
days`). Allowed sources: Inbox-role folders only. Per account and source:
`queueMove(ids, snooze_folder)` and one `snoozes` row per id (`moving`,
`return_to = source`) in the same transaction; the sync is woken. The undo
book records action `snooze` (below).

**State machine** (`src/core/snooze.ts`, pure `planSnoozes(rows, now)`):

| Row now | Snooze state | Step |
| --- | --- | --- |
| In the source, `move_pending = snooze folder` | `moving`, not due | wait |
| Same, due | `moving` | `cancelMove` (CAS) and delete the snooze: it never left |
| In the snooze folder, nothing pending | `moving` | → `snoozed` |
| Same | `snoozed`, due | `queueMove(id, return_to)` + `setDesired({ seen: false })` → `returning` |
| In `return_to`, nothing pending | `returning` | delete the snooze (done) |
| `return_to` gone or not selectable | `snoozed`, due | return to the account's Inbox instead |
| Anywhere else, or gone | any | delete the snooze quietly (the owner moved it on another device) |
| Move back cancelled after refusals | `returning` | → `snoozed` with `due_at = now + 15 min`; the account's `lastError` names it |

The flag change is pushed with the move: sync pushes STORE before MOVE in
the same folder session, so the message arrives in the Inbox unread.

**Timer.** `SnoozeClock` in the `sync` service: on start, every minute, and
after each account's round end (`onRoundEnd`), it runs `planSnoozes` over
due and in-flight rows (at most 200 per account per tick) inside
`queue.run(accountId, …)` and wakes the accounts it moved. So overdue
snoozes return at the first tick after a start. Nothing runs while the vault
is not ready or the account is `authFailed`.

**Return now** (`message_unsnooze({ messageIds })`): sets `due_at = now` and
runs the tick for those accounts.

**Lists.** `ThreadSummary` gains `snoozedUntil: string | null` (the earliest
`due_at` of the thread's rows in the viewed folder), shown as "until Tue
08:00" in the Snoozed folder and on the conversation header.

**Presets** (page, local time): Later today (now + 3 h, rounded up to the
hour; hidden after 18:00), Tomorrow 08:00, This weekend (Saturday 08:00;
hidden on Saturday and Sunday), Next week (Monday 08:00), Pick a date and
time. The page sends UTC ISO.

**Limits.** Snooze returns only while BB runs; on the phone the message sits
in Snoozed until then. Gmail: the folder is a label; MOVE into it removes the
Inbox label and adds Snoozed, and the return MOVE does the reverse **[unverified
live]**. A message with neither Message-ID nor Gmail id that the
destination's sync cannot reattach loses its row, and its snooze with it
(3d's same limit).

### Block a sender or a domain

**Rules** (`src/core/blocking.ts`, new, pure): `matchesBlock(from, rules)`;
`blockCandidates(address)` gives `address` and, unless the domain is in
`PUBLIC_MAIL_DOMAINS` (a fixed list: gmail.com, googlemail.com, icloud.com,
me.com, mac.com, outlook.com, hotmail.com, live.com, msn.com, yahoo.com,
aol.com, proton.me, protonmail.com, gmx.com, gmx.net, gmx.de, mail.com,
fastmail.com, yandex.ru, ya.ru, mail.ru, bk.ru, list.ru, inbox.ru, rambler.ru),
the `domain`. A domain rule matches the domain and its subdomains. A rule for
one of the owner's own addresses or their domains is refused (`invalid`, "You
cannot block your own address").

**Adding** (`block_add({ messageId, kind, moveExisting, undoId })`):

1. Insert the rule (an existing one is reused).
2. Move the message's conversation members in non-Spam folders to the
   account's Spam folder (`resolveActionDestination("spam", …)`), and with
   `moveExisting` every stored Inbox row of every account whose From matches,
   through the same grouping as `runMessageAction`.
3. Record undo action `block` with the groups and `ruleId`.

**Applying** (in the sync task after an ok round, before notifications): the
round's `newInbox` rows whose From matches a rule are moved with `queueMove`
to that account's Spam folder; the loop is woken once. Only new Inbox mail is
moved; nothing already stored moves without the owner's `moveExisting`. An
account with no Spam folder logs `block <accountId>: no spam folder` and
leaves the mail. A message from one of the owner's addresses is never moved.

**Removing** (`block_remove({ id })`, Mail settings → Blocked senders) deletes
the rule only; mail already in Spam stays there (the settings list says so).

**Limits.** Blocking is local: mail from a blocked sender reaches the Inbox on
the server and the phone, and is moved when BB's next round sees it (in
seconds with IDLE, at the next start otherwise). A From header can be forged,
so blocking moves to Spam and never deletes.

### Undo for snooze and block

`UndoRecord.action` widens to `MessageAction | "snooze" | "block" |
"triage"`; `UndoRecord` gains `snoozeIds?: string[]`, `ruleId?: string`.

- **snooze**: `planUndo` treats it as a move to the snooze folder (cancel the
  pending move or move back to `source`); `runUndo` deletes the recorded
  snooze rows in the same queue task before queueing the moves back.
- **block**: `runUndo` deletes `ruleId` first, then undoes the moves like a
  `spam` action.
- **triage**: one record holds the approved items' groups (moves, flag
  changes, snoozes). Unsubscribe items are not undoable (a POST cannot be
  taken back; a mailto keeps its own outbox Undo) and the row says so.
- Toast texts in `undoToastText`: "Snoozed until <time>", "Blocked <n>
  conversations", and for the triage row "Applied N actions".

Everything else in 3d's undo (one slot, 10 minutes, `undoId` from the page,
put-back of failed groups) holds.

### Quick filters

- `threads_list` input gains `filter: z.object({ unread: z.literal(true)
  .optional(), flagged: …, attachments: … }).optional()`.
- `listThreads` and `listThreadsAll` gain `filter`. A thread qualifies when a
  member row in the viewed folder (or the role's folders), not moving,
  matches every requested condition on the same row: `is_read = 0`,
  `is_flagged = 1`, `has_attachments = 1`. Keyset paging by (last date,
  id) is unchanged; the conditions are `EXISTS` subqueries on indexed
  columns. Store tests cover paging across a filtered page boundary.
- The page keeps the toggles per view while it is open; a view change keeps
  them, a reload clears them. Search mode hides them (search has `is:unread`).
- The toggles sit in the list header (`src/ui/thread-list.tsx`) as a
  `ToggleGroup` with `aria-pressed`; keyboard: Tab-reachable, no new hotkeys.

### Agent triage

**Tools** (registered always, offered by `configure` only while
`agentTriage` is on; `execute` re-checks the setting):

- `mail_inbox({ accountId?, unreadOnly?, limit? })` (default 30, at most
  100): Inbox messages newest first, one per dedup key, not moving: `id`,
  account address, date, From name and address, subject, a 200-character
  snippet, `unread`, `flagged`, `bulk`, `unsubscribe` (`"one_click"`,
  `"email"` or null), `snoozedUntil`. The output starts with the
  untrusted-content notice.
- `mail_read` is offered with `agentTriage` too (the agent needs the text to
  judge); `mail_search` stays under `agentTools`.
- `mail_triage({ items, summary? })`: `items` 1–50 of `{ messageId, action:
  "archive" | "reply" | "snooze" | "mark_read" | "spam" | "unsubscribe",
  snoozeUntil?, note? }`; `summary` ≤ 160 characters, one line, shown as the
  agent's text.

**Validation at propose time** (`src/core/triage.ts`, new; refuses the whole
call with a fixed text naming the item position, never message text):

- every `messageId` exists, is attached, sits in an Inbox-role folder and is
  not moving; no id twice;
- `snooze` needs `snoozeUntil` in (now + 5 min, now + 365 days]; others must
  not carry it;
- `unsubscribe` needs a known method (one-click with `trust = "covered"`, or
  mailto); `unsubscribe_json` NULL refuses "Unsubscribe options of item N
  are not known yet; leave it out or ask the owner to open it";
- notes: one line, ≤ 200 characters; tag characters and Hangul fillers are
  refused as in 3c resolution 20;
- caps (`TRIAGE_CAPS`): 1 pending card per thread, 3 in total, 6 per thread
  per hour, 30 per day; 10-minute cool-down after 3 cancelled cards in a
  thread.

**Binding.** The batch and its items are frozen in `triage_batches` /
`triage_items`; `content_hash` is SHA-256 over the canonical JSON of the
items (position, message id, account id, action, snooze time, note) and the
summary. `requestInput` gets `rendererId: "agent-triage"`, title "Review
inbox actions", payload `{ batchId, contentHash }`, `timeoutMs` 24 h.

**The card** (`src/ui/triage-card.tsx`, host-free, Testing Library):

- loads `triage_view({ batchId, contentHash })`, which recomputes the hash,
  issues a one-time view token and returns, per item, what the **store** says
  about the message — From name and address, subject, date, account, folder —
  with `revealHidden` applied, plus the frozen action, snooze time and the
  agent's note under an "Agent's note" label (plain text, links not
  clickable); and `available: false` with a reason when the message moved or
  went away since;
- groups items by action with counts, one checkbox per item, **Select all** /
  **Select none** per group. Defaults: every available item ticked except
  **Unsubscribe** items, which start unticked and show the method, host or
  address, and the privacy line;
- for snooze items in an account without a Snoozed folder: a separate
  checkbox "Create a 'Snoozed' folder in <account>" (unticked); those items
  stay disabled until it is ticked;
- **Apply N** (N = ticked available items) and **Cancel**; Apply is disabled
  at 0.

**Submit** value `{ action: "apply", batchId, contentHash, viewToken,
approved: number[], createSnoozeFolder: string[] }` (≤ 2 KiB). As in 3c
resolution 8, `describeSubmission` runs the whole check (strict parse, the
closure's `batchId`, CAS `pending → confirming`, both hashes, the view token,
expiry, positions in range and available, `createSnoozeFolder` ⊆ accounts of
snooze items) and stores `approved_json`; a stale token follows 3c
resolution 21 (card reopened). Its title is "Approved N inbox actions" or
"Not applied: the batch changed"; payload `{ batchId }`.

**Apply** (after `requestInput` resolves; state `applying`):

1. Create the ticked Snoozed folders (account queue).
2. Per account, group the approved items: archive, spam and mark read go
   through `runMessageAction`'s grouping; snooze through the snooze path;
   unsubscribe through the unsubscribe path (`origin: "agent"` for mailto);
   reply items do nothing here.
3. One undo record under `undoId = batchId` (the undo book's single slot).
4. Per-item `outcome`; state `applied`. A restart while `applying` marks the
   batch `interrupted` at start; nothing more runs, and the row says "A
   restart interrupted this; check your Inbox". `pending` and `confirming`
   at start → `expired` (3c resolution 18's rule).

**Agent result** (fixed sentences plus ids the agent already had): "The
owner approved N of M actions. Done: archived a, marked read b, snoozed c,
moved d to Spam, unsubscribe requested for e. Not approved: <message ids>. Do
not propose those again unless the owner asks. Replies approved for: <message
ids> — draft each with mail_propose; the owner reviews every reply
separately." Skipped items are listed as "skipped (moved since)".

**Timeline row** (`experimental_timelineRenderer` kind
`makosh-mail/agent-triage`): "Applied N of M" with per-group counts, and
**Undo** while the undo record lives (expanded row only, 3c resolution 18).
Undo calls `action_undo({ undoId: batchId })`.

### RPC contract (`src/core/contract.ts`)

New or changed, all owner RPCs reachable by `client` callers like every
earlier one (3b resolution 1); writes refuse plugin callers
(`refusePluginCaller`).

| Method | Input | Output |
| --- | --- | --- |
| `threads_list` | gains `filter?` | `ThreadSummary` gains `snoozedUntil` |
| `new_mail_get` | `{ token: z.string().max(64) }` | `{ items: NewMailItem[], more }`; `not_found` for an expired token |
| `unsubscribe_info` | `{ messageId }` | `{ methods: { oneClick: { host } \| null, mailto: { address, subject, foreignDomain } \| null }, trust, listName, already: { state, at } \| null, hidden: boolean }` (`hidden`: Spam/Trash) |
| `unsubscribe_run` | `{ messageId, method: "one_click" \| "mailto", requestId: z.uuid() }` | `{ outcome: "done" \| "redirected" \| "failed" \| "queued", reason: string \| null, outboxId: string \| null }` |
| `message_snooze` | `{ messageIds ≤ 200, folder \| role, until: z.iso.datetime(), undoId? }` | `{ groups, undoable, needsFolder: { accountId, proposedName }[] }` |
| `message_unsnooze` | `{ messageIds ≤ 200 }` | `okOutput` |
| `snooze_folder_create` | `{ accountId }` | `{ path }` |
| `snooze_folder_use` | `{ accountId, path }` | `okOutput` |
| `block_add` | `{ messageId, kind: "address" \| "domain", moveExisting: boolean, undoId? }` | `{ ruleId, groups, undoable }` |
| `block_list` | `{}` | `{ rules: { id, kind, value, createdAt }[] }` |
| `block_remove` | `{ id }` | `okOutput` |
| `block_check` | `{ messageId }` | `{ address, domain: string \| null, sentToCount, storedCount }` (for the dialog) |
| `triage_view` | `{ batchId, contentHash }` | the card's content and view token, or `{ state }` |
| `triage_status` | `{ batchId }` | the row's state, counts and `undoable` |
| `action_undo` | unchanged | unchanged; also undoes `snooze`, `block` and `triage` records |

`unsubscribe_run` is idempotent per `requestId`. It refuses (`conflict`) a
method that `unsubscribe_info` would not offer now (trust is recomputed from
the stored info), a message in Spam or Trash, and a rate-limited call
("Too many unsubscribe requests; try again later").

### UI (summary)

- **Reading pane** (`src/ui/reading-pane.tsx`): **Unsubscribe** in the
  header row for messages with a method; **Snooze** and **Block** in the
  toolbar; "You asked to unsubscribe on …" and **Archive all from this list**;
  "until …" and **Return now** for snoozed mail.
- **Dialogs** (`src/ui/unsubscribe-dialog.tsx`, `snooze-menu.tsx`,
  `snooze-folder-dialog.tsx`, `block-dialog.tsx`; new, host-free): as in the
  flows. Default focus on Cancel for Unsubscribe and Block.
- **Selection bar** and shortcuts: `b` → snooze menu; the shortcut sheet
  gains "b — Snooze".
- **List header**: the three filter toggles; Snoozed-folder rows show
  "until …".
- **Mail settings** (`src/ui/mail-settings.tsx`): a **Blocked senders**
  section (list, Unblock with confirmation) and the account's Snoozed folder
  name with **Change…**.
- **Toasts** in `app.tsx` (3b resolution 17): new mail, snooze, block,
  unsubscribe results.
- **Triage card and row**: `src/ui/triage-card.tsx`, `src/ui/triage-row.tsx`
  with thin adapters in `app.tsx`, registered as `pendingInteraction({ id:
  "agent-triage" })` and `experimental_timelineRenderer({ kind:
  "makosh-mail/agent-triage" })`.

### Security and privacy

- **Outbound HTTP** exists for the one-click POST only, in one adapter file.
  It runs only after the owner's confirmation (Mail dialog) or tick (triage
  card); https on port 443 to a DNS name; the URL comes from the
  `List-Unsubscribe` header only, never from the body, the agent or the page;
  vetted public addresses only, pinned against rebinding; no redirects
  followed, no cookies, no `Referer`, no response body or headers read; 5 s /
  10 s limits; rate-limited. The host, path and status never reach a log
  (`unsubscribe <messageId>: done | redirected | failed (<class>)`).
- **DKIM trust** rests on the owner's provider's Authentication-Results:
  trusted authserv-ids per preset, the topmost such header only, the passing
  signature's `h=` covering both list headers, and domain sense between
  `header.d` and the From domain or the URL host. A sender can write any
  header, but cannot make the provider's topmost A-R say `pass` for a
  signature it did not make. Generic accounts get mailto only.
- **The privacy cost** of unsubscribing (a live address confirmed) is stated
  in every confirmation; Spam and Trash never offer it; triage unsubscribe
  items start unticked.
- **mailto requests** are ordinary sends: the owner's identity, a fixed To,
  the header's subject and body capped and shown in the dialog, the 10 s
  Undo, no other mailto parameters.
- **Blocking** rules are created only by the owner's click in Mail
  (`block_add` refuses plugin callers). No agent tool creates, changes or
  lists rules, and triage has no block action. A rule cannot target the
  owner's own addresses, and a domain rule cannot target a public mail
  provider. Blocking only moves to Spam.
- **Snooze folder creation** needs the owner's confirmation (dialog) or a
  ticked checkbox on a triage card; it is the only `CREATE` the plugin sends.
- **Triage card.** Inside the plugin's own surfaces it cannot be forged: the
  tool only freezes a batch and waits; no tool argument, tool result or other
  RPC applies it; the submit needs the view token only `triage_view` issues;
  `describeSubmission` checks the batch id of its own closure. The 3c
  accepted limit holds unchanged: an agent with shell access to the BB server
  can read and answer the form (`bb thread interactions show/respond`) and
  call `triage_view` through `bb plugin rpc call` (3c "Accepted limit",
  resolution 1). Mitigations: `agentTriage` off by default; no destructive
  action exists; every applied batch is undoable for 10 minutes except
  unsubscribe; unsubscribe items start unticked; caps per thread and day;
  README, `PLUGIN_OVERVIEW.md` and `skills/mail/SKILL.md` state it.
- **Prompt injection.** Mail can tell the agent to archive or unsubscribe
  everything. The card describes each message from the store, shows the
  agent's note as agent text, needs a tick per item, and cannot delete,
  forward or send anything but the mailto unsubscribe. Replies still need
  their own `mail_propose` card.
- **Toasts** carry the sender's display name (hidden characters removed, one
  line, 60 characters) and address, nothing else; only for people the owner
  has written to. Realtime `mail-new` carries a random token; `new_mail_get`
  answers within 10 minutes and only for the tokens issued.
- **IDLE** is read-only (EXAMINE, no session commands exposed); it holds no
  mail data beyond counts; it never retries a refused login.
- **Logs and realtime.** Lines carry account ids, message ids, counts and
  fixed codes. No address, rule value, URL, host, folder name (except
  INBOX), subject or note reaches a log, an error text or a realtime payload.

## Testing

Core with fakes, the store on real SQLite, adapters with recorded fixtures or
local servers, UI with Testing Library and jsdom, as before. Tests are
colocated. Fixtures use made-up text and addresses on `example.com` /
`example.org` only.

- **IDLE** (`idle-policy.test.ts`, `idle-service.test.ts`,
  `imapflow-gateway.test.ts`): backoff sequence and reset after 10 min;
  `throttled` → 15 min; `auth` stops and wakes a full round, never retries;
  `unsupported` stops until reload; watch starts only after the first ok
  round; debounce per change kind; reconnect wakes an Inbox round; abort ends
  every watch promptly (logout capped); a stub client: EXAMINE (`readOnly:
  true`), `exists` with `count > prevCount` only, `mailboxOpen` after the
  first → `reset`, the loop re-enters `idle()` after each resolution, no
  STORE/MOVE/COPY/APPEND ever called.
- **Inbox-only round** (`sync.test.ts`, `sync-service.test.ts`): no listing
  call; only the Inbox is pushed and fetched; "all" wins over "inbox" in the
  pending map; the wake window still coalesces; the round runs in the queue.
- **Notifications** (`notify.test.ts`, server tests): `newInbox` excludes
  initial sync, reset, reattach and re-home; each filter rule (read, bulk,
  own, never written to, blocked, older than 6 h, moving); quiet hours across
  midnight, equal ends, empty; `notifyNewMail` off; the book's TTL and size;
  realtime payload is `{ token }` only; `new_mail_get` reveals hidden
  characters and caps names; the hook skips the toast while the Inbox view is
  visible; one toast id per token.
- **Unsubscribe parsing and trust** (`unsubscribe.test.ts`): entries,
  schemes, `http:` ignored, userinfo/IP/port refused, mailto params dropped,
  `oneClick` exact match; trust: Gmail A-R pass with covering `h=` →
  covered; missing `list-unsubscribe-post` in `h=` → not_covered; A-R from
  an untrusted authserv-id ignored; a forged second `mx.google.com` A-R below
  the real one ignored; a forged one above with `fail` in the real one →
  the topmost decides (documented); `header.s`/`header.b` selection among two
  signatures; domain sense (parent of From, parent of URL host, unrelated →
  not_covered); `other` preset → untrusted_provider.
- **One-click adapter** (`one-click.test.ts`, local HTTPS server with a test
  CA injected through an adapter option): body and headers exact, no cookie
  sent after a `Set-Cookie`, 302 not followed → `redirected`, 500 →
  `failed`, slow server → `timeout` at 10 s (fake timers), body over 16 KiB
  drained and dropped; the address check refuses 127.0.0.1, ::1, 10/8,
  192.168/16, 169.254/16, 100.64/10, fc00::/7 and `::ffff:10.0.0.1`
  (lookup stub); the connection uses the vetted address; rate limits.
- **mailto path** (server tests): draft with `purpose`, From by
  `replyIdentity`, no signature; queued with Undo; never written to the
  server Drafts; Undo discards the draft; `unsubscribes` row states; Spam and
  Trash refused.
- **Snooze** (`snooze.test.ts`, store and server tests): every row of the
  state table; flags pushed before the move back; overdue at start; `due`
  while still `moving` cancels the move; return target gone → Inbox; owner
  moved it elsewhere → snooze deleted; cancelled return re-armed in 15 min;
  `needsFolder` then create (fake gateway `createFolder`, `created: false`
  accepted, fallback name once); `snooze_folder_use` refuses role folders;
  undo of a snooze before and after the push; `snoozedUntil` in summaries;
  `deleteRows` deletes snoozes.
- **Block** (`blocking.test.ts`, server tests): matching (address, domain,
  subdomain, case, punycode); public domains have no domain candidate; own
  address and own domain refused; `moveExisting` across accounts; new Inbox
  mail moved after a round, stored mail not moved without `moveExisting`;
  no Spam folder → left and logged; undo removes the rule and moves back;
  `block_remove` does not move mail; blocked senders never toast.
- **Filters** (store tests): each flag, combinations on the same row (not
  across rows of a thread), paging across a filtered page boundary in a
  folder and in a merged role, moving rows ignored.
- **Triage** (`triage.test.ts`, server tests, `triage-card.test.tsx`):
  validation refusals with position-only texts; caps and cool-down; hash
  binding; `triage_view` recomputes the hash and rotates the token;
  `describeSubmission` check (stale token reopens, changed refuses, positions
  out of range refused, unavailable positions refused, foreign batch id
  refused); apply runs only approved positions through the owner paths;
  reply items run nothing; snooze items without a ticked folder refused;
  unsubscribe defaults unticked on the card; the agent result lists ids and
  counts only; restart in `applying` → `interrupted`; the row's Undo calls
  `action_undo` with the batch id; card renders store data with hidden
  characters revealed and the note as agent text.
- **Store**: element 8 appended; elements 0–7 byte-identical (SHA pin);
  explicit deletes on account removal; `unsubscribe_json` filled by sync from
  fixtures with and without the headers; backfill pass for `bulk = 1` Inbox
  rows.
- **Logs and realtime**: a spy logger and realtime recorder over a
  notification, a one-click unsubscribe, a mailto unsubscribe, a snooze
  return, a block and a triage batch see no address, URL, host, subject, rule
  value or note.

### Live verification (owner's accounts, after the build)

1. iCloud and Gmail: a message sent from another account appears within
   seconds; the log shows `watching`; leave BB idle for 40 minutes and check
   the watch is still alive (no `dropped` or a clean reconnect); put the Mac
   to sleep for 10 minutes, wake it, and check the catch-up round.
2. Record iCloud's `Authentication-Results` authserv-id(s) from a real
   newsletter's source (Mail → Headers) and pin them in `TRUSTED_AUTHSERV`.
3. Send a message to the Gmail and iCloud accounts with a forged
   `Authentication-Results: <provider id>; dkim=pass header.d=example.com`
   header and check where it lands relative to the provider's own (the
   topmost rule) or whether it is removed.
4. One-click unsubscribe from a real list (Gmail and iCloud) and confirm the
   list's confirmation; a mailto unsubscribe with Undo, then one sent.
5. Snooze on iCloud and Gmail: folder created on confirmation, the message
   gone from the Inbox on the phone, back unread at the due time; quit BB
   over a due time and confirm the return at the next start; Gmail label
   behaviour on both moves; whether Gmail refuses the label name "Snoozed".
6. Block an address and a domain; send from it; it lands in Spam within
   seconds; undo.
7. Toast from a known sender while the Mail page is closed and while it shows
   another folder; quiet hours silence it; Open goes to the conversation.
8. A triage batch from an agent with a subset approved; Undo from the row.

## Tasks

Each task ends with `npm run check`. The last also runs `npm run build` and
`node ../../scripts/check-manifests.mjs`. Paths are under `plugins/mail/`.

1. **Core: policies.** `src/core/idle-policy.ts`, `notify.ts`,
   `unsubscribe.ts` (parsing and `trustOf`), `snooze.ts` (`planSnoozes`,
   presets), `blocking.ts`, `triage.ts` (+ tests); `undo.ts` widened
   actions and `planUndo` for `snooze`/`block`/`triage`.
2. **Core: ports and contract.** `ports.ts`: `ImapGateway.watchFolder`,
   `createFolder`, `UnsubscribePoster`, store methods (`upsertMessages`
   returning `inserted`, snoozes CRUD, block rules, unsubscribes, triage
   batches/items, `listThreads` filter, `unsubscribeUnknown`,
   `fillUnsubscribe`); `sync.ts`: `only: "inbox"`, `newInbox`;
   `contract.ts`: the RPC schemas, `NEW_MAIL_CHANNEL`.
3. **Store and migration 8.** `sqlite-store.ts`: element 8, the methods
   above, `unsubscribe_json` in the upsert, filters in both list queries,
   `snoozedUntil`, explicit deletes (+ tests).
4. **Gateway.** `imapflow-gateway.ts`: `watchFolder`, `createFolder`,
   unsubscribe headers from `parsed.headers`; the backfill's extra pass
   (+ tests).
5. **Adapters.** `src/adapters/bb/idle-service.ts`, `new-mail-book.ts`,
   `one-click.ts`, `snooze-clock.ts`; `sync-service.ts` pending map and
   post-round steps (block rules, notifications, snooze tick hook) (+ tests).
6. **Server wiring: owner features.** `server.ts`: settings, the new RPCs,
   the service wiring (IDLE, snooze clock), `unsubscribe_run` (one-click and
   mailto), `message_snooze`, `block_add`, undo extensions, `purpose` drafts
   skipped by `writeServerCopy` and the worker tick (+ `server.test.ts`).
7. **Server wiring: triage.** `mail_inbox`, `mail_triage`, `triage_view`,
   `triage_status`, `configure` with `agentTriage`, start recovery
   (+ tests).
8. **UI: list and reading pane.** Filters, Unsubscribe, Snooze, Block,
   "until", Return now, dialogs, `b` and the shortcut sheet (+ tests).
9. **UI: settings, toasts, triage.** Blocked senders and the Snoozed folder
   in settings; `useNewMailToasts`; `triage-card.tsx`, `triage-row.tsx` and
   their registrations (+ tests).
10. **Docs and listing.** `README.md`, `PLUGIN_OVERVIEW.md` ("What it changes
    on the server": CREATE of the Snoozed folder, moves for snooze and block,
    the one-click POST; privacy of unsubscribe; the triage shell limit),
    `package.json` `bb.description`, root `marketplace.json`,
    `skills/mail/SKILL.md` (triage instructions), `CHANGELOG.md`,
    `docs/mail-feature-backlog.md` labels for 20, 25, 26, 41, 42, 44, 73,
    element 8's SHA pin. `THIRD_PARTY_NOTICES.md` changes only if code is
    vendored (none planned; no new dependency). Run `check-manifests`,
    `npm run check` and `npm run build`.

## Calls made by me (not the owner)

- IDLE on the Inbox only, read-only (EXAMINE), a dedicated connection per
  account outside the write queue; restart every 20 min and a 5-minute socket
  probe; backoff 5 s → 15 min; never retries a refused login; on by default
  through a new `instantMail` setting.
- An Inbox-only round for IDLE wakes instead of a full account round.
- "Important sender" = an address in `addressesSentTo` (Sent rows and the
  `sent_recipients` ledger), not bulk, not own, not blocked; only mail at
  most 6 hours old; never on initial sync or reset.
- Toasts fired from the badge hook (mounted by the host whether or not the
  Mail page is open), showing name and address, skipped while the Inbox view
  is visible; quiet hours evaluated on the server's local clock; nothing
  queued for after quiet hours.
- One-click trust: provider A-R (topmost per trusted authserv-id) + the
  matching `DKIM-Signature`'s `h=` + domain sense; trust stored at sync.
- One-click network rules: `node:https`, port 443, public addresses pinned,
  no redirects, no cookies, 5 s / 10 s, body drained ≤ 16 KiB, rate limits.
- No Unsubscribe in Spam or Trash; mailto subject and body from the header,
  capped and shown; mailto From by the reply rule; `purpose` drafts never
  copied to the server.
- Snooze presets at 08:00 local; a fallback folder name "Snoozed (Makosh)";
  "Use an existing folder"; return to the Inbox when the origin folder is
  gone; cancelled returns retried in 15 minutes.
- Block rules global across accounts; domain rules refused for public mail
  providers and for the owner's own domains; only new Inbox mail moved
  automatically; Unblock does not move mail back.
- Filters combine on the same row (an unread message that also has
  attachments), not across a thread's rows.
- Triage behind its own setting `agentTriage` with `mail_inbox` and
  `mail_read`; unsubscribe items unticked by default; a separate tick to
  create the Snoozed folder; reply items only release ids for `mail_propose`;
  one undo record per batch; `interrupted` after a restart mid-apply.

## Open questions for the owner

1. **Subject in the toast.** Default sender name and address only. Adding the
   subject shows mail text on screen to anyone nearby and in screen shares.
   *Recommendation:* sender only, no setting in 3e.
2. **Triage gating.** A new setting `agentTriage` (off by default) offers
   `mail_inbox`, `mail_read` and `mail_triage`, independent of `agentTools`
   and `agentPropose` (replies still need `agentPropose`).
   *Recommendation:* yes, a separate setting.
3. **One-click for "other" accounts.** No trusted authserv-id is known for a
   generic IMAP server, so those accounts get mailto only. A per-account
   "trusted Authentication-Results id" field would enable it.
   *Recommendation:* mailto only in 3e; add the field later if needed.
4. **Own DKIM verification.** Verifying signatures ourselves needs DNS and a
   new dependency (for example `mailauth`). *Recommendation:* rely on the
   provider's Authentication-Results in 3e.
5. **Block scope.** Rules apply to every account. *Recommendation:* global.
6. **Move existing mail when blocking.** *Recommendation:* the checkbox
   "Also move the N stored messages to Spam", checked by default.
7. **IDLE default.** *Recommendation:* on (`instantMail` true); one extra
   connection per account while BB runs.
8. **Snooze folder name on Gmail.** Gmail has its own Snoozed view; a user
   label named "Snoozed" may be refused or confusing. *Recommendation:*
   "Snoozed" everywhere, "Snoozed (Makosh)" only if the server refuses;
   the confirmation shows the final name.
9. **After unsubscribing.** *Recommendation:* offer **Archive all from this
   list** as a button; never archive or block automatically.

## Not verified

- iCloud's `Authentication-Results` authserv-id(s) and how many A-R headers
  it adds (one-click on iCloud stays off until pinned). Live step 2.
- Whether Gmail and iCloud remove an incoming forged A-R with their own
  authserv-id (RFC 8601 §5), or where it sits relative to theirs. Live
  step 3; the topmost rule is the defence either way.
- iCloud's IDLE cut-off and its limit on simultaneous IMAP connections;
  Gmail's is 15 per account (Google's documentation, not checked live).
- That imapflow 2.11's manual `idle()` loop with `disableAutoIdle`,
  `maxIdleTime` and a 5-minute `socketTimeout` behaves as read from
  `imap-flow.js` 1250–1300 and 3033–3042 against iCloud and Gmail (NOOP
  probe breaks IDLE, the loop re-enters it).
- That the host calls `experimental_useBadge` in every BB window while the
  Mail page is closed (documented, app 20066–20079), and that
  `useBbNavigate` works inside that hook for the toast's Open.
- That Gmail accepts creating a label "Snoozed", and that UID MOVE between
  INBOX and a user label swaps the two labels.
- That Node's global `dns.lookup` with `all: true` plus a custom `lookup` on
  `https.request` pins the connection in the BB server's Node version (no
  second resolution); pinned by the adapter test.
- That BB's plugin server process is allowed outbound HTTPS (no sandbox is
  declared in the SDK; IMAP and SMTP sockets already work from it).

## Resolutions after the builder check

These override the sections above. Items marked *(owner)* were decided by the owner on 2026-11-15, all as recommended; open questions 1–9 are closed by them. Names below were checked against the current code (`src/core/sync.ts`, `undo.ts`, `compose.ts`, `compose-outbox.ts`, `bulk-backfill.ts`, `ports.ts`, `contract.ts` and `contract.test.ts`, `src/adapters/bb/sqlite-store.ts`, `sync-service.ts`, `undo-book.ts`, `outbox-worker.ts`, `imapflow-gateway.ts`, `server.ts`, `app.tsx`, `src/ui/shortcuts.ts`, imapflow 2.11 `dist/esm/imap-flow.js` and `commands/idle.js`).

1. **Toast: sender only *(owner)*** (open question 1). A new-mail toast shows the sender's display name and address, never the subject or any text. No setting for it in 3e.
2. **Triage behind its own setting *(owner)*** (open question 2).
   - `agentTriage` (boolean, default false) offers `mail_inbox`, `mail_read` and `mail_triage`, independent of `agentTools`. `configure` adds `mail_read` when `agentTools` or `agentTriage` is on (once); `mail_read`'s `execute` accepts either setting.
   - A `reply` item is refused at propose time when `agentPropose` is off: "Item N: replies need the owner's 'Let agents propose mail' setting; leave reply items out" (position only).
   - "Approved for reply" is advisory. The agent result names the ids, but `mail_propose` does not check them: every reply is its own `mail_propose` card, which is the binding approval (3c). Nothing in 3e stores or enforces the reply list.
3. **One-click only on iCloud and Gmail *(owner)*** (open question 3). `TRUSTED_AUTHSERV.other` is empty: those accounts get `trust = "untrusted_provider"` and the mailto method only. No per-account field in 3e.
4. **No own DKIM verification *(owner)*** (open question 4). Trust rests on the provider's `Authentication-Results`, with resolutions 10–12 below. A new dependency (`mailauth`) is considered only if the iCloud live check (live step 2/3) cannot give a sound rule; until then iCloud ships with an empty trusted-id list (mailto only) and the ids are pinned in a follow-up commit after the owner's live check.
5. **Block rules are global *(owner)*** (open question 5). A rule applies to every account. `deleteAccount` never deletes rules.
6. **"Also move stored mail" defaults by kind *(owner)*** (open question 6). The block dialog's checkbox is checked by default for an address rule and unchecked for a domain rule. Its label states the count for the chosen kind (resolution 16).
7. **IDLE on by default *(owner)*** (open question 7). `instantMail` default true.
8. **Snooze folder name by preset *(owner)*** (open question 8, replaces "Snoozed (Makosh)" only on refusal).
   - On the Gmail preset the folder is "Snoozed (Makosh)" from the start, so it is never confused with Gmail's own Snoozed view. On iCloud and "other" it is "Snoozed".
   - The fallback in "Folder" changes accordingly: on iCloud and "other", a refusal or a non-selectable "Snoozed" tries "Snoozed (Makosh)" once; on Gmail a refusal of "Snoozed (Makosh)" is an error ("The server refused to create the folder; choose an existing one"). The confirmation dialog shows the final name (`proposedName` by preset).
9. **After unsubscribing: one button *(owner)*** (open question 9). The pane offers only **Archive all from this list** (an ordinary owner archive of the stored Inbox rows with that list's key in this account). Nothing is archived, blocked or moved automatically.
10. **Gmail's A-R names the signer by `header.i`** (builder finding B1).
    - A `dkim=pass` result names its signer by `header.d`, or else by the domain part of `header.i` (`header.i=@example.com` → `example.com`). Either is accepted; with both, `header.d` is used.
    - The matching `DKIM-Signature` is chosen by `s=` equal to `header.s` (when given) and `b=` starting with `header.b` (when given), and its `d=` must equal, or be a parent domain of, the signer domain from the A-R (label-wise, ASCII, case-insensitive). With neither `header.s` nor `header.b` given, a signature whose `d=` matches that way is taken only when exactly one matches; two or more → `not_covered`.
    - Tag values are read after unfolding and removing all whitespace (CR, LF, SP, HTAB) inside `h=` and `b=` (RFC 6376 §3.5 allows folding anywhere in them); `h=` is then split on `:` and compared case-insensitively.
    - Resolution 13's domain sense uses the signature's `d=`.
11. **Repeated list headers** (B2). A message with more than one `List-Unsubscribe` or more than one `List-Unsubscribe-Post` header gets `trust = "not_covered"` (one-click never offered; mailto is still parsed from the single `List-Unsubscribe` only when there is exactly one, else no method at all). A test pins both cases.
12. **Which Authentication-Results count** (B3, replaces "Trust rules" item 2).
    - The **provider's top block** is the run of headers from the top of the header section down to, not including, the first header whose name is not a trace name of the preset: `Received`, `Authentication-Results`, `ARC-Seal`, `ARC-Message-Signature`, `ARC-Authentication-Results`, `Received-SPF`, `Return-Path`, `Delivered-To`, `X-Received`, plus per preset Gmail `X-Google-*`, `X-Gm-*` and the iCloud names pinned at the live check (`PROVIDER_TRACE_HEADERS` in core).
    - Every `Authentication-Results` header inside that block whose authserv-id is one of the preset's trusted ids counts (iCloud may write separate ids per check, for example `dkim-verifier.icloud.com`; the set is pinned live). An A-R with a trusted id **below** the block, or below the topmost `DKIM-Signature` of the message, is ignored; if the only trusted-id A-R sits there, `trust = "untrusted_provider"`.
    - The passing result may be in any of the counted headers; a `dkim=fail` for the same signature in another counted header makes it `no_dkim` (conflicting provider answers are not trusted).
    - The topmost-only rule and its "forged one above" test are replaced by: a forged trusted-id A-R below the block is ignored; a forged one inside the block is the residual risk that RFC 8601 §5 removal covers (live step 3).
13. **Block moves only matching Inbox mail** (B4, replaces "Adding" step 2).
    - `block_add` moves the clicked message only when it sits in an Inbox-role folder, and with `moveExisting` every stored row of every account whose From matches the rule and that sits in an Inbox-role folder, not moving. Conversation members from other senders, Sent, Drafts, Archive, All Mail and other folders are never moved by a block.
    - The rows are grouped per account and source folder as `runMessageAction` groups them, and moved to that account's Spam folder (`resolveActionDestination("spam", …)`).
14. **Undo groups carry their own change** (B5).
    - `UndoGroup` gains `kind: "move" | "flags" | "snooze"` and `change: FlagChange | null` (the flag change for `flags` groups; null otherwise). `planUndo` reads each group's own `kind` and `change` instead of `flagChangeOf(record.action)`, so a triage record holding archive, spam, mark read and snooze groups undoes each correctly. `UndoGroup.snoozeIds?: string[]` lists the snooze rows a `snooze` group created.
    - `UndoRecord.action` widens to `MessageAction | "snooze" | "block" | "triage"` and is used only for toast texts. `mergeRecord` merges on the same `undoId` regardless of action (the page sends one id per batch; a triage batch's groups arrive in one call), so the `current.action === action` test is dropped.
    - `recordGroups` fills `kind` and `change` from the action that queued each group; existing message_action records get `kind: "move"` or `"flags"`.
15. **IDLE ends and dead peers** (B6).
    - imapflow's `idle()` returns `false` when the server answers IDLE with a tagged NO or BAD. The watch treats that as `{ kind: "dropped", code: "IdleRefused" }` and ends; the supervisor's backoff applies, so a refusing server is never hammered.
    - `maxIdleTime` restarts IDLE **inside** imapflow's IDLE command (`commands/idle.js` 359–375) and does not resolve `idle()`; the loop re-enters `idle()` only when it resolves for another reason (a recovery NOOP, a server response that ends IDLE).
    - Dead-peer detection within 2–3 minutes: `IDLE_SOCKET_TIMEOUT_MS = 75_000`. A quiet socket while idling sends a recovery NOOP after 75 s; a NOOP that has not settled by the next timeout closes the connection (imap-flow.js 1256–1300), so a dead peer is detected after about 150 s. `IDLE_RESTART_MS` stays 20 minutes as the upper bound.
16. **Inbox-only rounds and `newInbox`** (gaps).
    - An Inbox-only round runs `assignThreads` as a full round does. It merges account state: it leaves `lastSyncAt` as it was and never clears or replaces the full round's `lastError`; a problem of its own is appended to the stored `lastError` (de-duplicated). An authentication failure records `authFailed` as today. `saveListing` is not called.
    - Pending moves and flag changes are pushed only for the Inbox in such a round; other folders' pushes wait for the next full round. Snooze returns (queued in the snooze folder) and undo moves therefore wake a full round of the account (`loop.wake(accountId)`), never an Inbox-only one.
    - `newInbox` = rows that `upsertMessages` inserted (not reattached, not re-homed) into an Inbox-role folder by the incremental fetch of uids above the stored `lastUid`, in a folder that was neither initial nor reset this round. Rows backfilled by `reconcile` are never in it.
    - A `newInbox` row whose dedup key already had another row in the account before the insert (mail moved back to the Inbox on the phone, or a second copy) is **returning**: it never toasts; block rules still apply to it unless resolution 17's Spam rule skips it.
    - A snoozed message that returns (`returning` → done) toasts by the same `notifiable` filter, with the 6-hour age measured from the return time (owner decision). Quiet hours and `notifyNewMail` apply.
17. **Block never re-moves a rescued message** (owner decision). Element 8 adds `spam_seen (account_id, dedup_key, seen_at, PRIMARY KEY (account_id, dedup_key))`, written by `upsertMessages` and `completeMove` for every row that lands in a Spam-role folder, and pruned to 180 days at start. Automatic block moves skip a `newInbox` row whose dedup key is in `spam_seen` for its account or in a current Spam-role row: the owner moved it out of Spam on purpose. `block_add` with `moveExisting` follows the same skip. Store tests pin it.
18. **Snooze table details** (gaps).
    - A row in the snooze folder with `uid` NULL (detached after a move without UIDPLUS) is still `moving`: `planSnoozes` waits until the destination's sync reattaches it.
    - When a listing no longer contains `accounts.snooze_folder` (renamed or deleted on the server), `saveListing` clears it (`snooze_folder = NULL`); the folder's rows go with it as today and `deleteRows` deletes their snoozes. The next snooze answers `needsFolder` and asks again. README states that renaming the Snoozed folder elsewhere ends those snoozes (the mail stays in the renamed folder).
19. **One hidden-draft predicate** (gap).
    - Unsubscribe drafts use origin `owner` with `purpose = 'unsubscribe'`, also when the mailto item came from a triage card (the owner's tick is the approval). So no outbox row with origin `agent` lacks a proposal id, and 3c's `cancelSend` branch (`origin === "agent" && draft.proposalId !== null`) is untouched.
    - `isHiddenDraft(draft) = draft.proposalId !== null || draft.purpose !== null` in `src/core/compose.ts` replaces every `proposalId !== null` test that decides visibility: `writeServerCopy` (`compose.ts` 526 and 549), the outbox worker's server-copy tick (`outbox-worker.ts` 122), `ownerDraft` (`server.ts` 1251, so no compose RPC opens one). The proposal flow keeps reading `proposalId` itself.
    - `cancelSend` of a row whose draft has `purpose` deletes the row and the draft in one transaction and returns `draftId: null`; the Outbox row of such a send shows "Unsubscribe request" and offers Cancel and Retry, never Edit.
20. **Quick filters inside the membership list** (gap, replaces "Quick filters" second item).
    - The conditions go inside the existing uncorrelated `IN (SELECT m.thread_id … WHERE … m.move_pending IS NULL …)` of `listThreads` (`sqlite-store.ts` 1679) and `listThreadsAll` (1699) as `AND m.is_read = 0`, `AND m.is_flagged = 1`, `AND m.has_attachments = 1`; no correlated `EXISTS`.
    - `filter` gains `keep: threadId | undefined`: the page sends the open conversation's id, and the membership list adds `OR (m.thread_id = @keep AND <folder or role condition> AND m.move_pending IS NULL)`, so a conversation marked read while open under **Unread** stays listed until the owner opens another one or changes the filter.
21. **Outbound addresses: an allow-list** (gap, replaces "Address check").
    - A resolved address is allowed only when it is public unicast. IPv4: refused when in any block of the IANA IPv4 Special-Purpose Address Registry (including 0.0.0.0/8, 10/8, 100.64/10, 127/8, 169.254/16, 172.16/12, 192.0.0/24, 192.0.2/24, 192.88.99/24, 192.168/16, 198.18/15, 198.51.100/24, 203.0.113/24, 224/4, 240/4, 255.255.255.255). IPv6: allowed only inside 2000::/3 and outside 2001::/23 (IETF protocol assignments, Teredo 2001::/32 included), 2001:db8::/32, 2002::/16 (6to4), 64:ff9b::/96 and 64:ff9b:1::/48 (NAT64) and 3fff::/20; every IPv4-mapped or -compatible form is judged by its IPv4 address. Any refused result refuses the request.
    - The custom `lookup` answers both callback shapes Node uses (`(err, address, family)` and, with `all: true` as Node 24's `net` passes, `(err, addresses[])`), always with the vetted address only. Proxy environment variables (`HTTPS_PROXY`, `NO_PROXY`, …) are ignored: `agent: false` and no proxy agent.
22. **The shell limit names every new write** (gap). README, `PLUGIN_OVERVIEW.md` and `skills/mail/SKILL.md` state that an agent with shell access to the BB server can call owner RPCs through `bb plugin rpc call`, including `unsubscribe_run`, `block_add` and `snooze_folder_create`, and can answer the triage card (3c "Accepted limit").
23. **The badge hook cannot break the badge** (gap). `useNewMailToasts` runs inside `useUnreadBadge` wrapped in try/catch, both its effect body and the `new_mail_get` handling, so a toast failure never removes the badge. `navigate` is held in a ref (the subscription has no hook dependency on it). If `useBbNavigate()` throws (caught), **Open** sends the thread to a mounted Mail page through `mailPageLink`, and with no page mounted the toast is shown without **Open**.
24. **Public mail domains and the count** (gap, replaces the list in "Rules").
    - `PUBLIC_MAIL_DOMAINS` exact entries: gmail.com, googlemail.com, icloud.com, me.com, mac.com, msn.com, aol.com, proton.me, pm.me, protonmail.com, protonmail.ch, qq.com, 163.com, 126.com, mail.ru, bk.ru, list.ru, inbox.ru, internet.ru, ya.ru, rambler.ru, web.de, mail.com, fastmail.com. Pattern entries `yahoo.*`, `hotmail.*`, `outlook.*`, `live.*`, `yandex.*`, `gmx.*`, `zoho.*`, `zohomail.*`: the domain's first label equals the name and one or two labels follow (yahoo.co.uk, gmx.de, outlook.com.br).
    - The block dialog shows the count before the owner confirms: `block_check` returns `storedCount: { address, domain }` (stored Inbox-role rows across accounts whose From matches each candidate, after resolution 17's skip), and the checkbox text uses the chosen kind's count.
25. **Nits.**
    - `"reset"` is removed from `watchFolder`'s change kinds: a session that only IDLEs and NOOPs never reselects, so imapflow never emits a second `mailboxOpen`. A UIDVALIDITY change is found by the Inbox round after any change or reconnect, as today.
    - `watchFolder(config, path, …)` opens the `path` it is given (the supervisor passes the stored Inbox folder's path); the adapter never hardcodes `INBOX`.
    - Quiet hours use the BB server's clock and time zone. README states it: a remote BB server in another zone applies its own hours.
    - A forged From naming a known contact can toast (the address shown is the forged one). Accepted.
    - One-click requests are capped at 30 per hour; a triage batch with more unsubscribe items than the cap leaves marks the extra items `rate_limited`, and the row shows "rate-limited, try later" for them. `triage_items.outcome` gains `rate_limited`.
    - New RPC output keys must not match the contract test's credential walker (`/pass|secret|seal|key/i`): `unsubscribe_info` never returns `listKey`, and `block_check`/`triage_view` name their fields accordingly.
26. **makosh-ai changes (note only).** makosh-ai now has `ai.v1.providers`, an optional `projectId` and `<reason>: text` errors (installed in the owner's BB on 2026-11-15). Mail's translator (`src/adapters/bb/makosh-ai-translator.ts`) may move to them later; 3e does not change it.
27. **Block applies only to genuinely new mail *(owner)*** (decided 2026-11-15 during the build; replaces the "block rules still apply to it" clause of resolution 16).
    - A **returning** row (a `newInbox` row whose dedup key already had another row in the account before the insert: mail the owner moved back into the Inbox on the phone, from Archive or elsewhere, or a second copy) is never moved by block rules. The owner put it there.
    - A snooze return is the plugin's own move back and is never moved by block rules either.
    - Automatic block moves therefore apply to `newInbox` rows that are not returning, minus resolution 17's Spam skip. `block_add` with `moveExisting` is the owner's explicit request and is unchanged.

## Resolutions after the review

These override the sections and resolutions above (review of 2026-11-16).

1. **Snoozed mail older than the sync window is kept.**
   - A folder's first sync (no sync state) and a UIDVALIDITY reset keep looking for these rows before `finishFolderReset` deletes what is still detached: every row of a never-synced folder (a move re-homed it there), every row with a live snooze, and every row with a queued move. Each is fetched first at the uid it had, then searched by Message-ID (`findByMessageId`), and reattached when the message found is its own (same Gmail id or Message-ID), whatever its date. A row found nowhere is deleted with its snooze, as before; a row with neither id keeps 3d's limit.
   - A queued move whose row a reset pushed out of the window therefore keeps its row and its move; only a message gone from the server is reported as a dropped move.
   - `snooze_folder_create` and `snooze_folder_use` seed the folder's sync state from STATUS when it has none (`lastUid = UIDNEXT − 1`), so its first round is incremental, never a reset. Seeding is best effort; a failure is logged by kind and the round's reset protection still applies.
2. **List headers are counted past the 64-line cap** (replaces the cap in "Parsing at sync" and refines resolution 11).
   - `unsubscribeInfoOf` caps the lines itself (`capHeaderLines`): the first 64 lines are judged; when there are more, the `List-Unsubscribe` and `List-Unsubscribe-Post` lines past the cap (at most two of each) and a truncation mark follow. `headerLines` and the gateway hand over every matching line, so no caller caps first.
   - A truncated header section gets `trust = "not_covered"` (one-click never offered). More than one `List-Unsubscribe` or `List-Unsubscribe-Post` anywhere in the header is a repeat, as in resolution 11. The mailto method is still parsed when exactly one `List-Unsubscribe` was seen in the whole header.
3. **The one-click socket never outlives the 10 s deadline** (refines "Time limits" and "Response").
   - The outcome is still decided by the status line. The overall 10 s deadline is not cleared by it: the socket is destroyed after the response ends, once more than 16 KiB was drained, or at the deadline, whichever comes first. A response that trickles and never ends is cut at 10 s.
4. **Any non-pass answer is a conflict** (replaces resolution 12's "a `dkim=fail` … makes it `no_dkim`").
   - In the counted `Authentication-Results` headers, any DKIM result other than `pass` (`fail`, `neutral`, `temperror`, `permerror`, `policy`, `none`) for the same signature as a pass makes it `not_covered`; a non-pass result that names no signature (a bare `dkim=none`) contradicts every pass. A non-pass result for another signature is no conflict. So a forged `dkim=pass` inside the provider's block next to the provider's real `neutral` answer is not trusted.
5. **The mailto text is shown before it is sent** (adds to "The mailto request" and "Privacy").
   - `offeredMethods` gives the mailto's `subject` and `body` with invisible characters taken out (`revealHidden`; an emptied subject becomes "unsubscribe") and `hiddenChars`, their count. `unsubscribe_info` returns them; the triage view's unsubscribe item carries `mailto: { subject, body, hiddenChars, foreignDomain }` (null for one-click).
   - The unsubscribe dialog and the triage card show that subject and body as plain text (no HTML, no links, line breaks kept, "(no text)" when empty) under "The email that will be sent", name the removed hidden characters, and the card shows the foreign-domain note as the dialog does.
   - `unsubscribe_run` sends exactly that shown subject and body, so what the owner saw is what goes out.
6. **Snooze undo deletes a snooze only after its move back** (replaces "`runUndo` deletes the recorded snooze rows … before queueing the moves back").
   - In the account's queue task, a snooze row is deleted only for a message whose pending move into the snooze folder was cancelled or whose move back was queued. A row skipped (`moved_elsewhere`, for example a return the clock already queued; `gone`) or put back into the slot after a failure keeps its snooze, so the return still happens. A snooze group put back for another Undo keeps its `snoozeIds`.
7. **The snooze folder does not change while snoozes are live** (adds to "Folder").
   - `snooze_folder_use` with a path other than the account's current snooze folder is refused (`conflict`) while the account has any live snooze: "N snoozed messages are still in the snooze folder; return them before you change it" (fixed text with the count). The same path is accepted. Keeping one folder per account was chosen over a per-snooze folder as the simpler safe rule: the clock never drops snoozes left in an old folder.
