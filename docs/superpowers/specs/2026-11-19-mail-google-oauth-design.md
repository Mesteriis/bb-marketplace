# Makosh Mail: Google sign-in (OAuth) — design

Date: 2026-11-19. Status: approved by the owner on 2026-11-19, with the client file shipped in the plugin.
First of three projects in this order: Google sign-in for mail (this
document), Google Calendar, Google Contacts. Each of the next two gets its
own design.

## Intent

The owner wants Gmail accounts to work without an app password, and wants
the same Google sign-in to later give Makosh Mail the calendar and the
contacts. Google documents calendar and contacts access only with OAuth, so
the sign-in is the base the other two projects stand on.

## Goals

- A Gmail account can be connected, and an existing one switched, by
  signing in to Google in the browser. No password is typed into Mail.
- Sync (IMAP) and sending (SMTP) keep working exactly as now; only the way
  they authenticate changes.
- The Google client ships with the plugin as a committed JSON file. Nobody
  enters a client in settings, and every install has Google sign-in.
- The grant is stored encrypted, like a password is today.
- The next projects can ask Google for more access without redoing this
  one.

## Non-goals

- Gmail API instead of IMAP (backlog #98).
- Calendar and contacts features. This project requests no access to them.
- OAuth for Microsoft, Yandex or any other provider.
- Removing app passwords. iCloud, "another server" and Gmail by app password
  stay as they are.

## Anti-goals

- The client id or secret in a log, in an RPC answer or in a setting. (It
  is in git on purpose, in one file; see "Decided by the owner".)
- A token, a code or a server reply text in a log line or an error shown to
  the page.

## Constraints

- `src/core` and `src/ui` import no host code (`tests/architecture.test.ts`).
  Network, the loopback listener and the browser launch live in
  `src/adapters/bb`, behind ports declared in the core.
- No imports across plugin directories; Unified Inbox's Google code and
  tokens are not used.
- Mail and server replies are untrusted; texts from Google are never shown
  or logged, only fixed codes.
- BB rebuilds the plugin on install from the checkout, so the client file
  must be inside `plugins/mail`.

## Approaches

1. **Own desktop client, browser sign-in, IMAP/SMTP by token (chosen).**
   The plugin opens Google's consent page in the system browser, receives
   the answer on `127.0.0.1` at a random port, keeps the refresh token
   sealed, and signs in to IMAP and SMTP with a short-lived access token
   (XOAUTH2). Smallest change: the password is used in two places today.
   Same scheme as Makosh Native (`Sources/MakoshGoogle/GoogleOAuth.swift`).
2. **Gmail API for Google accounts.** Faster sync and native labels, but a
   second sync engine next to IMAP. Rejected: far larger than the goal.
3. **Reuse Unified Inbox's grant.** Rejected: forbidden by the repository's
   plugin boundary, and that grant has other scopes.

The owner picked the first, with one change to the original proposal: the
client is not typed into settings, it is built into the plugin.

## Decided by the owner

- Google sign-in for mail first, then calendar, then contacts.
- The client JSON is committed and shipped with the plugin (decided
  2026-11-19, after first choosing "only my builds"). The owner was told
  what this means: for a desktop client Google does not treat the secret as
  confidential and it gives no access to anyone's mail, but anyone can
  present a consent screen named "Makosh" and use up or get the client
  blocked; the remedy is a new client and a release.
- A new Google Cloud project "Makosh" (`makosh-515214`) with a desktop
  client "Makosh Mail" was created on 2026-11-19. Its JSON is now in
  `bb-main/.local/google-oauth-client.json`; the first task moves it to
  `plugins/mail/google-oauth-client.json`.

## Design

### The client file

`plugins/mail/google-oauth-client.json` is the file Google Cloud gives for
a desktop client (`installed`, loopback redirects), committed as it is.
`src/adapters/bb/google-oauth-client.ts` imports it, checks its shape once
(an `installed` client, a non-empty id and secret, loopback redirects only)
and exposes `googleClient(): { id, secret } | null`; a file that fails the
check gives `null` and one log line without values. There is no build
script and no environment override.

The secret scanner is told about this one file: a gitleaks allowlist entry
for the path, with a comment that points here. `THIRD_PARTY_NOTICES.md` is
not affected. The README says the client is shared by every install and how
to replace the file with one's own.

### Credentials

An account gets a credential kind: `password` (today) or `google`.

- Store: migration element 19 adds `auth_kind TEXT NOT NULL DEFAULT
  'password'` and `granted_scopes TEXT NOT NULL DEFAULT ''` to `accounts`.
  For `google`, `password_sealed` holds the sealed refresh token; nothing
  else changes in the row. `Account` (public) gets an optional `authKind`
  (absent means `password`), so the page can show the right actions.
- `ImapConfig` and `SmtpConfig` carry `authKind` next to `password`; for
  `google`, `password` is the refresh token. Every place that builds a
  config passes the account's kind and stays synchronous.
- The adapters turn the refresh token into an access token when they
  connect (`src/adapters/bb/google-tokens.ts`): access tokens live in
  memory only, one is refreshed when it has under five minutes left, and
  one refresh runs at a time per grant. The IMAP gateway passes `auth: {
  user, accessToken }` to imapflow; the SMTP transport logs in with
  XOAUTH2. There is no token port in the core.

### Sign-in

A core module describes the flow as data (authorization URL with PKCE S256,
`state`, `access_type=offline`, `prompt=consent`,
`include_granted_scopes=true`, `login_hint` when the address is known); an
adapter does the I/O:

1. `google_sign_in_start({ email | null })` — owner only. Opens a one-shot
   HTTP listener on `127.0.0.1`, port 0, and returns `{ flowId, url }`. The
   page opens `url` with the SDK's `openUrl`.
2. The listener accepts one request with the matching `state`, answers with
   a fixed "You can close this tab" page, and closes. It closes by itself
   after five minutes.
3. The server exchanges the code, reads the address from the ID token,
   signs in to IMAP once with the new access token, then saves the account
   through the existing `addAccount` path: a new account, or the existing
   one with the same address, which keeps its id and mail and has its stop
   cleared.
4. `google_sign_in_status({ flowId })` answers `pending | done | failed`
   with a fixed reason code; the page polls it while the dialog is open.

Scopes requested by this project: `openid`, `email`,
`https://mail.google.com/`. The scope list is a parameter of the flow, so
the calendar and contacts projects add theirs and Google asks once more
(`include_granted_scopes` keeps the mail grant). The granted scopes are
stored with the account.

A sign-in for an address other than the one the form asked for is refused
with a fixed message; nothing is saved.

### Failures

- Token refresh answered `invalid_grant` (access revoked, password changed,
  or the grant expired): the account is stopped like a refused password,
  with its own problem code and banner text "Sign in to Google again" and a
  **Sign in to Google** button. The automatic retry of saved credentials
  (`sign-in-resume.ts`) does not apply to this state: a revoked grant does
  not come back.
- Refresh failed for a network or server reason: a normal sync error;
  the next round tries again.
- IMAP refused a fresh token: counted by the existing three-refusals rule.

### Page

- `status_get` gets `googleSignIn: boolean` (the client file is usable); the page
  reads nothing else about the client.
- The account form's Gmail preset shows **Sign in with Google** first and
  "Use an app password instead" below it. If the client file is unusable only
  the app password form shows, as today.
- An existing Gmail account by app password gets **Switch to Google
  sign-in** in its settings; it runs the same flow with the account's
  address as `login_hint`.
- Russian strings for every new text.

### Documentation

README (accounts section, the "Not yet" line), `PLUGIN_OVERVIEW.md`,
`bb.description` and the `marketplace.json` entry say that Google sign-in
exists and that its client ships with the plugin. Backlog item 64 is marked
done.

## Open, with the default taken

- **Consent screen status.** Checked on 2026-11-19 against
  https://developers.google.com/identity/protocols/oauth2 ("Refresh token
  expiration") and https://support.google.com/cloud/answer/15549945. In
  "Testing" an external app's refresh token for any scope beyond name,
  email and profile expires seven days after consent, and only listed test
  users (up to 100) can sign in. "In production" is open to any Google
  account; before verification a restricted scope shows the "unverified
  app" warning and the project has a lifetime cap of 100 new users. Neither
  page states a token expiry for an unverified production app. Other ends
  of a grant that hold in any status: the user changed their password (the
  token has Gmail scopes), six months without use, revocation, more than
  100 refresh tokens for one account and client, a Workspace admin's
  restriction. The new project is in "Testing"; the owner publishes it to
  production before relying on the feature. The code is the same either
  way. With the client shipped to every install, the 100-user cap is shared
  by all installs.
- **Workspace account** (`itquick.ai`): its administrator may block
  third-party clients. Then that account stays on an app password; nothing
  in the code depends on it.

## Left to the builder

- Names of the new files and of the RPC methods beyond the two above.
- Whether the SMTP library in use takes XOAUTH2 natively or needs the SASL
  string built by hand (check the installed version's types).
- The exact shape of the in-memory flow table and its limits (at most a few
  flows at once).
- Test doubles for Google's token endpoint; no test talks to Google.

## Acceptance

- With the client file replaced by an invalid one: `npm run check` and
  `npm run build` pass, and the page offers no Google sign-in.
- With the shipped file: a Gmail account connects by browser sign-in, syncs and
  sends; an existing app-password Gmail account switches and keeps its
  mail.
- Revoking access in the Google account stops the account with the "Sign
  in to Google again" banner within one sync round, and signing in again
  resumes it.
- The client id and secret appear in git only in
  `plugins/mail/google-oauth-client.json`; gitleaks is clean with the one
  allowlisted path.
