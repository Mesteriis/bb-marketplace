# Makosh Mail Google Sign-in Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Gmail account connects and syncs by signing in to Google in the browser, with the Google client shipped in the plugin.

**Architecture:** The core describes the OAuth flow as pure data and parsing (`src/core/google-oauth.ts`); adapters do the loopback listener, the token endpoint and the browser hand-off. An account gets an `authKind`; for `google` the sealed credential is the refresh token, and the IMAP gateway and the SMTP transport turn it into an access token at connect time, so the sixteen callers of `imapConfigOf` / `smtpConfigOf` stay synchronous and unchanged.

**Tech Stack:** TypeScript, vitest, imapflow 2.11 (`auth.accessToken`), nodemailer 10.3.1, better-sqlite3, zod, `node:http` and `node:crypto` in adapters only.

**Spec:** `docs/superpowers/specs/2026-11-19-mail-google-oauth-design.md`

One refinement of the spec, made while planning: there is no `AccessTokens` core port and `imapConfigOf` does not become async. `ImapConfig` and `SmtpConfig` gain `authKind`; the adapters resolve the token. Task 3 updates the spec's "Credentials" section to say so.

## Global Constraints

- Run every command from `plugins/mail`. `npm run check` after every task; `npm run build` before the last commit.
- `src/core` and `src/ui` import no `node:*`, `@get-bb/*`, Electron or Tauri. Do not weaken `tests/architecture.test.ts`.
- No import across plugin directories.
- The client id and secret appear in git only in `plugins/mail/google-oauth-client.json`. Never in a log, an RPC answer, a setting or a test fixture; fixtures use `"invented-client-id"` / `"invented-client-secret"`.
- No token, authorization code or Google reply text in a log line or an error that reaches the page: fixed codes only.
- No real addresses or message text in fixtures (`owner@example.org`).
- Scopes requested by this project, exactly: `openid`, `email`, `https://mail.google.com/`.
- Authorization URL parameters, exactly: `response_type=code`, `access_type=offline`, `prompt=consent`, `include_granted_scopes=true`, `code_challenge_method=S256`.
- An access token is refreshed when it has under five minutes left. A sign-in listener closes itself after five minutes.
- Every new page text goes through `tx()` and gets a line in `src/ui/i18n/ru.ts`.
- Do not push, tag or reload the owner's BB. Commit only the files of the task.

## Review Focus

1. The owner signs in to Google with a different address than the one being switched: nothing is saved, the dialog says the address does not match.
2. The browser tab is closed without consent, or consent is denied: the flow ends as `failed` (`denied` or `timeout`), the listener port is released, the page stops polling.
3. A second request hits the loopback port, or one with a wrong `state`: it gets a fixed 400 page and changes nothing; the first valid one wins.
4. Google returns no `refresh_token` (it does this when `prompt=consent` is missing or the grant is reused): the flow fails with `no_refresh_token` rather than saving an account that stops after an hour.
5. The token endpoint is unreachable during a sync round: an ordinary sync error (`Sync failed (TokenUnavailable)`), the account is not stopped and the three-refusals count does not move.

Each line has its test in the task that owns the code (Tasks 2, 4, 6, 7).

---

### Task 1: The shipped client file and its loader

**Files:**
- Create: `plugins/mail/google-oauth-client.json` (moved from `bb-main/.local/google-oauth-client.json`; do not print it)
- Create: `src/adapters/bb/google-oauth-client.ts`, `src/adapters/bb/google-oauth-client.test.ts`
- Modify: `bb-main/.gitleaksignore`, `tsconfig.json` (only if `resolveJsonModule` is off), root `.gitignore` (drop the `.local/` lines added on 2026-11-19 if the folder is now empty)

**Interfaces:**
- Produces: `type GoogleClient = { id: string; secret: string }`; `parseGoogleClient(document: unknown): GoogleClient | null`; `googleClient(): GoogleClient | null` (the shipped file, parsed once).

- [ ] **Step 1: Check Google's documentation** (OAuth consent screen: publishing status, refresh token expiry in Testing, unverified production apps). Record what it says, with the URL and date, in the spec's "Open" section, replacing "my understanding". If Testing does expire refresh tokens in seven days, the final report tells the owner to publish the app; do not change the console.
- [ ] **Step 2: Write the failing tests** for `parseGoogleClient`:

```ts
const good = { installed: { client_id: "invented-client-id", client_secret: "invented-client-secret", redirect_uris: ["http://localhost"] } };
expect(parseGoogleClient(good)).toEqual({ id: "invented-client-id", secret: "invented-client-secret" });
expect(parseGoogleClient({ web: good.installed })).toBeNull();                                   // not a desktop client
expect(parseGoogleClient({ installed: { ...good.installed, client_secret: "" } })).toBeNull();
expect(parseGoogleClient({ installed: { ...good.installed, redirect_uris: ["https://example.org/cb"] } })).toBeNull();
expect(parseGoogleClient({ installed: { ...good.installed, redirect_uris: [] } })).toBeNull();
expect(parseGoogleClient(null)).toBeNull();
```

and one for the shipped file: `expect(googleClient()).not.toBeNull()`.
- [ ] **Step 3: Run** `npx vitest run src/adapters/bb/google-oauth-client.test.ts` — FAIL, module missing.
- [ ] **Step 4: Move the file** (`git mv` is not possible, it is untracked: `mv ../../.local/google-oauth-client.json google-oauth-client.json && chmod 644 google-oauth-client.json`) and implement the loader. A loopback redirect is `http://localhost` or `http://127.0.0.1`, with an optional port and trailing slash.
- [ ] **Step 5: Run the tests** — PASS. Run `gitleaks detect --no-git --source plugins/mail/google-oauth-client.json` from the repository root if gitleaks is installed, and add the fingerprint it prints to `.gitleaksignore` with a comment line `# Google desktop client shipped on purpose: docs/superpowers/specs/2026-11-19-mail-google-oauth-design.md`. If gitleaks is not installed, say so in the task report; do not invent a fingerprint.
- [ ] **Step 6: Commit** `feat(mail): ship the Google desktop client with the plugin`.

### Task 2: The flow as data — `src/core/google-oauth.ts`

**Files:**
- Create: `src/core/google-oauth.ts`, `src/core/google-oauth.test.ts`
- Modify: `src/core/index.ts` (export)

**Interfaces:**
- Produces:
  - `GOOGLE_MAIL_SCOPES: readonly ["openid", "email", "https://mail.google.com/"]`
  - `googleAuthorizationUrl(input: { clientId: string; redirectUri: string; scopes: readonly string[]; state: string; codeChallenge: string; loginHint: string | null }): string`
  - `type GoogleTokenReply = { ok: true; accessToken: string; expiresInSeconds: number; refreshToken: string | null; scopes: string[]; idToken: string | null } | { ok: false; reason: "invalid_grant" | "other" }`
  - `parseGoogleTokenReply(status: number, body: unknown): GoogleTokenReply`
  - `googleIdentity(idToken: string): { subject: string; email: string } | null` (payload decode only; the token came from Google over TLS)
  - `sameMailbox(a: string, b: string): boolean` (trim, lower case)

- [ ] **Step 1: Write the failing tests.** URL: parse the result with `new URL` and assert origin+path `https://accounts.google.com/o/oauth2/v2/auth` and each parameter from Global Constraints, `scope` equal to `"openid email https://mail.google.com/"`, `login_hint` present for `"owner@example.org"` and absent for `null`. Reply: `parseGoogleTokenReply(200, { access_token: "a", expires_in: 3599, refresh_token: "r", scope: "openid email https://mail.google.com/", id_token: "x.y.z" })` gives the `ok: true` shape with `scopes` of three items; a 200 without `refresh_token` gives `refreshToken: null`; `(400, { error: "invalid_grant" })` gives `invalid_grant`; `(500, "oops")`, `(200, {})` and `(200, { access_token: "a", expires_in: -1 })` give `other`. Identity: a token whose payload is `{"sub":"123","email":"Owner@Example.org","email_verified":true}` gives `{ subject: "123", email: "owner@example.org" }`; `email_verified: false`, a missing email, two segments, and non-JSON give `null`. `sameMailbox(" Owner@Example.org", "owner@example.org")` is true.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.** Base64url decoding with `atob`, no `Buffer`.
- [ ] **Step 4: Run** — PASS; `npx vitest run tests/architecture.test.ts` — PASS.
- [ ] **Step 5: Commit** `feat(mail): Google OAuth URL and reply parsing in the core`.

### Task 3: `authKind` in the model, the store and the configs

**Files:**
- Modify: `src/core/model.ts`, `src/core/ports.ts`, `src/core/compose.ts` (`imapConfigOf`), `src/core/compose-outbox.ts` (`smtpConfigOf`), `src/core/accounts.ts`, `src/core/testing/fakes.ts`, `src/adapters/bb/sqlite-store.ts`, their tests; the spec's "Credentials" section.

**Interfaces:**
- Produces:
  - `authKindSchema = z.enum(["password", "google"])`; `Account.authKind: AuthKind`; `StoredAccount.grantedScopes: string[]`
  - `ImapConfig.authKind: AuthKind` and `SmtpConfig.authKind: AuthKind`; for `google`, `password` holds the refresh token
  - Migration 19: `ALTER TABLE accounts ADD COLUMN auth_kind TEXT NOT NULL DEFAULT 'password'` and `ALTER TABLE accounts ADD COLUMN granted_scopes TEXT NOT NULL DEFAULT ''` (space-separated)
  - `saveGoogleAccount(deps: AccountDeps, input: { email: string; refreshToken: string; scopes: string[] }): Promise<Account>` — the Gmail preset's host, port and SMTP; an existing account with the same address keeps its id, creation time and sync history, becomes `google`, and has `authFailed` and `lastError` cleared; an address that is an active alias of another account is refused like `addAccount` refuses it. It does not connect: the caller has already signed in.

- [ ] **Step 1: Write the failing tests.** Store: an account saved with `authKind: "google"`, `grantedScopes: ["openid", "email"]` reads back the same; a database at migration 18 with one account opens at 19 with `authKind: "password"`, `grantedScopes: []`. Core: `imapConfigOf` of a google account returns `authKind: "google"`; `saveGoogleAccount` on a new address creates a Gmail account with host `imap.gmail.com`; on the address of an existing password account with `authFailed: true` it returns the same `id` with `authKind: "google"`, `authFailed: false`, `lastError: null`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.** `makeStoredAccount` in the fakes defaults to `authKind: "password"`, `grantedScopes: []`. Fix every fixture the type change breaks; behaviour of password accounts must not change.
- [ ] **Step 4: Run** `npm run check` — PASS except the known load-sensitive `listThreads … stays fast` timing test, which must pass alone.
- [ ] **Step 5: Rewrite the spec's "Credentials" section** to match this task (no `AccessTokens` port, configs carry `authKind`).
- [ ] **Step 6: Commit** `feat(mail): accounts carry a credential kind`.

### Task 4: Access tokens — `src/adapters/bb/google-tokens.ts`

**Files:**
- Create: `src/adapters/bb/google-tokens.ts`, `src/adapters/bb/google-tokens.test.ts`
- Modify: `src/core/ports.ts`

**Interfaces:**
- Consumes: `GoogleClient` (Task 1), `parseGoogleTokenReply` (Task 2).
- Produces:
  - in `ports.ts`: `class GrantRevokedError extends ImapAuthError` (`name = "GrantRevokedError"`)
  - `createGoogleTokens(deps: { client: GoogleClient | null; fetch: typeof fetch; now: () => number }): GoogleTokens`
  - `GoogleTokens.accessToken(refreshToken: string): Promise<string>` — throws `GrantRevokedError` on `invalid_grant`, `SafeImapError("TokenUnavailable")` on anything else or when `client` is null
  - `GoogleTokens.exchangeCode(input: { code: string; codeVerifier: string; redirectUri: string }): Promise<GoogleTokenReply>`
  - `GoogleTokens.forget(refreshToken: string): void`
  - `GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"`

- [ ] **Step 1: Write the failing tests** with a recording fake `fetch`: the first `accessToken("r")` posts `grant_type=refresh_token` form-encoded to `GOOGLE_TOKEN_URL` and returns `"a1"`; a second call 3294 s later (reply said `expires_in: 3599`) makes no request; one at 3300 s (under five minutes left) makes a second request; two concurrent calls make one request; a 400 `invalid_grant` rejects with `GrantRevokedError`; a rejected `fetch` and a 503 reject with an error whose `code` is `"TokenUnavailable"`; no rejection's message contains `"r"` or the client secret; `exchangeCode` posts `grant_type=authorization_code` with `code_verifier` and `redirect_uri`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.** The cache is keyed by the refresh token and holds at most 16 entries.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(mail): Google access tokens from a refresh token`.

### Task 5: IMAP and SMTP sign in with a token

**Files:**
- Modify: `src/adapters/bb/imapflow-gateway.ts`, `src/adapters/bb/smtp-transport.ts`, their tests, `server.ts` (construct one `GoogleTokens` and pass it to both)

**Interfaces:**
- Consumes: `GoogleTokens.accessToken` (Task 4), `ImapConfig.authKind` / `SmtpConfig.authKind` (Task 3).
- Produces: the gateway's options gain `googleTokens?: GoogleTokens`; the transport's the same.

- [ ] **Step 1: Write the failing tests.** Gateway: with `authKind: "google"` the options given to `createClient` have `auth: { user: "owner@example.org", accessToken: "a1" }` and no `pass`; with `authKind: "password"` they are unchanged; a `GrantRevokedError` from the tokens comes out of `test()` as `{ ok: false, authFailed: true }` and out of `openFolder` as the same error instance; `TokenUnavailable` comes out as a `SafeImapError` with that code. Transport: a google config logs in with the access token by XOAUTH2 and never passes the refresh token to the connection.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.** Check nodemailer 10.3.1's `SMTPConnection.login` types for the OAuth2 form before choosing between its native support and a hand-built SASL string; say which in the commit body. `describeImapError` passes `GrantRevokedError` through (it already passes `ImapAuthError`).
- [ ] **Step 4: Run** `npm run check` — PASS.
- [ ] **Step 5: Commit** `feat(mail): IMAP and SMTP sign in with a Google access token`.

### Task 6: A revoked grant stops the account

**Files:**
- Modify: `src/core/sync.ts`, `src/core/sync-problems.ts`, `src/core/retry-sign-in.ts`, `src/adapters/bb/sync-service.ts`, `src/ui/mail-status.tsx`, their tests

**Interfaces:**
- Consumes: `GrantRevokedError` (Task 4).
- Produces: `GRANT_REVOKED_ERROR = "Google sign-in expired"` (the stored `lastError`); `SyncProblemCode` gains `"grant_revoked"`; `syncProblemText` for it: `"Google no longer accepts this sign-in. Sign in to Google again."`; `RetrySignInResult` gains `"sign_in_needed"`.

- [ ] **Step 1: Write the failing tests.** Sync: with `authRefusals` counting and an account that has synced, one `GrantRevokedError` gives `{ status: "error", error: "Google sign-in expired", authFailed: true }` at once. Problems: `parseSyncProblems("Google sign-in expired")` gives one problem with code `grant_revoked`, and `isQuietlyOffline` is false for it. Retry: `retrySignIn` on an account stopped with that `lastError` returns `"sign_in_needed"` without calling the gateway. Loop: such an account is not tried by the automatic resume (the gateway's `test` is never called across two rounds ten minutes apart). Review Focus 5: a `TokenUnavailable` round leaves `authFailed: false`, `lastError: "Sync failed (TokenUnavailable)"`, and a following `ImapAuthError` round is still the first of three.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.** `TokenUnavailable` joins `NETWORK_CODES`.
- [ ] **Step 4: Run** `npm run check` — PASS.
- [ ] **Step 5: Commit** `feat(mail): a revoked Google grant stops the account with its own message`.

### Task 7: The sign-in flow and its RPC

**Files:**
- Create: `src/adapters/bb/google-sign-in.ts`, `src/adapters/bb/google-sign-in.test.ts`
- Modify: `src/core/contract.ts`, `src/core/contract.test.ts`, `src/core/model.ts` (`statusViewSchema.googleSignIn: z.boolean()`), `server.ts`, `server.test.ts`

**Interfaces:**
- Consumes: Tasks 1–5; `saveGoogleAccount` (Task 3).
- Produces:
  - `createGoogleSignIn(deps: { client: GoogleClient | null; tokens: GoogleTokens; testSignIn: (email: string, refreshToken: string) => Promise<"ok" | "refused" | "unreachable">; save: (input: { email: string; refreshToken: string; scopes: string[] }) => Promise<Account>; randomBytes: (size: number) => Uint8Array; sha256: (text: string) => Uint8Array; now: () => number; listen?: … })`
  - `.start(input: { email: string | null }): Promise<{ flowId: string; url: string }>` and `.status(flowId: string): { state: "pending" } | { state: "done"; accountId: string } | { state: "failed"; reason: "denied" | "timeout" | "mismatch" | "no_refresh_token" | "refused" | "unreachable" | "alias" | "error" }`, `.close(): void`
  - RPC `google_sign_in_start: { input: { email: string | null }, output: { flowId, url } }` and `google_sign_in_status: { input: { flowId }, output: the status union }`; `GOOGLE_METHODS = ["google_sign_in_start", "google_sign_in_status"]` in `contract.ts`, added to the "later" lists of `contract.test.ts` the way `SIGN_IN_METHODS` is.
  - `status_get` answers `googleSignIn: googleClient() !== null`.

- [ ] **Step 1: Write the failing tests** against a real listener on `127.0.0.1` port 0 and a fake `tokens`: `start` returns a URL whose `redirect_uri` is `http://127.0.0.1:<port>` and whose `state` is 32+ characters; `GET /?state=<state>&code=c1` answers 200 with a page that contains "You can close this tab", after which `status` is `done` with the saved account's id and `save` got the refresh token and scopes; then the port refuses connections. Review Focus 1: `start({ email: "owner@example.org" })` and an ID token for `other@example.org` → `failed: mismatch`, `save` not called. Focus 2: `?error=access_denied&state=…` → `failed: denied`; with `now` advanced five minutes → `failed: timeout` and the port closed. Focus 3: a wrong `state` → 400, status still `pending`; a second valid request after the first → 400. Focus 4: a token reply without `refresh_token` → `failed: no_refresh_token`. `testSignIn` answering `refused` → `failed: refused`. At most three flows pending: a fourth `start` closes the oldest. With `client: null`, `start` rejects. Server: both RPCs refuse a plugin caller; `status_get` has `googleSignIn: true`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.** The listener answers only `GET /`; every other path is 404. No query value is logged. Wire it in `server.ts`: `testSignIn` is `gateway.test` with `authKind: "google"`; `save` is `saveGoogleAccount` followed by `publishChanged`, `idle.refresh()` and `loop.wake(id)`; the service is closed on plugin shutdown.
- [ ] **Step 4: Run** `npm run check` — PASS.
- [ ] **Step 5: Commit** `feat(mail): Google sign-in flow on a loopback listener`.

### Task 8: The page

**Files:**
- Modify: `src/ui/account-form.tsx`, `src/ui/account-form.test.tsx`, `src/ui/mail-page.tsx`, `src/ui/mail-settings.tsx` (the account's row), `app.tsx`, `app.test.tsx`, `src/ui/i18n/ru.ts`

**Interfaces:**
- Consumes: the two RPCs and `googleSignIn` (Task 7); `Account.authKind` (Task 3); problem code `grant_revoked` (Task 6).
- Produces: `onGoogleSignIn?: (email: string | null) => Promise<void>` on the form, the settings row and the banner.

- [ ] **Step 1: Write the failing tests.** Form: with the Gmail preset and `googleSignIn: true` there is a button "Sign in with Google" before the password field and a "Use an app password instead" toggle; with `googleSignIn: false`, or the iCloud preset, there is none. App: clicking it calls `google_sign_in_start`, opens the returned URL through the SDK's `openUrl`, polls `google_sign_in_status`, and on `done` selects the account and closes the form; on `failed: mismatch` shows "That Google account is a different address." and stops polling. Banner: an account with `lastError: "Google sign-in expired"` shows "Sign in to Google" and neither "Try the saved password" nor "Update app password". Settings: a Gmail account with `authKind: "password"` has "Switch to Google sign-in"; one with `google` shows "Signed in with Google".
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.** Poll every two seconds, stop on unmount or when the dialog closes. One fixed sentence per failure reason.
- [ ] **Step 4: Run** `npm run check` — PASS. Follow the repository's UI routing for the visual check (`product-design` → `ui-qa`) and look at the form and the banner in the browser at the narrow and wide sizes.
- [ ] **Step 5: Commit** `feat(mail): Sign in with Google in the account form, settings and banner`.

### Task 9: Documents, manifests, the real sign-in

**Files:**
- Modify: `README.md`, `CHANGELOG.md`, `PLUGIN_OVERVIEW.md`, `package.json` (`bb.description`), `../../marketplace.json`, `../../docs/mail-feature-backlog.md` (item 64), `../../docs/architecture.md` only if it lists adapters

- [ ] **Step 1: Update the texts** as the spec's "Documentation" section says, including how to replace the client file with one's own and that every install shares the shipped client.
- [ ] **Step 2: Run** `npm run check`, `npm run build`, `node ../../scripts/check-manifests.mjs` — all PASS.
- [ ] **Step 3: Commit** `docs(mail): Google sign-in`.
- [ ] **Step 4: With the owner present** and after their go-ahead to update the live worktree: one reload, then the owner switches one Gmail account, and the log shows `sync <id>: ok`. Sending a test message to themselves is the owner's call. Report what was and was not exercised.
