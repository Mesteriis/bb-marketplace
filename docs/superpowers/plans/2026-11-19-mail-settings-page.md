# Makosh Mail Settings Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mail settings become a page inside Mail with a grouped side menu, and every setting that is safe to change from the page is changed there.

**Architecture:** A `settings` page joins Mail's existing page mechanism (`src/ui/routes.ts`, the `page` slot of `MailPage`). The 1 100-line dialog file is split into a shell, section data, three layout primitives and one file per section under `src/ui/settings/`. Two owner-only RPC methods read and write an allowlisted subset of the plugin's BB settings.

**Tech Stack:** React, TypeScript, Tailwind with BB's vendored `@/components/ui`, vitest + Testing Library, zod.

**Spec:** `docs/superpowers/specs/2026-11-19-mail-settings-page-design.md` (approved 2026-11-19; the agent switches stay read-only).

## Global Constraints

- Run commands from `plugins/mail`. `npm run check` after every task; `npm run build` before the last commit.
- `src/core` and `src/ui` import no `node:*`, `@get-bb/*`, Electron or Tauri.
- Only BB's vendored components and theme tokens; no raw hex, no pixel values outside Tailwind's scale.
- Every page text through `tx()` with a line in `src/ui/i18n/ru.ts`. No English sentence on the page in Russian.
- BB's page-wide `:focus-visible` outline: keep it fully visible or switch it off inline (`style={{ outlineStyle: "none" }}`) with another focus indication; never clip it.
- `settings_set` never accepts `vaultKey`, `agentTools`, `agentPropose` or `agentTriage`; `settings_get` never returns `vaultKey`.
- Groups and sections, their order and names: exactly the table "Information architecture" of the spec.
- Menu 208 px (`w-52`), content up to 672 px (`max-w-2xl`); under 640 px container width (`@2xl`) the menu is a `Select`.
- A moved section behaves as before: its existing tests move with it and pass unchanged except for imports and the container they render in.
- Do not push, tag or reload the owner's BB. Commit only `plugins/mail` and the documents of the task.

## Review Focus

1. A settings link with an unknown section (`settings/nope`) or with the old dialog's section ids opens a section, never a blank page.
2. A refused `settings_set` (out of range, BB refuses the write): the control returns to the saved value and the row says why; nothing else on the page changes.
3. Two controls changed quickly: the second write is not lost and the first's "Saved" does not hide a failure of the second.
4. No account, no vault key, or Makosh AI missing: every section still renders, with its empty or explanatory state.
5. The page at 480 px: no horizontal scroll, no control outside its row, the section `Select` reaches every section.

---

### Task 1: The page, its address and its menu

**Files:**
- Create: `src/ui/settings/sections.ts`, `src/ui/settings/settings-page.tsx`, `src/ui/settings/settings-page.test.tsx`
- Modify: `src/ui/routes.ts`, `src/ui/routes.test.ts`, `src/ui/mail-page.tsx` (page frame width), `app.tsx`, `app.test.tsx`, `src/ui/mail-sidebar.tsx` if the gear lives there, `src/ui/i18n/ru.ts`

**Interfaces:**
- Produces:
  - `type SettingsSectionId = "accounts" | "addresses" | "inbox" | "filters" | "subscriptions" | "templates" | "reading" | "ai" | "ai_access" | "activity" | "bb" | "rules" | "pgp" | "local"`
  - `SETTINGS_GROUPS: readonly { id: "accounts" | "mail" | "ai" | "bb" | "security"; title: string; sections: readonly { id: SettingsSectionId; title: string }[] }[]` (titles are `tx` keys)
  - `settingsSubPath(section?: SettingsSectionId): string` → `"settings"` or `"settings/<id>"`; `parseSettingsSubPath(subPath: string): SettingsSectionId | null` (null: not a settings path; an unknown or missing section → `"accounts"`; the old ids `search` → `reading`)
  - `MailPageName` gains `"settings"`; `parsePageSubPath("settings/ai")` → `"settings"`
  - `SettingsPage(props: MailSettingsProps & { section: SettingsSectionId; onSection: (id: SettingsSectionId) => void; onBack: () => void; available: ReadonlySet<SettingsSectionId> })`

- [ ] **Step 1: Failing tests.** Routes: `settingsSubPath("ai")` is `"settings/ai"`; `parseSettingsSubPath("settings")` and `("settings/nope")` are `"accounts"`; `("settings/search")` is `"reading"`; `("today")` is `null`. Page: the menu is a `navigation` named "Settings" with five group labels and the sections of the spec's table in order; the open one has `aria-current="page"`; a section missing from `available` is not listed; clicking an item calls `onSection`; "Mail" calls `onBack`. App: the sidebar's settings control navigates to `settings`, "Manage templates" to `settings/templates`, and no `dialog` named "Mail settings" exists.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.** In this task the page's content area renders the existing section components from `mail-settings.tsx` unchanged (export them); `accounts` and `local` render a one-line placeholder that Task 4 replaces. The `page` slot gets a `wide` flag for the settings frame. Remove the `Dialog` wrapper and the tab bar; `openSettings(section)` becomes navigation.
- [ ] **Step 4: Run** `npm run check` — PASS.
- [ ] **Step 5: Commit** `feat(mail): settings open as a page with a grouped menu`.

### Task 2: Layout primitives and one file per section

**Files:**
- Create: `src/ui/settings/primitives.tsx`, `src/ui/settings/primitives.test.tsx`, `src/ui/settings/addresses-section.tsx`, `inbox-section.tsx`, `templates-section.tsx`, `ai-features-section.tsx`, `reading-section.tsx`
- Move (with their tests): `ai-access-settings.tsx`, `agent-activity.tsx`, `bb-integration-settings.tsx`, `rules-settings.tsx`, `filters-settings.tsx`, `subscriptions-settings.tsx`, `pgp-settings.tsx`, `translation-settings.tsx` → `src/ui/settings/`
- Delete: `src/ui/mail-settings.tsx` (its tests move to the section files they cover)

**Interfaces:**
- Produces: `SettingsSection({ title, description?, children })`, `SettingRow({ label, hint?, control, problem? })`, `SettingsGroup({ title, action?, children })`; `type MailSettingsProps` moves to `settings-page.tsx`; `docPreview`, `sendCheckText`, `attachmentTextLine` move with their sections.

- [ ] **Step 1: Failing tests** for the primitives: `SettingsSection` renders an `h2` and the description; `SettingRow` ties its label to the control (`getByLabelText`) and shows `problem` with `role="alert"`; `SettingsGroup` renders its action in the title row.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement the primitives, then move the code.** No behaviour change: each section's root becomes `SettingsSection`, list blocks become `SettingsGroup`. Run the moved tests after each file.
- [ ] **Step 4: Run** `npm run check` — PASS; `git grep -n "mail-settings" plugins/mail/src plugins/mail/app.tsx` prints nothing.
- [ ] **Step 5: Commit** `refactor(mail): settings sections in files of their own on shared primitives`.

### Task 3: Reading and writing settings from the page

**Files:**
- Create: `src/core/page-settings.ts`, `src/core/page-settings.test.ts`
- Modify: `src/core/contract.ts`, `src/core/contract.test.ts`, `server.ts` (`defineSettings` takes its bounds from the core module), `server.test.ts`

**Interfaces:**
- Produces:
  - `pageSettingsSchema` (zod): every key of `defineSettings` except `vaultKey`, with the same types, options and bounds
  - `PAGE_SETTINGS_READ_ONLY = ["agentTools", "agentPropose", "agentTriage"] as const`
  - `pageSettingsPatchSchema`: a strict partial of `pageSettingsSchema` without the read-only keys; at least one key
  - RPC `settings_get: { input: {}, output: pageSettingsSchema }`, `settings_set: { input: pageSettingsPatchSchema, output: pageSettingsSchema }`; `SETTINGS_METHODS = ["settings_get", "settings_set"]`, added to the "later" lists of `contract.test.ts`

- [ ] **Step 1: Failing tests.** Core: a patch `{ syncIntervalMinutes: 15 }` parses; `{ agentTools: true }`, `{ vaultKey: "x" }`, `{}`, `{ syncIntervalMinutes: 0 }`, `{ unknownKey: 1 }` and a wrong select option do not. Server: `settings_get` has no `vaultKey`; `settings_set({ hideQuotes: false })` returns the new values and a second `settings_get` agrees; both refuse a plugin caller; `settings_set({ agentPropose: true })` is refused as invalid and the setting is unchanged; a change of `syncIntervalMinutes` reschedules the loop (the existing settings-change path runs).
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.** One source for bounds: `defineSettings` builds its definitions from the core module, so the page and BB's own settings page cannot disagree.
- [ ] **Step 4: Run** `npm run check` — PASS.
- [ ] **Step 5: Commit** `feat(mail): settings_get and settings_set for the settings page`.

### Task 4: The settings port and a saving row

**Files:**
- Create: `src/ui/settings/use-page-settings.ts`, `src/ui/settings/setting-controls.tsx`, `src/ui/settings/setting-controls.test.tsx`
- Modify: `app.tsx` (the port), `src/ui/settings/settings-page.tsx`

**Interfaces:**
- Consumes: the two RPC methods (Task 3), `SettingRow` (Task 2).
- Produces:
  - `type PageSettingsPort = { values: PageSettings | null; save: (patch: PageSettingsPatch) => Promise<{ ok: true } | { ok: false; message: string }> }`
  - `SwitchSetting`, `SelectSetting`, `NumberSetting`, `TextSetting` — each `({ port, name, label, hint?, ... })`, saving on change through one queue
  - `ReadOnlySetting({ label, hint, on, onOpenBbSettings })` for the three agent switches

- [ ] **Step 1: Failing tests.** A switch shows the port's value, calls `save({ hideQuotes: false })` on click and shows "Saved"; a refused save puts the switch back and shows the message with `role="alert"` (Review Focus 2); two changes in a row send two saves in order and a failure of the second is shown even after the first's "Saved" (Focus 3); a number field saves on blur and Enter, not on each keystroke, and refuses to send an empty value; `values: null` renders the rows disabled with "Loading…".
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run check` — PASS.
- [ ] **Step 5: Commit** `feat(mail): setting rows that save on change`.

### Task 5: New sections — Mailboxes and sign-in, Local data

**Files:**
- Create: `src/ui/settings/accounts-section.tsx`, `local-data-section.tsx`, their tests
- Modify: `src/ui/settings/addresses-section.tsx` (the sign-in link and "SMTP settings…" leave it), `settings-page.tsx`

**Interfaces:**
- Consumes: `Account.authKind`, `onGoogleSwitch`, `onOpenSmtp`, `onOpenAccountForm`, `PageSettingsPort`.

- [ ] **Step 1: Failing tests.** Accounts: each account is a row with its address, provider label, "App password" or "Signed in with Google", and its state (the problem sentence when stopped); a password Gmail account offers "Switch to Google sign-in" only when the handler is given; every password account offers "Replace app password"; a Google account stopped by a revoked grant offers "Sign in to Google"; "SMTP settings…" and "Add an account" call their handlers; the sync interval, sync window and instant mail rows save through the port; removing an account shows the command `bb makosh-mail accounts remove <id>` with a Copy button (check the real command name in `server.ts` first). No account: "No mail account yet." and "Add an account". Local data: says mail and keys stay on this computer, shows "The credential key is set" or the vault-key problem, and the `doctor` and `backup` commands with Copy.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run check` — PASS.
- [ ] **Step 5: Commit** `feat(mail): Mailboxes and sign-in, and Local data, in settings`.

### Task 6: Controls in the existing sections

**Files:**
- Modify: `src/ui/settings/ai-features-section.tsx`, `ai-access-settings.tsx`, `inbox-section.tsx`, `reading-section.tsx`, `bb-integration-settings.tsx`, `rules-settings.tsx`, their tests

Per section, the keys that become rows (labels from the spec's table; the rest of each section stays):

| Section | Keys |
|---|---|
| AI features | `mailCategories`, `morningDigest`, `digestTime`, `replyReminderDays`, `translateLanguage`; the provider and model form below |
| Agent access | `agentTools`, `agentPropose`, `agentTriage` as `ReadOnlySetting` |
| Inbox | `notifyNewMail`, `notifyImportantOnly`, `importantSenders`, `quietHours` |
| Reading and search | `mailView`, `darkMail`, `hideQuotes`, `cleanLinks`, `listDensity`, `readingPane`, `language`, `historyStepDays`, `serverSearchKeepDays`, `indexAttachmentText` |
| Integration | `attachmentFolder`, `patchFolder`, `taskTarget`, `devNotifications` |
| Rules | `mailRules` |

- [ ] **Step 1: Failing tests,** one per section: the listed keys render as controls with the port's values; changing one calls `save` with that key; the sentence "Change it in BB Settings" appears only in Agent access. Review Focus 4: each section rendered with no accounts, with `values: null`, and (AI features) with Makosh AI missing.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.** Changing `language` re-renders the page in the new language without a reload (the existing language path).
- [ ] **Step 4: Run** `npm run check` — PASS.
- [ ] **Step 5: Commit** `feat(mail): settings change on the page instead of BB's plugin settings`.

### Task 7: Content pass and narrow layout

**Files:**
- Modify: every file in `src/ui/settings/`, `src/ui/i18n/ru.ts`, `src/ui/i18n/i18n.test.ts` if it lists exceptions

- [ ] **Step 1: Failing tests.** With Russian selected, render every section and assert the text contains none of `Off.`, `Change it in`, ` days`, ` day.`; `replyReminderDays` of 1, 3 and 5 reads "через 1 день", "через 3 дня", "через 5 дней". At a 480 px container the menu is absent and a `combobox` named "Section" lists all sections in their groups (Review Focus 5); choosing one calls `onSection`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.** One description sentence per section; status sentences become a label with a control or a badge; plural-aware messages for units.
- [ ] **Step 4: Run** `npm run check` — PASS.
- [ ] **Step 5: Commit** `feat(mail): settings content in one voice, and the narrow layout`.

### Task 8: Documents and the rendered check

**Files:**
- Modify: `README.md`, `CHANGELOG.md`, `PLUGIN_OVERVIEW.md` (within its 4 000-character limit)

- [ ] **Step 1: Update the texts**: settings are a page; which settings change there; the three agent switches change in BB's plugin settings.
- [ ] **Step 2: Run** `npm run check`, `npm run build`, `node ../../scripts/check-manifests.mjs` — PASS.
- [ ] **Step 3: Commit** `docs(mail): the settings page`.
- [ ] **Step 4: After the owner's go-ahead to reload the live plugin once:** open the page in BB's browser at 480, 768 and 1280 px, dark and light, Russian and English; open every section and every overlay it has (selects, the signature editor, confirm dialogs: placement, focus, Escape); screenshot each section and the Today page at the same width as the sibling; list what differs from the spec. Fix what is wrong, in order: geometry, typography, colours.
