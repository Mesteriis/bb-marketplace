# Mail: AI writes mail — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A model writes a message from a few words in the owner's voice, following personal instructions and facts, and drafts replies to new mail from people the owner writes to.

**Architecture:** One pure builder and parser in `src/core/ai-write.ts` on top of the existing AI frame, redaction and job runner (`ai-input.ts`, `ai-jobs.ts`). `ai_start` gains kind `write`. Auto drafts are a pure eligibility rule (`src/core/auto-drafts.ts`), a small queue (`src/adapters/bb/auto-draft-queue.ts`) that feeds the same job runner with kind `autodraft`, and a table `reply_drafts`. The page gets a Write dialog in the composer, a strip in the reading pane and four settings.

**Tech Stack:** TypeScript, zod, vitest, better-sqlite3, React, TipTap.

**Spec:** `docs/superpowers/specs/2026-11-20-mail-ai-writes-design.md`

## Global Constraints

- All paths are under `plugins/mail`. `npm run check` after every task, `npm run build` before a task is done, `node ../../scripts/check-manifests.mjs` after touching `package.json`, `PLUGIN_OVERVIEW.md` (at its 4000-character limit: shorten before adding) or `marketplace.json`.
- `src/core` and `src/ui` import no `node:*` or `@get-bb/*`. New server code goes into its own modules, not into `server.ts` beyond wiring.
- Fixtures use `example.com`, `example.net`, `example.org` only; no real mail text.
- Every string shown to the owner goes through `tx()`/`txn()`/`msg()` with a Russian line in `src/ui/i18n/ru.ts` (before the `"Try the saved password":` line).
- New RPC methods form one list `AI_WRITE_METHODS` that joins every "later" filter of the positional contract tests; another plugin is refused on each; none is a tool, CLI command or mention.
- Raw model output is never stored, logged or returned; mail text never reaches a log line.
- No push, no reload of the owner's BB inside this plan. Commits touch `plugins/mail` and `docs`; messages end with `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>`.

Exact values from the spec: request 1–500 characters; voice 5 samples × 600 characters; `aiInstructions` 2 000; `aiKnowledge` 6 000; input caps 30 000 (write) and 20 000 (autodraft); answer 8 000 characters, 4 096 tokens; rates 30/h (write), 10/h and 50/day (autodraft); queue 20 waiting, retry 30 s; rows 200, 14 days; strip preview 240 characters; key `Mod+J`; link text `[link removed]`.

## Review Focus

1. Out-of-scope mail never reaches the model, in Write (context) or auto drafts (the message and its conversation).
2. A URL not written by the owner never survives into the text; the same URL with a different host or path is a different URL.
3. Auto drafts: only people the owner has written to, To not Cc, not bulk; caps hold across restarts of the queue within a process; nothing is sent or saved to the server.
4. `aiVoice` off: no sent text in the input.
5. Agent access unchanged: no new method reachable by an agent or another plugin; the agent log records each call with ids, never text.
6. Insert/Use only while the text is what was sent; one Undo.

---

### Task 1: The builder, the parser and the settings

**Files:** Create `src/core/ai-write.ts`, `src/core/ai-write.test.ts`. Modify `src/core/ai-input.ts` (kinds `write`, `autodraft` in `AI_KINDS`, rates, caps, tokens; export what the builder needs: `capParts`-based helper or a `conversationParts` export, `Tally`, `JSON_ONLY`, `AI_PREAMBLE`), `src/core/page-settings.ts`, `package.json` (four settings), `src/core/agent-log.ts` (`ai_write`, `ai_autodraft`), `src/ui/i18n/ru.ts`.

**Produces:**
- `voiceSamples(toRecipient: readonly string[], newest: readonly string[]): string[]` — own text of each (`ownText`), empty dropped, duplicates dropped, recipient's first, at most 5, each cut to 600.
- `writeInput(request: WriteRequest, options: { nonce: string; tag: string; leftOut?: number }): AiBuild` where `WriteRequest = { mode: "write" | "autodraft"; instruction?: string; own: readonly string[]; personal: string; facts: string; voice: readonly string[]; conversation: readonly AiSourceMessage[] }`; `restore` map as `draftInput`; the build also carries `allowedLinks: string[]`.
- `parseWrite(output: string, allowedLinks: readonly string[]): AiParse<{ reply: boolean; paragraphs: string[]; linksRemoved: number }>`.
- `LINK_REMOVED = "[link removed]"`.

- [ ] Tests first (literals): sample order and cuts; input order and markers; out-of-cap conversation keeps the newest; a secret in the request is restored-tagged, one in mail is not; `{"reply":false}`; an unknown URL replaced and counted, an allowed one kept, the same host with another path replaced; answer cut at 8 000; non-JSON → unreadable.
- [ ] Implement, settings, log labels, Russian lines; `npm run check`; commit.

### Task 2: `ai_start` kind `write` and the job runner

**Files:** Modify `src/adapters/bb/ai-jobs.ts` (+test) — parse the two kinds, `AiOutput` variant `{ kind: "write"; value: { reply; paragraphs; linksRemoved; unknown; missing } }`, `AiJobContext.unattended` (no idle cancel), `allowedLinks`; `src/core/contract.ts`, `src/core/model.ts` (result view `write`); `src/core/ports.ts`, `src/adapters/bb/sqlite-store.ts`, `src/core/testing/fakes.ts` (`sentTextsTo(address, limit)`); create `src/adapters/bb/ai-write-rpc.ts` (the `write` branch: draft check, conversation in scope, voice, settings) wired from `server.ts`; tests in `server.test.ts` style next to the module.

- [ ] Tests first: refused on a changed draft; reply context holds only in-scope messages and `leftOut` counts the rest; replied-to message out of scope → `out_of_scope`; `aiVoice` off → no voice block; result view carries `linksRemoved`; rate 30/h; agent log row `ai_write`.
- [ ] Implement; `npm run check`; commit.

### Task 3: The Write dialog

**Files:** Create `src/ui/write-dialog.tsx` (+test). Modify `src/ui/composer.tsx`, `src/ui/compose-toolbar.tsx`, `src/ui/shortcuts.ts` and the shortcut sheet, `src/ui/settings/ai-features-section.tsx` + `setting-controls.tsx` (a multi-line control), `src/ui/i18n/ru.ts`.

- [ ] Tests first: Write disabled on an empty request; the result and notes; Insert replaces the owner's range once and refuses when the range changed; `Mod+J` opens it; the settings group saves the four keys.
- [ ] Implement; `npm run check`; `npm run build`; commit.

### Task 4: Auto drafts

**Files:** Create `src/core/auto-drafts.ts` (+test), `src/adapters/bb/auto-draft-queue.ts` (+test), `src/adapters/bb/reply-drafts-rpc.ts` (+test), `src/ui/reply-draft-strip.tsx` (+test). Modify `sqlite-store.ts` (migration 23, `reply_drafts` methods, cleanup on delete/move/send), `fakes.ts`, `ports.ts`, `contract.ts` (`reply_draft_get/use/dismiss`, `AI_WRITE_METHODS`), contract tests' filters, `server.ts` (hook after `afterRound`'s filters, wiring), `src/ui/reading-pane.tsx`, `ru.ts`.

**Produces:** `eligible(row: AutoDraftRow, ctx: { own: ReadonlySet<string>; sentTo: ReadonlySet<string> }): boolean`; `class DraftBudget` (10/h, 50/day over a clock); `class AutoDraftQueue { offer(ids); dispose() }`.

- [ ] Tests first: each eligibility clause; caps with a fake clock; queue: one at a time, waits on busy, empties on gateway failure, drops the oldest past 20; `reply:false` keeps nothing; row deleted on use, dismiss, message delete, owner's reply, 14 days; `reply_draft_use` returns a reply draft with the paragraphs before the quote; plugin caller refused; migration from schema 22.
- [ ] Implement; `npm run check`; `npm run build`; commit.

### Task 5: Documents and gates

- [ ] `README.md`, `CHANGELOG.md`, `PLUGIN_OVERVIEW.md` (≤ 4000), `package.json` `bb.description`, root `marketplace.json` entry say what is true now.
- [ ] `npm run check`, `npm run build`, `node ../../scripts/check-manifests.mjs`; commit.
- [ ] One independent review over the branch range; fix findings RED → GREEN.
