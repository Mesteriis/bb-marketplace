# Mail: access for other plugins — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Other BB plugins get data from Makosh Mail only through a small `plugin_*` API and only with the owner's grant per plugin, right and account; everything else refuses a plugin caller.

**Architecture:** A pure core module holds rights, grants and limits behind a store port. One wrapper around `bb.rpc.register`'s handlers refuses a `plugin` caller on every method outside `PLUGIN_API_METHODS` and checks the grant on the ones inside. The API handlers reuse the store reads that the agent tools use, so the owner's AI access filter applies unchanged.

**Tech Stack:** TypeScript, zod, vitest, better-sqlite3 store, React with BB's vendored components, `@get-bb/plugin-sdk`.

**Spec:** `docs/superpowers/specs/2026-11-19-mail-plugin-access-design.md`

## Global Constraints

- All paths are under `plugins/mail`. Run `npm run check` after every task and `npm run build` before calling a task done; `node ../../scripts/check-manifests.mjs` after touching `PLUGIN_OVERVIEW.md`, `package.json` or `marketplace.json` (`PLUGIN_OVERVIEW.md` is at 3999 of 4000 characters: shorten before adding).
- `src/core` and `src/ui` import no `node:*`, `@get-bb/*`, Electron or Tauri; `tests/architecture.test.ts` is not weakened.
- Fixtures hold no real addresses or message text; use `example.com`, `example.net`.
- Never log, print or store in a fixture a real token, refresh token or client value. Test tokens are literals like `"at-calendar-1"`.
- No right hands out the scope `https://mail.google.com/`. The refresh token, app passwords and the vault key never appear in an answer of a `plugin_*` method.
- Every string shown to the owner goes through `tx()`/`txn()`/`msg()` with a Russian line in `src/ui/i18n/ru.ts` (values unicode-escaped, inserted before the `"Try the saved password":` line).
- New RPC method lists are added to every "later" filter of the positional contract tests, as `SETTINGS_METHODS` and `GOOGLE_METHODS` were.
- Do not push, tag, publish, or install or reload anything in the owner's running BB without their go-ahead.
- Commits touch only `plugins/mail` and `docs`; messages end with `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>`.
- Timing tests (`listThreads … stays fast`, `htmlToText … quickly`, attachment-indexer budgets) fail under machine load; rerun alone before treating as a regression.

Exact values from the spec: `PLUGIN_API_VERSION = 1`; reason at most 200 characters, one line; 5 access requests a day per plugin; 20 proposed drafts a day per plugin; pages of at most 100 (messages, invites) and 200 (contacts); a refused call is logged at most once per plugin, method and hour; Google scopes `https://www.googleapis.com/auth/calendar` and `https://www.googleapis.com/auth/contacts`.

## Review Focus

1. A plugin id that is unknown, empty, very long or holds odd characters arrives in a request: it is stored and shown as text, never as markup, and the settings section still renders.
2. An account is removed while a plugin holds grants for it: the grants go, the next call is refused as missing a right, nothing throws.
3. A plugin asks for a right that does not exist, or for the same right twice: the request is refused as invalid, not stored half.
4. The owner revokes a grant while a paged read is in progress: the next page is refused; a cursor is no proof of a right.
5. A method added to the contract later without touching the plugin list: a plugin caller is refused on it (the contract walk test).

---

## File Structure

- Create `src/core/plugin-access.ts` — rights, grant and request types, `hasRight`, limits; pure.
- Create `src/core/plugin-api.ts` — zod schemas of the `plugin_*` methods, `PLUGIN_API_METHODS`, `PLUGIN_OWNER_METHODS`, `PLUGIN_METHOD_RIGHT`, `PLUGIN_API_VERSION`.
- Create `src/adapters/bb/plugin-guard.ts` — `guardHandlers`.
- Create `src/adapters/bb/plugin-api-rpc.ts` — handlers of the API and of the owner's grant methods.
- Create `src/ui/settings/plugin-access-section.tsx` — the settings section.
- Create `docs/plugin-api.md` (in the plugin) — the contract for other plugins' authors.
- Modify `src/core/contract.ts` (schemas into `rpcSchemas`, method lists), `src/core/ports.ts` and `src/adapters/bb/sqlite-store.ts` (grants, requests, `prepared_by`), `src/core/agent-log.ts` (actor and tools), `src/adapters/bb/google-tokens.ts` (narrowed exchange), `server.ts` (wrap registration, remove `refusePluginCaller`), `src/ui/settings/sections.ts` and `settings-body.tsx`, the composer and Drafts row for the "Prepared by" line, `app.tsx` (ports for the section), `src/ui/i18n/ru.ts`, `PLUGIN_OVERVIEW.md`, `README.md`.

---

### Task 1: The guard — every plugin call refused outside the API list

**Files:**
- Create: `src/core/plugin-api.ts`, `src/adapters/bb/plugin-guard.ts`, `src/adapters/bb/plugin-guard.test.ts`
- Modify: `server.ts` (registration at `bb.rpc.register(rpcContract, {…})`, the 33 `refusePluginCaller` calls and the function), `server.test.ts`

**Interfaces:**
- Produces:
  - `plugin-api.ts`: `export const PLUGIN_API_VERSION = 1`; `export const PLUGIN_API_METHODS: readonly string[]` (empty in this task); `export const PLUGIN_CALLER_MESSAGE = "Other plugins reach Makosh Mail only through its plugin API"` (replaces the constant of the same name in `server.ts`, which re-exports it).
  - `plugin-guard.ts`: `export type PluginCheck = (pluginId: string, method: string, input: unknown) => void` (throws a refusal); `export function guardHandlers<H extends Record<string, (input: never, context: ExperimentalPluginRpcHandlerContext) => unknown>>(handlers: H, opts: { api: ReadonlySet<string>; check: PluginCheck }): H`.

- [ ] **Step 1: Write the failing tests** in `plugin-guard.test.ts`

```ts
const plugin = { experimental_caller: { kind: "plugin", pluginId: "calendar" }, experimental_signal: new AbortController().signal } as const;
const client = { experimental_caller: { kind: "client" }, experimental_signal: new AbortController().signal } as const;

it("refuses a plugin caller on a method outside the API list, read or write", async () => {
  const guarded = guardHandlers({ threads_list: async () => "rows", message_action: async () => "done" }, { api: new Set(), check: () => {} });
  await expect(guarded.threads_list({} as never, plugin)).rejects.toMatchObject({ code: "forbidden", message: PLUGIN_CALLER_MESSAGE });
  await expect(guarded.message_action({} as never, plugin)).rejects.toMatchObject({ code: "forbidden" });
});
it("lets a client caller through unchanged", async () => {
  const guarded = guardHandlers({ threads_list: async () => "rows" }, { api: new Set(), check: () => { throw new Error("not for clients"); } });
  expect(await guarded.threads_list({} as never, client)).toBe("rows");
});
it("on an API method runs the check with the plugin id before the handler", async () => {
  const seen: string[] = [];
  const guarded = guardHandlers({ plugin_accounts_list: async () => { seen.push("handler"); return []; } }, {
    api: new Set(["plugin_accounts_list"]),
    check: (pluginId, method) => { seen.push(`${pluginId}:${method}`); },
  });
  await guarded.plugin_accounts_list({} as never, plugin);
  expect(seen).toEqual(["calendar:plugin_accounts_list", "handler"]);
});
it("a check that throws keeps the handler from running", async () => { /* check throws refuse("forbidden", "x"); handler spy not called */ });
```

And in `server.test.ts`, the contract walk (Review Focus 5):

```ts
it("every method of the contract refuses a plugin caller unless it is in the plugin API", async () => {
  const { handlers } = registerForTest();           // the existing helper that captures bb.rpc.register's handlers
  for (const method of Object.keys(rpcSchemas)) {
    if (PLUGIN_API_METHODS.includes(method)) continue;
    await expect(Promise.resolve().then(() => handlers[method]({} as never, pluginContext("other")))).rejects.toMatchObject({ code: "forbidden" });
  }
});
```

- [ ] **Step 2: Run** `npx vitest run src/adapters/bb/plugin-guard.test.ts server.test.ts -t "plugin"` — FAIL (module missing; reads answer a plugin).
- [ ] **Step 3: Implement** `plugin-api.ts` constants and `guardHandlers` (the refusal is made with `refuse("forbidden", …)` from `bb-rpc.ts`; a synchronous handler's result is returned as is). In `server.ts` pass the handler map through `guardHandlers(…, { api: new Set(PLUGIN_API_METHODS), check: deps.pluginCheck })` and delete `refusePluginCaller` with its 33 calls; update the comment above `bb.rpc.register` to say plugins are refused on everything outside the API. Existing tests that expected the write refusal keep passing through the guard.
- [ ] **Step 4: Run** `npm run check` — PASS. `npm run build`.
- [ ] **Step 5: Commit** `feat(mail): other plugins are refused on every method outside the plugin API`

### Task 2: Rights, grants and requests in the core and the store

**Files:**
- Create: `src/core/plugin-access.ts`, `src/core/plugin-access.test.ts`
- Modify: `src/core/ports.ts`, `src/adapters/bb/sqlite-store.ts` (new migration, element 20), `src/adapters/bb/sqlite-store.test.ts`

**Interfaces:**
- Produces, in `plugin-access.ts`:
  - `export const PLUGIN_RIGHTS = ["mail.read", "contacts.read", "invites.read", "mail.propose", "google.calendar", "google.contacts"] as const; export type PluginRight = (typeof PLUGIN_RIGHTS)[number];`
  - `export const GOOGLE_RIGHT_SCOPE: Record<"google.calendar" | "google.contacts", string>` with the two scope URLs above.
  - `export type PluginGrant = { pluginId: string; right: PluginRight; accountId: string; grantedAt: string }`
  - `export type PluginRequest = { pluginId: string; rights: PluginRight[]; reason: string; askedAt: string }`
  - `export const PLUGIN_ID_MAX = 128; REQUEST_REASON_MAX = 200; REQUESTS_PER_DAY = 5; PROPOSALS_PER_DAY = 20;`
  - `export function hasRight(grants: readonly PluginGrant[], pluginId: string, right: PluginRight, accountId: string): boolean`
  - `export function grantedAccounts(grants: readonly PluginGrant[], pluginId: string, right: PluginRight): string[]`
  - `export function cleanRequest(input: { rights: readonly string[]; reason: string }): { ok: true; rights: PluginRight[]; reason: string } | { ok: false }` — unknown right or empty list → not ok; duplicates collapsed; reason trimmed, line breaks turned to spaces, cut to 200.
  - `export function overDailyLimit(timesIso: readonly string[], now: Date, limit: number): boolean` — counts entries in the last 24 hours.
- Produces, in `MailStore` (`ports.ts`): `listPluginGrants(): PluginGrant[]`, `setPluginGrant(grant: PluginGrant, on: boolean): void`, `revokePluginGrants(pluginId: string): void`, `getPluginRequests(): PluginRequest[]`, `putPluginRequest(request: PluginRequest): void`, `dismissPluginRequest(pluginId: string): void`, `pluginRequestTimes(pluginId: string): string[]`, `pluginLastCall(): Map<string, string>` (plugin id → ISO time, filled in Task 4).

- [ ] **Step 1: Write the failing tests.** Core: `hasRight` true only for the exact plugin, right and account (three near-miss cases); `cleanRequest({ rights: ["mail.read", "mail.read"], reason: " a\nb " })` → `{ ok: true, rights: ["mail.read"], reason: "a b" }`; `cleanRequest({ rights: ["mail.delete"], reason: "x" })` → `{ ok: false }`; a 250-character reason comes back 200 long; `overDailyLimit` with 5 times inside 24 h and limit 5 → true, with one of them 25 h old → false. Store: a grant set and listed; set twice stays one row; `setPluginGrant(g, false)` removes it; removing the account removes its grants (Review Focus 2); a second request of a plugin replaces the first; `pluginRequestTimes` keeps both times; the migration runs on a database at the previous version (follow the existing migration tests and `seedLegacyAccount`).
- [ ] **Step 2: Run** the two test files — FAIL.
- [ ] **Step 3: Implement.** Migration: `plugin_grants (plugin_id TEXT, right TEXT, account_id TEXT, granted_at TEXT, PRIMARY KEY (plugin_id, right, account_id))`, `plugin_requests (plugin_id TEXT PRIMARY KEY, rights_json TEXT, reason TEXT, asked_at TEXT)`, `plugin_request_times (plugin_id TEXT, asked_at TEXT)`, `ALTER TABLE compose_drafts ADD COLUMN prepared_by TEXT`. Account removal deletes its grants in the same transaction as the account.
- [ ] **Step 4: Run** `npm run check` — PASS.
- [ ] **Step 5: Commit** `feat(mail): plugin grants and access requests in the store`

### Task 3: Asking for access and the owner's grant methods

**Files:**
- Modify: `src/core/plugin-api.ts`, `src/core/contract.ts`, `server.ts`, contract tests
- Create: `src/adapters/bb/plugin-api-rpc.ts`, `src/adapters/bb/plugin-api-rpc.test.ts`

**Interfaces:**
- Consumes: Task 1 `guardHandlers`, `PluginCheck`; Task 2 store methods and `cleanRequest`, `overDailyLimit`, `hasRight`.
- Produces:
  - Schemas in `plugin-api.ts`, merged into `rpcSchemas`: `plugin_access_info` `{}` → `{ apiVersion: 1, grants: { right, accountId }[], request: { rights, reason, askedAt } | null }`; `plugin_access_request` `{ rights: string[], reason: string }` → `{ ok: true }`; `plugin_grants_list` `{}` → `{ plugins: { pluginId, grants: { right, accountId, grantedAt }[], lastCallAt: string | null }[], requests: PluginRequest[] }`; `plugin_grant_set` `{ pluginId, right, accountId, on: boolean }` → `{ ok: true }`; `plugin_grant_revoke` `{ pluginId }` → `{ ok: true }`; `plugin_request_dismiss` `{ pluginId }` → `{ ok: true }`.
  - `PLUGIN_API_METHODS` now `["plugin_access_info", "plugin_access_request"]`; `PLUGIN_OWNER_METHODS = ["plugin_grants_list", "plugin_grant_set", "plugin_grant_revoke", "plugin_request_dismiss"]`; `PLUGIN_METHOD_RIGHT: Partial<Record<string, PluginRight | "google">>` (empty entries for the two no-right methods).
  - `plugin-api-rpc.ts`: `export function createPluginApi(deps: { store: MailStore; now: () => Date; notify: (title: string, body: string) => void; … }): { handlers: …; check: PluginCheck }`. `check` refuses with `forbidden` and the message `` `Makosh Mail: this plugin has no "${right}" access` `` when `PLUGIN_METHOD_RIGHT[method]` is a right and the caller holds it for no account.
  - `export const PLUGIN_ONLY_MESSAGE = "This method is for other plugins"`, `REQUEST_INVALID_MESSAGE = "Unknown right in the request"`, `REQUEST_LIMIT_MESSAGE = "Too many access requests today"`.

- [ ] **Step 1: Write the failing tests** in `plugin-api-rpc.test.ts` (handlers called directly with a plugin or client context):
  - `plugin_access_info` for a plugin with no grants → `{ apiVersion: 1, grants: [], request: null }`.
  - `plugin_access_request({ rights: ["mail.read", "invites.read"], reason: "Calendar sync" })` stores the request, calls `notify` once, and `plugin_access_info` then shows it.
  - the sixth request within 24 hours is refused with `REQUEST_LIMIT_MESSAGE`; nothing stored, no notification.
  - `rights: ["mail.delete"]` → `invalid`, `REQUEST_INVALID_MESSAGE`, nothing stored (Review Focus 3).
  - a plugin id of 300 characters and one of `"<img src=x>"`: the first is refused as `invalid`, the second is stored verbatim (Review Focus 1).
  - a `client` caller on `plugin_access_info` → `forbidden`, `PLUGIN_ONLY_MESSAGE`.
  - `plugin_grant_set` then `plugin_grants_list` shows the grant; a `plugin` caller on any of the four owner methods → `forbidden` (through the guard: they are not in `PLUGIN_API_METHODS`).
  - `plugin_grant_set` for an unknown account → `not_found`; for a right outside `PLUGIN_RIGHTS` → `invalid`.
  - `plugin_grant_set` with a `google.*` right is refused here with `invalid` and `"Turn this on in Mail settings"`: Task 7 gives it its own path.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** the schemas, the handlers and `check`; wire `createPluginApi` in `server.ts` (`deps.pluginCheck = api.check`, handlers spread into the registered map). The notification says `tx`-free English on the server: title `"A plugin asks for access to mail"`, body the plugin id. Add the two method lists to the positional contract tests.
- [ ] **Step 4: Run** `npm run check` — PASS. `npm run build`.
- [ ] **Step 5: Commit** `feat(mail): a plugin asks for access, the owner grants and revokes it`

### Task 4: The read methods and the log

**Files:**
- Modify: `src/core/plugin-api.ts`, `src/core/agent-log.ts`, `src/adapters/bb/plugin-api-rpc.ts` and its test, `src/adapters/bb/sqlite-store.ts` (only if a read needs an account filter it lacks), `src/ui/agent-activity.tsx` (labels), `src/ui/i18n/ru.ts`

**Interfaces:**
- Consumes: Task 3 `createPluginApi`, `check`; the store reads behind the agent tools `mail_search`, `mail_read`, `mail_contacts` (they apply `store.getAiScope()`), and `src/adapters/bb/invite.ts` for invitations.
- Produces:
  - `plugin_accounts_list` `{}` → `{ accounts: { id, email, displayName, provider }[] }` — accounts with a `mail.read` grant.
  - `plugin_messages_search` `{ accountId?: string, address?: string, text?: string, since?: string (ISO date), limit?: 1..100 (default 50), cursor?: string }` → `{ messages: { id, accountId, threadId, date, from: { name, address }, to: string[], subject, snippet }[], nextCursor: string | null }`.
  - `plugin_message_read` `{ messageId }` → `{ id, accountId, threadId, date, from, to, cc, subject, text, attachments: { name, size, type }[] }`.
  - `plugin_contacts_list` `{ accountId?, query?, limit?: 1..200 (default 100), cursor? }` → `{ contacts: { name, address, received: number, sent: number, lastAt: string }[], nextCursor }`.
  - `plugin_invites_list` `{ accountId?, since?, limit?: 1..100 (default 50), cursor? }` → `{ invites: { messageId, accountId, uid, method, summary, start, end, organizer, attendees: string[], location }[], nextCursor }`.
  - `PLUGIN_METHOD_RIGHT`: accounts, search, read → `mail.read`; contacts → `contacts.read`; invites → `invites.read`. All five join `PLUGIN_API_METHODS`.
  - `agent-log.ts`: actor `"plugin"`; tools `"plugin_search"`, `"plugin_read"`, `"plugin_contacts"`, `"plugin_invites"`, `"plugin_accounts"`, `"plugin_propose"`, `"plugin_token"`, `"plugin_request"`; outcome `"refused"` if not present. A log entry of a plugin carries the plugin id in the existing `refId` field.

- [ ] **Step 1: Write the failing tests** (a seeded store with two accounts `a@example.com`, `b@example.net`; plugin `crm` holds `mail.read` on the first only):
  - `plugin_accounts_list` returns the first account only.
  - `plugin_messages_search({})` returns messages of the first account only; with `accountId` of the second → `forbidden` naming `mail.read`.
  - a message from a never-share sender, and one in Spam, are absent from search and `plugin_message_read` of either → `not_found` (the AI access filter).
  - `plugin_message_read` of a message in the ungranted account → `not_found` (not `forbidden`: existence is not disclosed).
  - `limit: 101` → `invalid`; `limit` absent returns at most 50.
  - paging: 3 messages, `limit: 2` → two and a cursor; the grant is revoked; the cursor call → `forbidden` (Review Focus 4).
  - `plugin_contacts_list` with only `mail.read` → `forbidden` naming `contacts.read`.
  - `plugin_invites_list` returns the parsed invitation of a seeded message with a `text/calendar` part.
  - no answer holds a key named `password`, `refreshToken`, `passwordSealed` or `vaultKey` (walk the JSON of each answer).
  - each successful call writes one log entry with actor `plugin`, the tool, a count and no subject, address or text; three refused calls of one method within an hour write one entry.
  - `pluginLastCall()` returns the time of the last call for `crm`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.** Each handler: resolve the granted accounts with `grantedAccounts`, intersect with `accountId` when given, call the store read with that account filter, map to the answer shape. Cursors are opaque strings made by the handler; they carry position only. Add RU labels for the new log tools and actor.
- [ ] **Step 4: Run** `npm run check` — PASS. `npm run build`.
- [ ] **Step 5: Commit** `feat(mail): plugin API reads: accounts, messages, contacts, invitations`

### Task 5: The settings section "Plugin access"

**Files:**
- Create: `src/ui/settings/plugin-access-section.tsx`, `src/ui/settings/plugin-access-section.test.tsx`
- Modify: `src/ui/settings/sections.ts`, `src/ui/settings/sections.test.tsx`, `src/ui/settings/settings-body.tsx`, `src/ui/settings/shared.ts`, `app.tsx`, `app.test.tsx`, `src/ui/i18n/ru.ts`

**Interfaces:**
- Consumes: Task 3 owner methods; `SettingsSection`, `SettingsGroup`, `Switch` from the settings primitives.
- Produces:
  - Section id `"plugin_access"`, title `"Plugin access"`, description `"Which other plugins may read mail and what each may do."`, in the group "AI and agents" after `ai_access`.
  - `export type PluginAccessPort = { load: () => Promise<PluginAccessView>; setGrant: (pluginId: string, right: PluginRight, accountId: string, on: boolean) => Promise<SaveResult>; revoke: (pluginId: string) => Promise<SaveResult>; dismiss: (pluginId: string) => Promise<SaveResult> }` where `PluginAccessView` is the answer of `plugin_grants_list`.
  - `export function PluginAccessSection(props: { port: PluginAccessPort; accounts: { id: string; email: string; google: boolean }[]; onGoogleGrant?: (pluginId: string, right: PluginRight, accountId: string) => void })`.
  - Fixed copy (English keys): note `"This governs calls from other plugins' servers. A plugin's page runs with your own access, as everything you install in BB does."`; empty state `"No plugin has asked for access to mail."`; `"Requests"`, `"Plugins with access"`, `"Allow…"`, `"Dismiss"`, `"Revoke all"`, `"Last call: {date}"`, `"Never called"`; right labels `"Read mail"`, `"Read contacts"`, `"Read invitations"`, `"Propose letters"`, `"Google Calendar key"`, `"Google Contacts key"`; `"Needs Google sign-in"` for a `google.*` cell of a non-Google account.

- [ ] **Step 1: Write the failing tests:**
  - empty view → the note and the empty state, no table.
  - a request from `calendar` with reason `"Calendar sync"` shows id, reason and the asked rights; Dismiss calls `port.dismiss("calendar")` and the row goes.
  - Allow… opens that plugin's rights with the asked ones checked and **no call to `setGrant` yet**; saving calls `setGrant` once per checked cell.
  - a plugin with grants: a table of six rights by accounts, switches reflect the grants; turning one on calls `setGrant(…, true)`; a refused save restores the switch and shows the message in the block.
  - Revoke all asks to confirm, then calls `port.revoke`.
  - a plugin id `"<img src=x onerror=1>"` renders as that text and creates no `img` element (Review Focus 1).
  - a `google.calendar` switch on a non-Google account is disabled with "Needs Google sign-in"; on a Google account it calls `onGoogleGrant`, not `setGrant`.
  - in Russian no English sentence is left (render with the RU language and assert the note's Russian text).
  - `sections.test.tsx`: the group "AI and agents" lists `ai`, `ai_access`, `plugin_access`, `activity`; fifteen sections in total.
  - `app.test.tsx`: at `settings/plugin_access` the page calls `plugin_grants_list` and shows the section.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.** The table scrolls sideways inside its block under 480 px; switches keep BB's focus outline visible. The menu item shows the number of requests after its title when above zero.
- [ ] **Step 4: Run** `npm run check` — PASS. `npm run build`.
- [ ] **Step 5: Commit** `feat(mail): settings section Plugin access`

### Task 6: A plugin proposes a letter

**Files:**
- Modify: `src/core/plugin-api.ts`, `src/adapters/bb/plugin-api-rpc.ts` and its test, `src/core/ports.ts` and the store (`preparedBy` on `NewDraft` and `DraftRecord`), the composer component and the Drafts row in `src/ui`, their tests, `src/ui/i18n/ru.ts`

**Interfaces:**
- Consumes: `store.createDraft(input: NewDraft): DraftRecord`; Task 2 `PROPOSALS_PER_DAY`, `overDailyLimit`.
- Produces: `plugin_mail_propose` `{ accountId, to: string[] (1..50), cc?: string[], subject: string (≤ 998), text: string, inReplyTo?: messageId }` → `{ draftId }`; right `mail.propose`; `PROPOSE_LIMIT_MESSAGE = "Too many proposed letters today"`; `DraftRecord.preparedBy: string | null`.

- [ ] **Step 1: Write the failing tests:**
  - with the right: a draft exists in the account's Drafts with the given recipients, subject and text, `preparedBy === "calendar"`, and **the outbox is empty**; `notify` is called once.
  - without the right for that account → `forbidden` naming `mail.propose`; no draft.
  - `to: []`, an address without `@`, a text over the composer's size limit → `invalid`; no draft.
  - the 21st proposal within 24 hours → `PROPOSE_LIMIT_MESSAGE`.
  - `inReplyTo` of a message the plugin cannot read (other account, or filtered by AI access) → `not_found`.
  - UI: a draft with `preparedBy: "calendar"` opened in the composer shows `Prepared by calendar` above the fields, and the Drafts row shows the same mark; a draft without it shows neither. The plugin id is rendered as text.
  - saving the draft from the composer keeps `preparedBy`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.** The handler validates addresses with the composer's own address check, creates the draft through `createDraft`, logs `plugin_propose`. No code path from this handler reaches the outbox.
- [ ] **Step 4: Run** `npm run check` — PASS. `npm run build`.
- [ ] **Step 5: Commit** `feat(mail): a plugin proposes a letter as a marked draft`

### Task 7: Google keys

**Files:**
- Modify: `src/adapters/bb/google-tokens.ts` and its test, `src/adapters/bb/google-sign-in.ts` and its test, `src/core/google-oauth.ts` (scopes as a parameter where they are fixed), `src/core/plugin-api.ts`, `src/adapters/bb/plugin-api-rpc.ts` and its test, `src/core/ports.ts` and the store (granted scopes per account), `app.tsx` (the `onGoogleGrant` path), `src/ui/i18n/ru.ts`

**Interfaces:**
- Consumes: Task 2 `GOOGLE_RIGHT_SCOPE`; Task 5 `onGoogleGrant`; the existing Google sign-in flow (`google_sign_in_start`, `google_sign_in_status`).
- Produces:
  - `GoogleTokens.narrowToken(refreshToken: string, scope: string): Promise<{ accessToken: string; expiresAt: number; scope: string }>` — one refresh request with `scope` set; throws `SafeImapError("TokenUnavailable")` when the reply's scope is not exactly the asked one. Cached per (refresh token, scope) until 60 seconds before expiry; `forget(refreshToken)` drops these too.
  - `plugin_google_token` `{ accountId, right: "google.calendar" | "google.contacts" }` → `{ accessToken, expiresAt (ISO), scope }`; in `PLUGIN_API_METHODS`; `PLUGIN_METHOD_RIGHT.plugin_google_token = "google"` (the check takes the right from the input).
  - `google_sign_in_start` accepts `extraScopes?: string[]`, limited to the two scope URLs; the account stores the scopes Google returned (`google_scopes` column, JSON).
  - `plugin_grant_google` `{ pluginId, right, accountId, flowId }` (owner method): saves the grant only when the finished flow belongs to that account and its returned scopes include the right's scope.

- [ ] **Step 1: Verify with Google before writing code** (needs the owner at the browser, and their go-ahead): with the owner's Google account signed in with the calendar scope added, run one refresh with `scope=https://www.googleapis.com/auth/calendar` and check that (a) the reply's `scope` is that one scope, (b) `GET https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=1` with the token answers 200, (c) `GET https://gmail.googleapis.com/gmail/v1/users/me/profile` answers 403, (d) an IMAP XOAUTH2 login with it is refused. Record the four outcomes in the ledger without the token. **If (c) or (d) succeeds, stop this task and report to the owner; Tasks 1–6 stand on their own.**
- [ ] **Step 2: Write the failing tests:**
  - `narrowToken` sends `grant_type=refresh_token` and `scope=<the scope>` and returns the reply's token; a reply whose `scope` is `"https://mail.google.com/ https://www.googleapis.com/auth/calendar"` → throws, nothing cached.
  - a second call within the lifetime makes no request; after `forget` it does.
  - `plugin_google_token` with the grant returns `{ accessToken: "at-calendar-1", scope: "https://www.googleapis.com/auth/calendar" }`; without the grant → `forbidden` naming `google.calendar`; for an app-password account → `invalid`, `"This account does not sign in with Google"`; with `right: "mail.read"` → `invalid`.
  - the answer and every log line of the call hold no refresh token, and the log entry holds no access token (`JSON.stringify` of both does not contain `"at-calendar-1"` or the seeded refresh token literal).
  - revoking the grant drops the cached token: the next granted call after re-granting makes a new request.
  - `google_sign_in_start({ extraScopes: ["https://mail.google.com/x"] })` → `invalid`.
  - `plugin_grant_google` with a flow whose returned scopes lack the calendar scope → refused, `"Google did not grant this access"`, no grant saved; with a flow of another account → refused.
- [ ] **Step 3: Run** — FAIL.
- [ ] **Step 4: Implement.** In the settings section the `google.*` switch starts the sign-in with the extra scope (existing form flow, reused), then calls `plugin_grant_google`; turning it off is the ordinary `plugin_grant_set(…, false)`. Add the sentence under the Google rows: `"A key already handed out works for up to an hour after you revoke."`
- [ ] **Step 5: Run** `npm run check` — PASS. `npm run build`.
- [ ] **Step 6: Commit** `feat(mail): short-lived Google keys for plugins, narrowed to one service`

### Task 8: The contract document and the end-to-end check

**Files:**
- Create: `plugins/mail/docs/plugin-api.md`
- Modify: `PLUGIN_OVERVIEW.md`, `README.md`, `package.json` `bb.description` and the `marketplace.json` entry only if they state who can read mail

- [ ] **Step 1: Write `docs/plugin-api.md`:** how to call (`bb.sdk.plugins.callRpc({ pluginId: "makosh-mail", method, input })` from the plugin's server), the version rule, each method with input, answer, right and limits as in Tasks 3, 4, 6, 7, the refusal codes and messages, what the owner sees, and the note that page-side calls are not governed. Examples use `example.com` only.
- [ ] **Step 2:** Add one line on plugin access to `PLUGIN_OVERVIEW.md` within its 4000-character limit and a short section to `README.md`. Run `node ../../scripts/check-manifests.mjs` — `manifests ok`.
- [ ] **Step 3:** `npm run check` and `npm run build` — PASS.
- [ ] **Step 4: Commit** `docs(mail): the plugin API for other plugins' authors`
- [ ] **Step 5: End-to-end, after the owner's go-ahead** (it updates the live worktree, reloads Mail once and installs a throwaway plugin): a plugin in `$TMPDIR` whose server calls `threads_list` (expect `forbidden`), `plugin_access_info`, `plugin_access_request`, then, after the owner allows `mail.read` for one account in settings, `plugin_accounts_list` and `plugin_messages_search` (expect only that account). Check the activity log shows the calls. Remove the throwaway plugin. Then the settings section in a browser at 480, 768 and 1280 px, dark and light, Russian and English.
