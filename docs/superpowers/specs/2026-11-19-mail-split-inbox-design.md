# Makosh Mail: Split Inbox — design

Date: 2026-11-19. Status: waiting for the owner's approval. First of ten
projects that bring Superhuman Mail's features to Makosh Mail (calendar is
out of scope; the order is in the owner's decisions of 2026-11-19).

## Intent

The Inbox is one list. The owner wants what Superhuman calls Split Inbox:
tabs over the Inbox for the team, the VIPs, the tools that send
notifications, and anything else the owner defines, with a library of ready
tabs. The point is to look at one kind of mail at a time and to see how
much of each kind waits.

## Goals

- Tabs above the conversation list of the Inbox; each shows the Inbox
  conversations that match its condition and the number of unread ones.
- A library of ready tabs added in one click, and a tab made from any
  search the owner can type.
- **A conversation appears in every tab it matches** (the owner's choice
  over "the first matching tab only").
- Tabs work the same in one account's Inbox and in All accounts.
- The tab in view has an address, so BB's back and forward walk tabs.

## Non-goals

- Tabs in folders other than the Inbox.
- Different tab sets per account.
- Labels set by AI (project 4); when they exist they are one more
  condition a tab can use.
- Changing anything on the mail server: a tab is a view.

## Anti-goals

- A tab that hides mail from the Inbox: the first tab always shows
  everything.
- A second filter language. A tab's condition is written in the search
  language the owner already uses.
- Slower opening of the Inbox for an owner who has no tabs.

## Constraints

- The Inbox lists conversations (`threads_list` with a `ThreadFilter`);
  search lists messages. A tab must stay a list of conversations, with the
  same rows, keys, selection and paging as the Inbox today.
- `src/core` and `src/ui` import no host code.
- The Inbox list has timing tests on a few thousand messages; a tab must
  not make the untabbed list slower.
- Layout checked at 480, 768 and 1280 px; BB's focus outline stays
  visible.

## Approaches

1. **A tab is a named search condition applied to Inbox conversations**
   (chosen: the owner handed the how to me). A new small entity with its
   own order; the condition is parsed by the existing search parser; a
   conversation is in the tab when one of its Inbox messages matches.
   One language, the library is a list of ready queries, and a tab is made
   from a search in one step.
2. **Tabs are saved searches with a "show as a tab" mark.** Less code, but
   saved searches list messages from every folder and are scoped to an
   account; a tab must follow the account chooser and list conversations.
   The two would share a table and little else.
3. **Tabs filter the rows already loaded in the page.** Wrong counts and
   empty pages as soon as the Inbox is longer than one page.

## Design

### What the owner sees

```
 Inbox 23 │ VIP 2 │ Team 5 │ Dev 12 │ Newsletters 31 │ Other 4 │ +
──────────────────────────────────────────────────────────────────
 ● Anna Petrova     Contract to sign                     10:42
   Ivan Sidorov     Re: Thursday's meeting               Yesterday
```

- A row of tabs between the search bar and the list, only in an Inbox view
  and only when at least one tab exists. Without tabs the Inbox looks as
  it does today, with one quiet "Split the Inbox…" entry in the list's
  menu.
- The first tab is always **Inbox**: everything. Then the owner's tabs in
  their order. Numbers are unread conversations; zero shows no number.
- **+** opens the library; a tab's menu has Rename, Edit condition, Move
  left, Move right, Remove.
- When the tabs do not fit, the row scrolls sideways; under 480 px it is
  the same row, never a second line.
- Keys: `]` moves to the next tab and `[` to the previous one when the list
  has focus (the owner's choice of 2026-11-19: Tab keeps moving focus).
- Quick filters (unread, flagged, attachments) narrow the tab in view.
- An empty tab says "Nothing in this tab." and keeps the tab row.

### The library

Added in one click, editable afterwards; each is a name and a condition:

| Tab | Condition |
|---|---|
| VIP | from the owner's important senders (the existing setting) |
| Team | from the domains of the owner's own addresses, other than public mail domains |
| People | from addresses the owner has written to |
| Dev | development notifications (the existing Dev class) |
| Newsletters | mailing lists and the Newsletters category |
| Notifications | automated senders that are not mailing lists |
| Calendar | messages with an invitation |
| Attachments | conversations with attachments |
| Tools | one tab per tool by sender domain: GitHub, GitLab, Jira, Linear, Notion, Asana, Figma, Google Docs, Slack |
| Other | conversations that match none of the owner's tabs |

"Other" is recomputed from the tabs that exist, so it stays right when
tabs change.

Elsewhere: **Split by this sender** in a message's menu makes a tab for
that address; **Make a tab** on a search or a saved search makes a tab
from its text.

### Conditions

A condition is text in the search language (`from:`, `to:`, `list:`,
`category:`, `label:`, `has:attachment`, `filename:`, free text, a leading
`-` to negate). Four conditions the library needs do not exist as
operators and are added to the language for everyone: `from:vip`,
`from:team`, `from:known` and `is:dev` (also `is:automated`,
`has:invite`). They then work in ordinary search and saved searches too.

A condition that does not parse is refused when it is saved, with the
parser's reason.

### Address

The view's address gains a tab: `v/all/inbox/s/<tabId>` and
`v/<accountId>/<folder>/s/<tabId>`. An unknown tab id opens the Inbox tab.

### Data and methods

- Table `inbox_tabs`: id, name (1–40 characters), query (1–500), position,
  created and updated times. At most 12 tabs.
- `inbox_tabs_list { scope }` → the tabs in order, each with its unread
  count in that scope; `inbox_tab_save`, `inbox_tab_delete`,
  `inbox_tab_move`. Owner's methods; the plugin guard already refuses
  other plugins.
- `threads_list` takes an optional `tabId` beside the quick filter.
- Counts are refreshed with the list (after a sync, an action, a tab
  change), in one call for all tabs.

### Settings

Mail settings → Inbox gets a group **Tabs**: the same list with rename,
condition, order, remove, and the library.

### Code structure

- `src/core/inbox-tabs.ts` — the tab type, limits, the library as data,
  the "Other" condition.
- `src/core/search.ts` — the new operators.
- the store — the table, the conversation match and the counts.
- `src/ui/inbox-tabs.tsx` — the row, the library popover, a tab's menu.
- `src/ui/settings/inbox-section.tsx` — the Tabs group.

## Verification

- `npm run check`, `npm run build`, manifests.
- The Inbox timing tests unchanged without tabs; a new one for a list with
  a tab on the same data.
- In a browser at 480, 768 and 1280 px, dark and light, Russian and
  English: the row, the library, a tab's menu, an empty tab, twelve tabs.

## Open, with the default taken

- One tab set for all accounts.
- At most 12 tabs.
- "Other" is offered in the library, not added by itself.

## Left to the builder

- How the conversation match is written in SQL, within the timing budget.
- The exact domains of the Tools tabs and of "public mail domains".
- The look of the row within BB's tokens and components.
