# Mail: Split Inbox — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tabs over the Inbox, each a search condition applied to Inbox conversations, with unread counts, a library of ready tabs and an address per tab.

**Architecture:** The search language gains six operators that the library needs. A tab is a row (name, query, position); the store turns a tab's parsed conditions into one more membership condition of the existing conversation list and counts unread conversations per tab. The page shows a tab row above the list and keeps the tab in the route.

**Tech Stack:** TypeScript, zod, vitest, better-sqlite3, React with BB's vendored components.

**Spec:** `docs/superpowers/specs/2026-11-19-mail-split-inbox-design.md`

## Global Constraints

- All paths are under `plugins/mail`. `npm run check` after every task, `npm run build` before a task is done, `node ../../scripts/check-manifests.mjs` after touching `PLUGIN_OVERVIEW.md` (at 4000 of 4000 characters: shorten before adding).
- `src/core` and `src/ui` import no `node:*` or `@get-bb/*`.
- Fixtures use `example.com`, `example.net`, `example.org` only.
- Every string shown to the owner goes through `tx()`/`txn()`/`msg()` with a Russian line in `src/ui/i18n/ru.ts` (unicode-escaped, before the `"Try the saved password":` line).
- New RPC method lists join every "later" filter of the positional contract tests.
- The Inbox timing tests (`listThreads … stays fast`) must pass alone; a tab adds nothing to the query when no tab is asked for.
- No push, no reload of the owner's BB without their go-ahead. Commits touch `plugins/mail` and `docs`; messages end with `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>`.

Exact values from the spec: at most 12 tabs; name 1–40 characters; query 1–500; keys `]` next and `[` previous; address suffix `/s/<tabId>`; operators `from:vip`, `from:team`, `from:known`, `is:dev`, `is:automated`, `has:invite`.

## Review Focus

1. A tab whose condition names something that no longer exists (a removed category, an emptied VIP list): the tab is empty, nothing throws.
2. A condition with free text or an unknown operator: refused on save with the reason, never stored.
3. The tab in the address was deleted in another window: the Inbox tab opens.
4. A conversation with one Inbox message matching and another not: it is in the tab, shown whole.
5. Twelve tabs at 480 px: the row scrolls, the list keeps its height.

---

### Task 1: Six operators in the search language

**Files:** Modify `src/core/model.ts` (`searchFieldSchema` adds `"sender"`), `src/core/search.ts`, `src/core/search.test.ts`, `src/adapters/bb/sqlite-store.ts` (`conditionSql`, a `mail_sender_set` SQL function, `setSenderSets`), `src/core/testing/fakes.ts` (`matchesConditions`, `setSenderSets`), `src/core/ports.ts`, `src/adapters/bb/sqlite-store.test.ts`, `server.ts` (install the sets at start and when the setting or the accounts change).

**Interfaces — Produces:**
- Parser: `from:vip|team|known` (exact word, any case) → `{ field: "sender", value: "vip"|"team"|"known" }`; `is:dev` → `{ field: "is", value: "dev" }`; `is:automated` → `{ field: "is", value: "automated" }`; `has:invite` → `{ field: "has", value: "invite" }`. Any other `from:` value stays an ordinary `from`.
- `export type SenderSets = { vip: { addresses: ReadonlySet<string>; domains: ReadonlySet<string> }; team: ReadonlySet<string> }` in `src/core/inbox-tabs.ts`; `MailStore.setSenderSets(sets: SenderSets): void`. `known` needs no set: an address the owner has sent to.
- `export function teamDomains(ownAddresses: readonly string[]): Set<string>` — the domains of the owner's addresses without public mail domains (`isPublicMailDomain` of `blocking.ts`).

- [ ] **Step 1: failing tests.** Parser: each of the six operators and its negation; `from:vipclient@example.com` stays `from`; `is:devops` is a `bad_value` note. Store (both store kinds): messages from a VIP address, a VIP domain, the owner's company domain, a public domain, an address the owner wrote to, a dev notification, a no-reply sender, one with a calendar part; `search` with each operator returns exactly the expected ones; with empty sets `from:vip` and `from:team` return nothing.
- [ ] **Step 2: run** `npx vitest run src/core/search.test.ts src/adapters/bb/sqlite-store.test.ts -t "operator"` — FAIL.
- [ ] **Step 3: implement.** `is:automated` is a sender `isAutomatedAddress` accepts, or a bulk message without a list id. `has:invite` is an attachment of kind `calendar`. `from:known` compares the lower-cased From address with the recipients of Sent mail.
- [ ] **Step 4: run** `npm run check` — PASS.
- [ ] **Step 5: commit** `feat(mail): search operators from:vip, from:team, from:known, is:dev, is:automated, has:invite`

### Task 2: Tabs in the core and the store

**Files:** Create `src/core/inbox-tabs.ts`, `src/core/inbox-tabs.test.ts`. Modify `src/core/ports.ts`, `src/adapters/bb/sqlite-store.ts` (migration element 21, CRUD, `listThreads`/`listThreadsAll` take a tab, `tabUnreadCounts`), `src/core/testing/fakes.ts`, `src/adapters/bb/sqlite-store.test.ts`.

**Interfaces — Produces:**
- `export const TABS_MAX = 12; TAB_NAME_MAX = 40; TAB_QUERY_MAX = 500; OTHER_QUERY = "is:other"` (a reserved condition, valid only as a whole query).
- `export type InboxTab = { id: string; name: string; query: string; position: number }`.
- `export type TabMatch = { kind: "all"; conditions: SearchCondition[] } | { kind: "none"; of: SearchCondition[][] }`.
- `export function tabConditions(query: string, now: Date): { ok: true; conditions: SearchCondition[] } | { ok: false; reason: "empty" | "free_text" | "unknown_operator" | "bad_value" | "too_long" }`.
- `export function tabMatch(tab: InboxTab, all: readonly InboxTab[], now: Date): TabMatch | null` — `none` over the other tabs for `OTHER_QUERY`; null when the tab's query no longer parses.
- `export const TAB_LIBRARY: readonly { id: string; name: string; query: string }[]` with the spec's table (VIP `from:vip`, Team `from:team`, People `from:known`, Dev `is:dev`, Newsletters `category:newsletters`, Notifications `is:automated`, Calendar `has:invite`, Attachments `has:attachment`, Other `is:other`, and the nine tools by `from:` domain).
- `MailStore`: `listInboxTabs(): InboxTab[]`, `saveInboxTab(tab: { id: string; name: string; query: string }, nowIso: string): InboxTab` (new at the end; throws `TabsFullError` over 12), `deleteInboxTab(id: string): void`, `moveInboxTab(id: string, direction: -1 | 1): void`, `tabUnreadCounts(scope: { accountId: string; folder: string } | { role: SpecialUse }, matches: readonly (TabMatch | null)[]): number[]`; `listThreads(…, filter?, tab?: TabMatch)` and `listThreadsAll(…, filter?, tab?: TabMatch)`.

- [ ] **Step 1: failing tests.** Core: `tabConditions("from:vip has:attachment")` ok with two conditions; `"hello"` → `free_text`; `"foo:bar"` → `unknown_operator`; `""` → `empty`; 501 characters → `too_long`; `tabMatch` for Other returns `none` of the other tabs' conditions and skips a tab that no longer parses; the library's queries all parse. Store (SQLite; the fake where it has the rows): a conversation with one matching Inbox message is in the tab and listed whole; one matching only outside the Inbox is not; Other holds exactly the conversations in no tab; a tab over a removed category is empty; counts are unread conversations per tab and 0 for a null match; the thirteenth tab throws; move swaps neighbours and stops at the ends; `listThreads` without a tab returns what it returned before.
- [ ] **Step 2: run** — FAIL.
- [ ] **Step 3: implement.** The tab's conditions are AND parts of the membership subquery over alias `m` (positional parameters of `conditionsSql` rewritten to named ones); `none` is `threads.id NOT IN (…any of the others…)`.
- [ ] **Step 4: run** `npm run check` — PASS, and the three Inbox timing tests alone.
- [ ] **Step 5: commit** `feat(mail): Inbox tabs in the store`

### Task 3: Methods

**Files:** Modify `src/core/contract.ts`, `src/core/contract.test.ts`, `server.ts`, `server.test.ts`.

**Interfaces — Produces:** `inbox_tabs_list { scope }` → `{ tabs: { id, name, query, unread, broken: boolean }[] }`; `inbox_tab_save { id?: string, name, query }` → `{ tab }` (refusals: `"A tab needs a condition"`, `"A tab's condition uses search operators only"`, `"Unknown operator in the condition"`, `"A value in the condition is not valid"`, `"You have the most tabs Mail keeps (12)"`); `inbox_tab_delete { id }`; `inbox_tab_move { id, direction: "left" | "right" }`; `threads_list` input gains `tabId?: string` (an unknown id lists the whole Inbox). `INBOX_TAB_METHODS` in the contract.

- [ ] **Step 1: failing tests** in `server.test.ts`: save, list with counts, the listed conversations of a tab, each refusal, an unknown `tabId`, a plugin caller refused on all four.
- [ ] **Step 2–4:** run RED, implement, `npm run check` GREEN.
- [ ] **Step 5: commit** `feat(mail): methods for Inbox tabs`

### Task 4: The tab row

**Files:** Create `src/ui/inbox-tabs.tsx`, `src/ui/inbox-tabs.test.tsx`. Modify `src/ui/routes.ts` and its test (`MailView` gains `tabId`), `app.tsx`, `app.test.tsx`, the message menu and the search bar for "Split by this sender" and "Make a tab", the keys table, `src/ui/i18n/ru.ts`.

**Interfaces — Produces:** `InboxTabs({ tabs, currentId, onSelect, onAdd, onRename, onEdit, onMove, onRemove, library })`; route `v/all/inbox/s/<tabId>` and `v/<accountId>/<folder>/s/<tabId>`.

- [ ] **Step 1: failing tests.** Routes round-trip with and without a tab. Component: no row without tabs; the Inbox tab first; counts, none for zero; `aria-selected` on the tab in view; the library lists what is not added yet; a refused condition says why in the editor; a broken tab is marked and still removable; the name is rendered as text. App: opening `v/all/inbox/s/<id>` asks `threads_list` with that `tabId`; `]` and `[` walk the tabs and navigate; a deleted tab in the address shows the Inbox tab.
- [ ] **Step 2–4:** RED, implement (the row scrolls sideways; focus outline visible), GREEN.
- [ ] **Step 5: commit** `feat(mail): Split Inbox tabs over the Inbox`

### Task 5: Settings, documents, checks

**Files:** Modify `src/ui/settings/inbox-section.tsx` and its test, `README.md`, `PLUGIN_OVERVIEW.md`, `CHANGELOG.md`.

- [ ] **Step 1: failing test:** the Inbox section lists the tabs with rename, condition, order, remove and the library.
- [ ] **Step 2–3:** implement; README section "Split Inbox"; one overview line within the limit.
- [ ] **Step 4:** `npm run check`, `npm run build`, manifests — PASS.
- [ ] **Step 5: commit** `feat(mail): Inbox tabs in settings; docs`
- [ ] **Step 6, after the owner's go-ahead:** the live BB at 480, 768 and 1280 px, dark and light, Russian and English.
