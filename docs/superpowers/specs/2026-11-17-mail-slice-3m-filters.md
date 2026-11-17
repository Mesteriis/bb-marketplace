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
