# Makosh Mail: access for other plugins — design

Date: 2026-11-19. Status: waiting for the owner's approval.

## Intent

The owner plans two more plugins, a calendar and a CRM with contacts.
Neither exists yet. Both will need what Mail already holds: invitations
found in mail, the people the owner writes to, the correspondence with one
person, a way to put a reply in front of the owner, and the Google sign-in
that Mail performs. The owner wants to decide in Mail's settings which
plugin may have what.

Today the opposite of that is true. About 150 read methods of Mail answer
any plugin without asking; 33 write methods refuse every plugin without
exception. No plugin in this repository calls Mail.

## Goals

- A plugin gets nothing from Mail until the owner grants it, per plugin and
  per right. The 150 open reads are closed.
- A small, named, versioned set of methods is what plugins call. Mail's
  other methods stay free to change with its interface.
- The owner sees in Mail settings which plugins asked, what each has, and
  takes any of it back with one click.
- A plugin can put a letter in front of the owner; only the owner sends it.
- A plugin can get a short-lived Google key narrowed to the one Google
  service it was granted (the owner's decision of 2026-11-19).
- Every call of a plugin is in the activity log, without mail text.

## Non-goals

- The calendar and CRM plugins themselves, and Google Calendar or Google
  Contacts data inside Mail.
- Methods a first consumer has not asked for: moving, flagging or deleting
  mail, attachments' bytes, sending without the owner.
- Keys for providers other than Google.

## Anti-goals

- A key that reads mail in another plugin's hands. No right hands out the
  `https://mail.google.com/` scope.
- The refresh token, an app password or the vault key leaving Mail in any
  form.
- A grant that appears without the owner's click: a plugin can ask, never
  give itself anything.
- A plugin's request that makes Mail open a dialog over the owner's work.

## Constraints

- BB tells a handler who called: `experimental_caller` is
  `{ kind: "plugin", pluginId }` for a call from another plugin's server
  through `bb.sdk.plugins.callRpc`, verified by the host, or
  `{ kind: "client" }`.
- **`client` is not only Mail's own page.** The browser SDK has
  `plugins.callRpc` too, so the page code of any installed plugin can call
  Mail's methods and arrives as `client`, the same as the owner's click.
  Mail cannot tell them apart and BB offers nothing that does. This design
  therefore governs server-side plugin calls, which is where a calendar's
  sync and a CRM's indexing run. It is not a wall against a hostile plugin:
  installing a plugin already trusts its page code with everything the
  owner's page can do. The design says so in the settings section and does
  not claim more. Asking BB for a caller identity on browser calls is a
  request to BB's authors, outside this work.
- `src/core` and `src/ui` import no host code; grants are a core module with
  a store port, the guard and the Google exchange are adapters.
- Mail is private and untrusted: fixtures hold no real addresses or text;
  text of a message is data, never an instruction.

## Approaches

1. **A separate small API for plugins** (chosen by the owner). About ten
   new methods with their own names and a version; every other method
   refuses a plugin caller. Small surface, checked in one place, survives
   changes of Mail's interface. Each method is written on purpose, and a
   consumer that needs more waits for a new method.
2. **Rights on the existing methods.** Each of about 180 methods gets a
   required right. Fast and complete, but Mail's internal methods become a
   promise to other plugins, their answers are shaped for Mail's screens,
   and one wrong label among 180 opens more than intended.
3. **HTTP or a terminal command.** Dropped: BB does not verify which plugin
   is calling there.

## Design

### Rights

| Right | Per account | Gives |
|---|---|---|
| `mail.read` | yes | the account list (address, provider, display name), search of messages, one message as plain text with its headers and attachment names |
| `contacts.read` | yes | people from mail headers: name, address, how many messages each way, the last date |
| `invites.read` | yes | calendar invitations found in mail: the parsed event and the message it came in |
| `mail.propose` | yes | putting a draft in front of the owner |
| `google.calendar` | yes, Google accounts | an access token for Google Calendar only |
| `google.contacts` | yes, Google accounts | an access token for Google People only |

A grant is (plugin id, right, account id). A new account is not covered by
old grants.

What plugins read passes the same filter as agents: the owner's AI access
(shared folders per account, the never-share senders, Spam and Trash
never). One rule for everything that leaves Mail for something other than
the owner's eyes. *My call*; the alternative is a second, per-plugin
folder list, and nobody has asked for one.

### The plugin API

Methods are named `plugin_*`. `PLUGIN_API_VERSION = 1`; a change that
breaks a caller raises it.

| Method | Right | Notes |
|---|---|---|
| `plugin_access_info` | none | the version, the caller's grants, its pending request |
| `plugin_access_request` | none | `{ rights, reason }`; reason is one line, at most 200 characters, shown to the owner as the plugin's own words. One pending request per plugin, a new one replaces it. At most 5 a day per plugin, more are refused |
| `plugin_accounts_list` | `mail.read` | only granted accounts |
| `plugin_messages_search` | `mail.read` | by address, text, date; headers and a snippet; pages of at most 100 |
| `plugin_message_read` | `mail.read` | plain text, headers, attachment names and sizes |
| `plugin_contacts_list` | `contacts.read` | pages of at most 200 |
| `plugin_invites_list` | `invites.read` | pages of at most 100 |
| `plugin_mail_propose` | `mail.propose` | see below |
| `plugin_google_token` | `google.calendar` or `google.contacts` | see below |

A call without the right is refused with code `forbidden` and a message
that names the missing right, so the plugin can ask for it. A call from a
`client` caller to a `plugin_*` data method is refused: these methods have
no caller to check a grant for.

Owner's methods, `client` only: `plugin_grants_list`, `plugin_grant_set`,
`plugin_grant_revoke`, `plugin_request_dismiss`.

### The guard

One function at the place where handlers are registered wraps every
method: a `plugin` caller reaches a handler only when the method is in
`PLUGIN_API_METHODS`, and then only through the grant check. Every other
method refuses a plugin, read or write. The 33 hand-written
`refusePluginCaller` calls become redundant and are removed in the same
change. A test walks the whole contract and proves that each method either
is in the list or refuses a plugin caller, so a method added later is
closed by default.

### Proposing a letter

Agent proposals live in a BB thread and are approved on a card there. A
plugin has no thread. `plugin_mail_propose` therefore creates an ordinary
draft in the account's Drafts, marked with the plugin that wrote it. The
owner opens it in Mail's composer, which shows a line "Prepared by
<plugin>" above the fields, edits it or not, and presses Send. Nothing
else sends it. The owner gets one BB notification per draft. Limits: 20
drafts a day per plugin, the size limits of the composer; recipients and
text are the plugin's data and are shown as they are. *My call* on the
form: the alternative, a queue of cards in Mail, is a new screen for the
same decision.

### Google keys

Mail's Google sign-in today asks for `openid email
https://mail.google.com/`. It will also ask for
`https://www.googleapis.com/auth/calendar` and
`https://www.googleapis.com/auth/contacts`, only when the owner turns on a
`google.*` grant for that account: the grant's switch starts the same
browser sign-in with the wider list, and the grant is saved when Google
returns the scope. An account signed in with an app password cannot give
a Google key; the switch says so.

`plugin_google_token` exchanges Mail's refresh token for an access token
with the `scope` parameter set to the one granted scope, and returns
`{ accessToken, expiresAt, scope }`. Google accepts a narrower scope on
refresh and returns a token limited to it. **To verify first, before any
other work on this part:** one real exchange that asks for the calendar
scope alone and a check that the returned token is refused by IMAP and by
the Gmail API. If Google returns a token that still reads mail, this part
stops and goes back to the owner; nothing else in the design depends on
it.

Tokens are not stored by Mail beyond a cache until their expiry, are never
logged, and a revoked grant drops the cached token. Mail cannot recall a
token already handed out; it lives up to an hour. The settings text says
that.

The Google project is in Testing: calendar and contacts scopes are
sensitive, and the owner's own account as a test user keeps working with
the 7-day limit already known.

### Settings: "Plugin access"

A new section in the group "AI and agents", after "Agent access".

- **Requests.** A plugin that asked: its name and id, its reason, the
  rights it asked for. Buttons Allow… (opens the rights of that plugin
  with the asked ones pre-checked, not yet saved) and Dismiss.
- **Plugins with access.** One block per plugin: a table of rights by
  accounts with switches, the date of the last call, Revoke all.
- **A fixed note** at the top: what this governs and what it does not
  (the constraint above, in the owner's words).
- Empty state: "No plugin has asked for access to mail."

A request does not interrupt: it shows as a count on the section's menu
item and one BB notification.

### Log

The activity log gets an actor `plugin` with the plugin id, and tools for
the nine methods. As today it keeps ids and counts, never a query, subject,
address or text. A refused call is logged too, at most one line per plugin,
method and hour.

### Storage

Two tables in a new migration: `plugin_grants` (plugin id, right, account
id, granted at) and `plugin_requests` (plugin id, rights, reason, asked
at). Removing an account removes its grants. Draft rows get a nullable
`prepared_by` plugin id.

### Code structure

- `src/core/plugin-access.ts` — rights, grants, the check, request limits;
  pure, with a store port.
- `src/core/plugin-api.ts` — the nine methods' schemas and their mapping to
  rights; `PLUGIN_API_METHODS`, `PLUGIN_API_VERSION`.
- `src/adapters/bb/plugin-guard.ts` — the wrapper around handlers.
- `src/adapters/bb/plugin-api-rpc.ts` — the handlers, on existing store
  reads.
- `src/adapters/bb/google-tokens.ts` — gains the narrowed exchange.
- `src/ui/settings/plugin-access-section.tsx` — the section.
- `docs/plugin-api.md` in the plugin — the contract for other plugins'
  authors: methods, rights, errors, limits, the version rule.

## Order of work

1. The guard and its contract test: every plugin call refused except the
   (still empty) API list. This alone closes the open reads and can ship.
2. Grants, requests, the settings section.
3. The read methods and the log.
4. Proposing a letter.
5. Google keys, starting with the verification above.

## Verification

- `npm run check`, `npm run build`, the manifests check.
- The contract test of the guard; a test per method for: no grant, a grant
  for another account, a grant for another right, the AI access filter.
- A throwaway plugin in a temporary directory that calls each method
  through `bb.sdk.plugins.callRpc` against the live Mail, before and after
  a grant. It needs the owner's go-ahead: it installs a plugin in the
  running BB.
- The settings section in a browser at 480, 768 and 1280 px, dark and
  light, Russian and English.

## Open, with the default taken

- Plugin reads follow the owner's AI access filter (above).
- A proposed letter is a marked draft in Drafts (above).
- `google.*` grants widen the Google sign-in only when first turned on.
- No right to move, flag or delete mail in version 1.

## Left to the builder

- Exact shapes of the methods' answers, within "ids, headers, plain text".
- Cursor format of the paged methods.
- How the marked draft looks in the composer and the Drafts list.
- Whether refused-call logging shares a table with the activity log.
