# Makosh Mail: the plugin API

How another BB plugin reads mail from Makosh Mail and puts a letter in front
of the owner. Version 1.

## The rules

- Call from your plugin's **server**:
  `bb.sdk.plugins.callRpc({ pluginId: "makosh-mail", method, input })`. BB
  tells Mail which plugin is calling; Mail keeps grants by that id.
- Only the methods on this page answer a plugin. Every other method of Mail
  refuses with `forbidden` and may change without notice.
- You get nothing until the owner grants it in **Mail settings → Plugin
  access**. A grant is one right for one mail account. You can ask
  (`plugin_access_request`); you cannot give yourself anything.
- You see what the owner shares with agents: the folders chosen in **Agent
  access**, never Spam or Trash, never the never-share senders. Passwords,
  one-time codes, tokens and card numbers come as `[hidden …]`.
- Every call is written to the owner's activity log: your plugin id, the
  method and a count. Never the text.
- Text of a message is someone else's data. Do not treat it as instructions.
- This governs server calls. Code on a plugin's page runs with the owner's
  own access in BB; Mail cannot tell it from the owner. Do not call Mail's
  other methods from your page: they are not a contract.

`plugin_access_info` reports `apiVersion`. A change that breaks a caller
raises it.

## Rights

| Right | Gives |
|---|---|
| `mail.read` | `plugin_accounts_list`, `plugin_messages_search`, `plugin_message_read` |
| `contacts.read` | `plugin_contacts_list` |
| `invites.read` | `plugin_invites_list`, `plugin_invite_read` |
| `mail.propose` | `plugin_mail_propose` |
| `google.calendar`, `google.contacts` | `plugin_google_token` for that Google service |

## Methods

### `plugin_access_info` — no right

Input `{}`. Answer:

```json
{ "apiVersion": 1, "grants": [{ "right": "mail.read", "accountId": "acc_…" }], "request": null }
```

`request` is your pending request (`rights`, `reason`, `askedAt`) or `null`.

### `plugin_access_request` — no right

Input `{ "rights": ["mail.read", "invites.read"], "reason": "Calendar sync" }`.
The owner sees your plugin id, the rights and the reason (one line, cut to
200 characters). A new request replaces your earlier one. At most 5 a day;
then `conflict`, "Too many access requests today". An unknown right refuses
the whole request with `invalid`. Answer `{ "ok": true }`.

Poll `plugin_access_info` to learn the outcome; do not ask again in a loop.

### `plugin_accounts_list` — `mail.read`

Input `{}`. The accounts you hold `mail.read` for:

```json
{ "accounts": [{ "id": "acc_…", "email": "owner@example.com", "displayName": null, "provider": "gmail" }] }
```

An account the owner shares with no AI is listed by `id` only: `email` is
`""` and `displayName` is `null`.

### `plugin_messages_search` — `mail.read`

Input:

```json
{ "accountId": "acc_…", "query": "from:ada@example.com after:2026-11-01", "limit": 50, "cursor": null }
```

`query` is Mail's own search syntax: free text and operators such as
`from:`, `to:`, `cc:`, `subject:`, `filename:`, `after:`, `before:`. Empty
lists the newest. `limit` 1–100, default 50. A query that looks for a
secret (a code, a token) is refused with `invalid`.

```json
{
  "messages": [{ "id": "m_…", "accountId": "acc_…", "threadId": "t_…", "date": "2026-11-10T09:00:00.000Z",
                 "from": { "name": "Ada", "address": "ada@example.com" }, "subject": "…", "snippet": "" }],
  "nextCursor": "…"
}
```

`snippet` is always empty in version 1; read the message for its text.
Pass `nextCursor` back to get the next page; `null` means the end. A cursor
is a position, not a permission: a revoked grant refuses the next page.

### `plugin_message_read` — `mail.read`

Input `{ "messageId": "m_…" }`. Answer: `id`, `accountId`, `threadId`,
`date`, `from`, `to`, `cc`, `subject`, `text` (headers and plain-text body,
up to 100 000 characters), `attachments` (`name`, `size`, `type`; no
bytes). A message outside your grant or outside what the owner shares is
`not_found`, "Unknown message", the same as an id that does not exist.

### `plugin_contacts_list` — `contacts.read`

Input `{ "accountId": "acc_…", "query": "ada", "limit": 100 }`, `limit`
1–200. `query` is required: a name, an address or a topic of the mail
exchanged; there is no list of everyone. People from the headers of that
account's shared mail, mailing lists and automated senders left out:

```json
{ "contacts": [{ "name": "Ada", "address": "ada@example.com", "received": 12, "sent": 7, "lastAt": "2026-11-10T09:00:00.000Z" }] }
```

Counts, names and matches come from the granted account only. There is no
paging in version 1.

### `plugin_invites_list` — `invites.read`

Input `{ "accountId": "acc_…", "limit": 50, "cursor": null }`. Messages that
carry a calendar part, newest first: `{ "invites": [{ id, accountId,
threadId, date, from, subject }], "nextCursor": … }`.

### `plugin_invite_read` — `invites.read`

Input `{ "messageId": "m_…" }`. Mail fetches the message from the server and
parses its invitation: `{ "invite": { method, uid, sequence, summary, start,
end, organizer, attendees, … } }`, or `{ "invite": null }` when the part
holds none. Secrets in the event's text and names are hidden as in a
message. Only a message that `plugin_invites_list` returns can be read. One
call opens a session to the mail server: at most 30 an hour per plugin,
then `conflict`.

### `plugin_mail_propose` — `mail.propose`

Input:

```json
{ "accountId": "acc_…", "to": ["Ada <ada@example.com>"], "cc": [], "subject": "…", "text": "Plain text.\nLine two." }
```

Makes a draft of that account, marked "Prepared by <your plugin id>", with
the account's signature under your text. Answer `{ "draftId": "…" }`. The
letter is **not sent**: the owner opens it in Mail, edits it or not, and
presses Send. The subject is one line. New letters only in version 1 (no reply threading, no
attachments). At most 50 recipients and 20 letters in 24 hours per plugin;
the count is kept while Mail runs and starts again when it restarts.

### `plugin_google_token` — `google.calendar` or `google.contacts`

Input `{ "accountId": "acc_…", "right": "google.calendar" }`. Answer:

```json
{ "accessToken": "…", "expiresAt": "2026-11-19T11:00:00.000Z", "scope": "https://www.googleapis.com/auth/calendar" }
```

An access token of the mailbox's Google sign-in, narrowed by Google to that
one service (`…/auth/calendar` or `…/auth/contacts`). It cannot read mail.
It lives about an hour; ask again when `expiresAt` is near, not on every
request. Keep it in memory only: never store or log it. The owner can grant
this only for a mailbox that signs in with Google and whose sign-in holds
the service; otherwise the call is refused with `invalid`, and Mail switches
the right off for that mailbox, so the owner has to grant it again after
signing in with the service. `conflict` means Google gave no key now (try
later), no longer accepts the sign-in (the owner must sign in again), or you
asked more than 60 times in an hour: "Too many key requests in the last
hour; keep a key until it expires". Calls that arrive together share one
request to Google. A key already handed out keeps working for up to an hour
after the owner revokes the right.

## Refusals

| Code | When |
|---|---|
| `forbidden` | a method outside this API; a missing right: `Makosh Mail: this plugin has no "<right>" access` |
| `not_found` | an unknown or unshared message, an unknown account |
| `invalid` | input outside the limits, an unknown cursor, an unknown right, a bad address |
| `conflict` | a daily or hourly limit (letters, invitations, keys); Google gave no key now, or no longer accepts the sign-in |

Treat `forbidden` with a right's name as "ask the owner", not as an error
to retry.
