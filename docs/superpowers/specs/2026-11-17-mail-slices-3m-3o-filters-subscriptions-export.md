# Mail slice 3m: filters

Backlog item 65: new Inbox mail is sorted by local rules, without an agent.
Named "filters" to keep them apart from the mail rules of slice 3g, which
prepare or start agent threads.

## Decisions

- **Match.** A mail rule's fields without the dev notification: sender
  addresses, sender domains (with subdomains), a List-Id, whole subject
  words, accounts. Every given field must match. Unlike a mail rule, a
  filter matches bulk mail too: sorting newsletters is the point.
- **Actions.** Move (none, archive, Trash, a folder), mark read, flag; at
  least one. A move to a folder needs exactly one account, because folder
  paths belong to an account, and the folder must exist there, be
  selectable and not be the Inbox. Nothing is ever deleted: Trash is a move.
- **Which filter.** The first enabled filter that matches, in the order the
  filters were made (SQLite rowid; an edit keeps the place). No reordering
  yet.
- **Which mail.** The same set block rules and mail rules use: genuinely
  new Inbox rows of an ok round, never returning ones, never the owner's
  own addresses. Filters run after block rules and before the toast, so a
  moved message does not toast. A message whose stored sender check failed
  is never sorted (slice 3i, decision 5).
- **Mail rules.** A message a filter queued to move is skipped by mail
  rules, as one queued to Spam already was.
- **Owner only.** `filters_list`, `filter_save`, `filter_delete` refuse
  plugin callers. No tool, no CLI command. Logs carry ids and counts.

## What was built

- `src/core/mail-filters.ts` (`validateFilter`, `filterMatches`,
  `filterFor`); matching reuses `mailRuleMatches`.
- Store: migration element 17 (`mail_filters`), pinned as
  `MIGRATIONS.slice(0, 18)`; `listMailFilters`, `saveMailFilter`,
  `deleteMailFilter`.
- `sortNewInbox` in `server.ts`, called from `afterRound`.
- Contract: 169 methods; `SLICE_3M_METHODS`.
- UI: Mail settings tab "Filters" (`filters-settings.tsx`), with Russian
  texts.

## Not done

- No "apply to the mail already in the Inbox", no reordering, no match on
  recipients, size or attachments, no "skip the toast" action.
- Filters are local to this machine: they are not Sieve or Gmail filters
  and do nothing while BB is closed.
- Not tried on the owner's real mail; no second review pass and no rendered
  preview of the tab.

# Mail slice 3n: subscriptions overview

Backlog item 87, built right after the filters.

## Decisions

- **No new way to unsubscribe.** The overview only finds lists; each
  request is `unsubscribe_run` for the list's newest stored message, with
  every check that method already has (the folder, the trust in one-click,
  the rate limits, the Outbox Undo for an email).
- **A list** is what "Archive all from this list" calls one (`sameList`):
  a List-Id key, or for a From-fallback key the sender's address too.
- **Counts** are distinct messages (dedup key) of rows whose unsubscribe
  info is stored, outside Spam, Trash, Drafts and Sent; the newest 50,000
  rows are read and the 200 largest lists shown.
- **A batch** is at most 10 lists (the per-minute send cap), run one after
  another. A mailto at a domain that is not the sender's is never in a
  batch: the message's own dialog shows that address with its warning.
- **Before anything is sent** the owner sees each request: the one-click
  host, or the email's address with its exact subject and text.
- The list key never reaches the page. `subscriptions_list` is owner only.

## What was built

- `src/core/subscriptions.ts` (`groupSubscriptions`), the store's
  `subscriptionRows`, `subscriptions_list` (170 methods,
  `SLICE_3N_METHODS`), `src/ui/subscriptions-settings.tsx`, Russian texts.
  No migration.

## Not done

- Older mail whose unsubscribe headers were never fetched is not counted
  (the reading pane fetches them one message at a time).
- No "archive everything from this list" in the overview, no opening of a
  list's mail from it, no per-account view.
- Not tried on the owner's real mail; no second review pass and no rendered
  preview of the tab.

# Mail slice 3o: export

Backlog item 94 (the database backup was slice 3j).

## Decisions

- **From the server, not from the local store.** Mail keeps text and a
  window of history, never whole messages; an export that is worth keeping
  has every byte. One read-only session per export (BODY.PEEK).
- **A command in the owner's terminal**, like doctor and backup: it writes
  to a path of the owner's choosing and refuses inside a thread. No button
  on the page yet.
- **mbox as mboxrd** (LF line ends, `>From ` quoting at every depth), or a
  directory of `.eml` files named by UID. Created new, mode 0600 / 0700;
  nothing existing is ever written over.
- **Bounded**: the newest 2,000 by default, `--max` up to 50,000,
  `--since` by the server's date. A failure midway keeps what was written.
- Logs: the account id, the outcome and counts.

## What was built

- `src/core/mbox.ts`, `src/adapters/bb/export.ts`, the `export` CLI command.

## Not done

- Import (backlog 95). The backlog asks for an old archive to be opened
  and searched in BB without uploading it to a server. That needs mail
  that lives only in the local store, which today holds nothing but copies
  of server mail: a design decision for the owner.
- No flags or labels in the export, no export of a search or of one
  conversation, no button in the page, no progress while it runs.
- Not opened in another mail program; not run against a real server.
