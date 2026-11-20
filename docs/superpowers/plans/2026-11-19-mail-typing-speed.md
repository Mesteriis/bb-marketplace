# Mail: typing speed — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Snippets that fill more than the body, autocorrect, autocomplete from the owner's own phrases, a reply that quotes the selection, and a one-key answer to an introduction.

**Architecture:** The rules are pure functions in `src/core` (autocorrect, phrases, snippet variables, the introduction check). Thin ProseMirror plugins in `src/ui/editor-typing.ts` call them inside the existing TipTap editor. Templates gain fields and files in the store; the server computes the owner's phrases from Sent mail and serves them by one read-only method.

**Tech Stack:** TypeScript, zod, vitest, better-sqlite3, React, TipTap/ProseMirror.

**Spec:** `docs/superpowers/specs/2026-11-19-mail-typing-speed-design.md`

## Global Constraints

- All paths are under `plugins/mail`. `npm run check` after every task, `npm run build` before a task is done, `node ../../scripts/check-manifests.mjs` after touching `package.json`, `PLUGIN_OVERVIEW.md` (near its 4000-character limit: shorten before adding).
- `src/core` and `src/ui` import no `node:*` or `@get-bb/*`.
- Fixtures use `example.com`, `example.net`, `example.org` only; no real mail text.
- Every string shown to the owner goes through `tx()`/`txn()`/`msg()` with a Russian line in `src/ui/i18n/ru.ts` (unicode-escaped, before the `"Try the saved password":` line).
- New RPC method lists join every "later" filter of the positional contract tests; another plugin is refused on every new method; `phrases_list` is owner-only and its result is never logged.
- No push, no reload of the owner's BB inside this plan. Commits touch `plugins/mail` and `docs`; messages end with `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>`.

Exact values from the spec: template subject 1–200; recipients at most 20 in all; files at most 5 and 10 MB together; quote at most 20 000 characters; phrases of 3–12 words, at least 3 occurrences, at most 500, from the newest 2 000 sent messages, rebuilt at most once in 10 minutes; the grey text needs 2 words and 8 characters; owner's replacements at most 200; trigger `;`; intro key Mod+Shift+I; thank-you line `Thank you, {first name}! (Moving you to Bcc.)`.

## Review Focus

1. Autocorrect inside a code block, a link, an address or a word the owner restored: nothing is changed.
2. Backspace right after a fix restores exactly what was typed, cursor after it; a second Backspace deletes as usual.
3. A phrase that came from someone else's quoted text or from a signature is never offered; phrases never reach an agent, a plugin or the log.
4. A template whose files do not fit the draft: the body and recipients are inserted, the note names the files left out, nothing is half-attached.
5. A selection that spans two messages, or is empty after trimming: an ordinary reply.

---

### Task 1: Autocorrect rules and the editor plugin

**Files:** Create `src/core/autocorrect.ts`, `src/core/autocorrect.test.ts`, `src/ui/editor-typing.ts`, `src/ui/editor-typing.test.ts`. Modify `src/ui/compose-editor.tsx` (extensions take the typing features), `src/ui/composer.tsx` (passes the settings), `package.json` (settings `autocorrect`, `autocorrectPairs`), the settings page's Templates section, `src/ui/i18n/ru.ts`.

**Interfaces — Produces:**
- `export type Correction = { from: string; to: string }`.
- `export function parsePairs(text: string): Correction[]` — lines `from => to`, at most 200, blank and malformed lines skipped.
- `export function correctWord(word: string, context: { sentenceStart: boolean; pairs: readonly Correction[]; skip: ReadonlySet<string> }): string | null` — the fixed word or null. Order: owner's pairs, built-in misspellings (case of the first letter kept), `i` → `I`, two capitals, sentence start.
- `export function autocorrectPlugin(options: () => { on: boolean; pairs: readonly Correction[] }): Plugin` and `typingExtension(...)` in `editor-typing.ts`.

- [ ] **Step 1: failing tests.** Core table: `teh`→`the`, `Teh`→`The`, `recieve`→`receive`, `i`→`I`, `THe`→`The`, `hello` at a sentence start → `Hello`, `привет` at a sentence start → `Привет`, `сдесь`→`здесь`, an owner's pair `brb => be right back`, `iOS`/`eBay`/`USA`/`don't` unchanged, a word in `skip` unchanged, `parsePairs` with 201 lines keeps 200. Editor: typing `teh ` gives `the `; Backspace next gives `teh ` and typing on does not fix it again; inside a code block and inside a link nothing changes; with the setting off nothing changes.
- [ ] **Step 2: run** — FAIL.
- [ ] **Step 3: implement.**
- [ ] **Step 4:** `npm run check` — PASS.
- [ ] **Step 5: commit** `feat(mail): autocorrect in the composer`

### Task 2: Phrases and the grey text

**Files:** Create `src/core/phrases.ts`, `src/core/phrases.test.ts`. Modify `src/core/ports.ts` and both stores (`sentTexts(limit)`), `src/core/contract.ts` (`phrases_list`), `server.ts`, `server.test.ts`, `src/ui/editor-typing.ts` and its test, `src/ui/composer.tsx`, `app.tsx`, `package.json` (setting `autocomplete`).

**Interfaces — Produces:**
- `export function ownText(body: string): string` — the text above the first quoted line (`>`), "On … wrote:" line, forwarded header or `-- ` signature mark.
- `export function buildPhrases(texts: readonly string[], templates: readonly string[], limits?): string[]`.
- `export function completion(phrases: readonly string[], sentence: string): string | null` — the rest of the first phrase the sentence begins (case ignored), null under 2 words or 8 characters or when nothing is left.
- `MailStore.sentTexts(limit: number): string[]` — bodies of the newest sent messages, newest first.
- `phrases_list {}` → `{ phrases: string[] }`; `PHRASE_METHODS`.
- `ghostPlugin(options: () => { on: boolean; phrases: readonly string[] })`.

- [ ] **Step 1: failing tests.** Core: a phrase used 3 times is kept and one used twice is not; quoted lines and text under `-- ` never make a phrase; a template counts as 3; at most 500; `completion(["Let me know if you have any questions"], "Let me know if")` → ` you have any questions`; one word or 7 characters → null; the whole phrase typed → null. Server: `phrases_list` from seeded Sent mail; a plugin caller refused; the phrases absent from the plugin log. Editor: the grey text shows after `Let me know if`, Tab inserts it, Escape hides it, another key keeps typing, Tab without a suggestion is not taken.
- [ ] **Step 2–4:** RED, implement, `npm run check` GREEN.
- [ ] **Step 5: commit** `feat(mail): autocomplete from the owner's own phrases`

### Task 3: Snippets — what a template carries

**Files:** Create `src/core/snippets.ts`, `src/core/snippets.test.ts`. Modify `src/core/ports.ts`, both stores (migration: template columns, `template_files`), `src/core/contract.ts` (`templates_list`, `template_save`, `template_file_begin/chunk/finish/remove`, `template_apply`), `server.ts`, `server.test.ts`, `src/ui/settings/templates-section.tsx` and its test, `src/ui/composer.tsx` (insert applies everything), the pre-send check (a `{first_name}` left in), `src/ui/i18n/ru.ts`.

**Interfaces — Produces:**
- `export function firstNameOf(recipient: { name: string | null; address: string } | undefined): string | null`.
- `export function fillVariables(text: string, firstName: string | null): string` — replaces `{first_name}` when a name is known.
- `template_apply { draftId, templateId }` → `{ attached: string[]; leftOut: string[] }`.

- [ ] **Step 1: failing tests.** Core: `firstNameOf` for `"Ada Lovelace"`, `ada.lovelace@example.com`, undefined; variables with and without a name. Store: a template round-trips subject, recipients and files; deleting a template deletes its files; limits (6th file, over 10 MB, 21 recipients) refused. Server: `template_apply` attaches files and reports one that does not fit; a plugin caller refused on each new method. UI: the form edits the fields; inserting fills an empty subject, keeps a typed one, adds recipients once, shows the left-out note.
- [ ] **Step 2–4:** RED, implement, GREEN.
- [ ] **Step 5: commit** `feat(mail): templates carry a subject, recipients and files`

### Task 4: The `;` trigger

**Files:** Modify `src/ui/editor-typing.ts` and its test, `src/ui/templates-popover.tsx` and its test, `src/ui/composer.tsx`.

- [ ] **Step 1: failing tests.** `;` at a word's start opens the list at the cursor with the typed letters as the filter; Enter inserts and removes `;text`; Escape closes and keeps the text; `;` inside a word (`a;b`) opens nothing; a space with no match closes it.
- [ ] **Step 2–4:** RED, implement, GREEN.
- [ ] **Step 5: commit** `feat(mail): pick a template with ; in the body`

### Task 5: Quick quote and instant intro

**Files:** Create `src/core/intro.ts`, `src/core/intro.test.ts`. Modify `src/core/contract.ts` (`compose_prepare.quote`), the reply preparation in the core and `server.ts`, `server.test.ts`, `src/ui/mail-page.tsx` / `src/ui/reading-pane.tsx` (the selection of one message), `src/ui/composer.tsx` (the command and the offer), `src/ui/shortcuts.ts` if the key lives there, `src/ui/i18n/ru.ts`.

**Interfaces — Produces:**
- `export function looksLikeIntro(message: { subject: string; text: string; to: number; cc: number }): boolean`.
- `export function introLine(firstName: string | null): string` (a tx key with `{p1}`).
- `export function moveSenderToBcc(draft: { to: string[]; cc: string[]; bcc: string[] }, sender: string): { to: string[]; cc: string[]; bcc: string[] } | null` — null when the sender is not in To or nobody else remains.

- [ ] **Step 1: failing tests.** Core: intro words in English and Russian, a plain reply is not an intro; the move with and without other recipients, case-insensitive address, twice is a no-op. Server: a reply with `quote` quotes exactly that text under the "wrote" line; 20 001 characters refused; without `quote` the reply is as before. UI: a selection inside one message makes Reply send the quote, a selection across two messages does not; the command moves the sender and adds the line once.
- [ ] **Step 2–4:** RED, implement, GREEN.
- [ ] **Step 5: commit** `feat(mail): reply with the selection quoted; move the introducer to Bcc`

### Task 6: Documents and checks

**Files:** Modify `README.md`, `PLUGIN_OVERVIEW.md`, `CHANGELOG.md`, the shortcut sheet.

- [ ] **Step 1:** README section "Typing speed"; the sheet lists `;`, Tab for the grey text, Mod+Shift+I; one overview line within the limit.
- [ ] **Step 2:** `npm run check`, `npm run build`, manifests — PASS.
- [ ] **Step 3: commit** `docs(mail): typing speed`
- [ ] **Step 4, with the next batched deploy:** the live BB at 480, 768 and 1280 px.
