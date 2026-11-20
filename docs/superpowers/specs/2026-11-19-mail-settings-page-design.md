# Makosh Mail: settings as a page — design

Date: 2026-11-19. Status: waiting for the owner's approval.

## Intent

Mail settings are a dialog with twelve tabs in one row. In Russian four of
them fall outside the dialog and the rest wrap to two or three lines; most
of what the "AI features" tab shows cannot be changed there and sends the
owner to BB's plugin settings; some texts are still English. The owner
chose to replace the dialog with a page of its own inside Mail and to go
through the content of every section in the same work.

## Goals

- Settings open as a page inside Mail with a grouped menu on the left; every
  section name is readable in Russian and English at any panel width.
- Every setting of the plugin that is safe to change from the page is
  changed on the page. Nothing says "change it in BB Settings" for those.
- The mail accounts themselves have a section: how each signs in, replacing
  a password, switching to Google, the outgoing server, removing an account.
- No English sentence is left on the page when the language is Russian.
- The page has an address, so BB's back and forward work and a section can
  be linked to.

## Non-goals

- New features inside a section (a filter editor redesign, new AI
  features, calendar or contacts settings).
- Changing BB's own plugin settings page; it keeps working for every
  setting.
- The account form's own layout, beyond where it is reached from.

## Anti-goals

- A page that looks unlike the other Mail pages (Today, Files, Local
  archive): one shell, one set of tokens and primitives.
- A way for anything but the owner's click to widen what agents may do
  with mail.
- A settings write that can touch `vaultKey`.

## Constraints

- `src/ui` imports no host code; BB access goes through ports as today.
- BB's vendored components (`@/components/ui`) and theme tokens only; no
  raw colours or pixel values outside Tailwind's scale.
- BB draws a page-wide `:focus-visible` outline that beats utility classes
  (found on 2026-11-19): interactive elements either keep it visible in
  full or switch it off inline, never clip it.
- The Mail panel can be narrow: the layout is checked at 480, 768 and
  1280 px container widths.

## Approaches

The owner saw three rendered sketches on 2026-11-19: (A) the dialog with a
side menu, (B) a page of its own, (C) five tabs with stacked cards. They
chose **B**, and the scope "everything at once" over "structure only" and
"structure plus the AI features section".

## Information architecture

Five groups, fourteen sections. Old tab in brackets.

| Group | Section | Holds |
|---|---|---|
| Accounts | Mailboxes and sign-in (new) | each account: address, provider, how it signs in, state; Replace app password, Switch to Google sign-in / Sign in to Google, SMTP settings, Add an account; sync interval and window; instant mail |
| Accounts | Addresses and signatures [Sending addresses] | identities, aliases, signatures, send checks, add address |
| Mail | Inbox [Inbox] | blocked senders, snoozed folders, new-mail notifications, important senders, quiet hours |
| Mail | Filters [Filters] | as today |
| Mail | Subscriptions [Subscriptions] | as today |
| Mail | Templates [Templates] | as today |
| Mail | Reading and search [Search and reading] | view, dark mode, quotes, tracking links, density, reading pane, language, history step, server search, attachment text |
| AI and agents | AI features [AI features] | categories, Today digest and its time, reply reminder days, provider and model, translate into |
| AI and agents | Agent access [AI access] | the three agent switches (read-only, see below), shared folders, never-share list |
| AI and agents | Activity log [Agent activity] | as today |
| BB | Integration [BB integration] | project folders, task target, dev notifications, binding rules |
| BB | Rules [Rules] | rules switch, rules list |
| Security | Encryption [Encryption (OpenPGP)] | as today |
| Security | Local data (new) | where mail and keys are kept, the credential key's state, links to `doctor` and `backup` as commands to copy |

"Remove account" stays a terminal command (backlog item 77 says so); the
section shows the command to copy.

## Design

### Address and shell

- A new page name `settings` in `src/ui/routes.ts`: subPath `settings` and
  `settings/<section>`. `parsePageSubPath` returns it; an unknown section
  opens the first one.
- The page renders through the existing `page` slot of `MailPage`, but in a
  wider frame than the reading pages: menu 208 px, content up to 672 px,
  the pair centred. The frame's width is a property of the page slot, not
  a second shell.
- Header row: a "Mail" back link (to the view the owner came from), the
  title "Settings". No description line.
- The gear in the sidebar, the "Manage templates" link and every other
  `openSettings(section)` call navigate to the page instead of opening the
  dialog. The dialog is removed.
- Under 640 px container width the menu becomes a `Select` above the
  content; groups are option groups.

### Menu

`nav` with `aria-label="Settings"`, one list per group with a small
uppercase group label. Items are links (`aria-current="page"` on the open
one), not tabs: each has an address. Keyboard: Tab reaches the menu, arrow
keys move between items, Enter opens.

### Section anatomy

One primitive set for every section, in `src/ui/settings/`:

- `SettingsSection({ title, description?, children })` — the section's
  heading and one sentence under it.
- `SettingRow({ label, hint?, control })` — label and hint on the left,
  one control on the right (`Switch`, `Select`, number field, button);
  stacks under 480 px. Used for every plain setting.
- `SettingsGroup({ title, action?, children })` — a titled block for lists
  (addresses, rules, filters, keys) with its "New …" action in the title
  row.
- Lists keep their current row components; only their container and
  headings change to the primitives.

### Changing settings on the page

- RPC `settings_get` returns the page's settings; `settings_set` takes a
  partial object. Both owner-only. The server validates each key against
  the same bounds as `bb.settings.define`, and writes with
  `settings.experimental_set` (already used for the translation settings).
- **Allowed keys**: everything in the table above except the three agent
  switches and `vaultKey`. `vaultKey` is never read or written by these
  methods.
- **The three agent switches stay read-only on the page** (`agentTools`,
  `agentPropose`, `agentTriage`): they widen what agents may do with mail,
  and an RPC that sets them could be called by something other than the
  owner's click. The page shows their state and a button that opens BB's
  plugin settings. This is my proposal, not the owner's decision: say so
  if you want them switchable on the page as well.
- A control saves on change, shows a small "Saved" for two seconds, and on
  a refused write restores the previous value and says why in the row.
- The existing `translate_settings_*` methods stay; their form moves under
  "AI features".

### Content pass

For each section: one sentence of description; every status sentence
rewritten as a label plus a control or a state badge; no text that only
repeats the label; every string through `tx()` with a Russian line; units
written out through plural-aware messages ("через 3 дня", not "3 days").
The strings found on 2026-11-19 that are not translated: "Off.", "Change
it in BB Settings → Plugins → Makosh Mail.", "{n} days".

### Code structure

`src/ui/mail-settings.tsx` is 1 100 lines and holds the dialog, the tab
bar and five sections. It is split:

- `src/ui/settings/settings-page.tsx` — shell, menu, section switch.
- `src/ui/settings/sections.ts` — the groups and sections as data (id,
  group, title key, which ports it needs).
- `src/ui/settings/primitives.tsx` — the three primitives above.
- one file per section: the existing `*-settings.tsx` files move there
  unchanged in behaviour; `AddressesSection`, `InboxSection`,
  `TemplatesSection`, `AiFeaturesSection` and `SearchSection` leave
  `mail-settings.tsx` for files of their own; `accounts-section.tsx` and
  `local-data-section.tsx` are new.
- `mail-settings.tsx` is deleted once nothing imports it; its exported
  helpers (`docPreview`, `sendCheckText`, `attachmentTextLine`) move with
  their sections.

The props of today's `MailSettings` become the page's props unchanged, so
`app.tsx` changes only where it opens settings and where it renders them.

### States

Each section that loads data keeps its loading, empty and error states and
gets them checked: no accounts, a stopped account, a revoked Google grant,
no vault key, Makosh AI missing, no rules, no filters, no keys, a log with
nothing in it.

## Verification

- `npm run check` and `npm run build`.
- The page in a browser at 480, 768 and 1280 px in dark and light, Russian
  and English: every section opened, every overlay it has (selects, the
  signature editor, confirm dialogs) opened, screenshots next to the Today
  page as the sibling. This needs the plugin running in BB: it is done in
  the live worktree after the owner's go-ahead to reload, once.

## Open, with the default taken

- Agent switches read-only on the page (above).
- "Local data" as a section of its own rather than a line under
  Mailboxes: default is its own section, because it is where the vault key
  problem is explained when there is one.

## Left to the builder

- Exact Tailwind classes within the token scale; the "Saved" indicator's
  form.
- Whether `settings_get` is its own method or part of `status_get`.
- The order of work between sections once the shell and primitives exist.
