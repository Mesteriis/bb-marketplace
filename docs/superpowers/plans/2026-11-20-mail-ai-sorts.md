# Mail: AI sorts the inbox — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** For each new Inbox message a model writes one line and picks the owner's own labels; a label can archive automatically; labels are searchable (`ai:<label>`) and usable as Inbox tabs.

**Architecture:** A pure builder and parser (`src/core/ai-sort.ts`) on the existing AI frame. The unattended queue of auto drafts (`src/adapters/bb/auto-draft-queue.ts`) becomes a queue of batches shared by both kinds. A server module (`src/adapters/bb/ai-sort.ts`) picks messages, keeps the result and archives through the ordinary action. Labels and results live in two new tables; the thread list and detail carry the line and the label names.

**Tech Stack:** TypeScript, zod, vitest, better-sqlite3, React.

**Spec:** `docs/superpowers/specs/2026-11-20-mail-ai-sorts-design.md`

## Global Constraints

- All paths are under `plugins/mail`. `npm run check` after every task, `npm run build` before a task is done, `node ../../scripts/check-manifests.mjs` after touching `package.json`, `PLUGIN_OVERVIEW.md` (at its 4000-character limit: shorten only the AI section) or `marketplace.json`.
- `src/core` and `src/ui` import no `node:*` or `@get-bb/*`. New server code goes into its own modules; `server.ts` only wires.
- Fixtures use `example.com`, `example.net`, `example.org` only; no real mail text.
- Every string shown to the owner goes through `tx()`/`txn()`/`msg()` with a Russian line in `src/ui/i18n/ru.ts` (before the `"Try the saved password":` line).
- New RPC methods form one list `AI_SORT_METHODS` that joins every "later" filter of the positional contract tests; another plugin is refused on each; none is a tool, CLI command or mention. `sort` is an AI kind but not an `ai_start` kind.
- Raw model output is never stored, logged or returned; mail text never reaches a log line.
- No push, no reload of the owner's BB inside this plan. Commits touch `plugins/mail` and `docs`; messages end with `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>`.

Exact values from the spec: labels at most 12, name 1–30, description 1–300; summary 140 characters; at most 3 labels per message; 10 messages per call, 600 body characters each; 20 calls an hour, 100 a day; 200 waiting; 50 auto archives an hour; rows kept 90 days; list chips 2 and "+n"; operator `ai:`; setting `aiSort` (off).

## Review Focus

1. Mail outside AI access never reaches the model; the sender's address is never sent (name and domain only).
2. A message cannot label or protect itself by instruction: only the owner's label names survive the parser; auto archive never touches a message from someone the owner has written to, a flagged one, one Mail warns about, or one not in the Inbox.
3. Auto archive is the ordinary Archive action, logged; never delete, never spam; the hourly bound holds.
4. `ai:<label>` gives the same conversations in SQLite and the fake; an unknown label matches nothing; the operator is kept off the server search.
5. Agent access unchanged: no new method reachable by an agent or another plugin.
6. Auto drafts still work after the queue change (their tests unchanged in meaning).

---

### Task 1: The builder and the parser

**Files:** Create `src/core/ai-sort.ts`, `src/core/ai-sort.test.ts`. Modify `src/core/ai-input.ts` (kind `sort`: rate 20, cap 30 000, tokens 2 048; export what the builder needs), `src/core/agent-log.ts` (`ai_sort`, `ai_archive`), `src/ui/agent-activity.tsx`, `ru.ts`, the constants tests.

**Produces:**
- `type AiLabel = { id: string; name: string; description: string; autoArchive: boolean }`.
- `labelNameRefusal(name)`, `LABELS_MAX = 12`, `SORT_BATCH = 10`, `SORT_SUMMARY_CHARS = 140`, `SORT_LABELS_PER_MESSAGE = 3`.
- `sortInput(messages: readonly AiSourceMessage[], labels: readonly AiLabel[], options: { nonce: string; leftOut?: number }): AiBuild`.
- `parseSort(output: string, n: number, labels: readonly AiLabel[]): AiParse<{ items: { n: number; summary: string | null; labelIds: string[] }[] }>`.

- [ ] Tests first (literals): the input's order and markers; sender as name and domain; the body cut at 600 after redaction; a label description is redacted; the parser keeps only the owner's names (case folded), 3 at most, one item per `n`, `n` in range, a one-line summary cut at 140; non-JSON unreadable.
- [ ] Implement; `npm run check`; commit.

### Task 2: A queue of batches for both kinds

**Files:** Modify `src/adapters/bb/auto-draft-queue.ts` → the class takes `kind`, `batch` and `build(ids)`/`done(ids, made, finished)`; `reply-drafts.ts` adapts; `ai-jobs.ts` (kind `sort`: parse through a `ctx.parse` hook or a `labels` context, output variant `sort`); tests of both.

- [ ] Tests first: batches of 10; a batch whose build answers null is skipped; auto-draft tests still pass with batch 1; the give-up timer and the stop kinds as before.
- [ ] Implement; `npm run check`; commit.

### Task 3: Store, operator and views

**Files:** `sqlite-store.ts` (migration 24, label CRUD, `saveMessageAi`, `messageAiOf(ids)`, the `ai:` condition, list/detail rows), `fakes.ts`, `ports.ts`, `model.ts` (`aiSummary`, `aiLabels`), `search.ts` (operator `ai`), `server-search.ts` (kept off the server), `inbox-tabs.ts` if the condition list is closed, store tests for both kinds.

- [ ] Tests first: CRUD and its refusals; a result follows the message to another folder (dedup key); `ai:` and `-ai:`; an unknown or deleted label; the 90-day cleanup; migration from schema 23.
- [ ] Implement; `npm run check`; commit.

### Task 4: The server round and auto archive

**Files:** Create `src/adapters/bb/ai-sort.ts` (+test). Modify `src/core/page-settings.ts` + settings in `server.ts` (`aiSort`), `contract.ts` (`ai_labels_list`, `ai_label_save`, `ai_label_delete`, `ai_label_move`, `AI_SORT_METHODS`), contract tests, `server.ts` (hook in `afterRound` beside auto drafts, handlers), `server.test.ts`.

- [ ] Tests first: off by default; only in-scope new Inbox mail is sent, without addresses; the line and labels are stored and listed; a label marked auto archive archives, except a known sender, a flagged message, a warned one; the hourly archive bound; the agent log rows; plugin callers refused.
- [ ] Implement; `npm run check`; commit.

### Task 5: The page

**Files:** `src/ui/thread-list.tsx`, `src/ui/reading-pane.tsx`, create `src/ui/ai-label-chips.tsx`, `src/ui/settings/sorting-settings.tsx` (+tests), `src/ui/settings/ai-features-section.tsx`, `src/ui/search-help.tsx`, `app.tsx` ports, `ru.ts`.

- [ ] Tests first: the line replaces the snippet; chips 2 and "+n"; the settings list adds, edits, removes, moves and toggles auto archive; refusals shown.
- [ ] Implement; `npm run check`; `npm run build`; commit.

### Task 6: Documents and gates

- [ ] `README.md`, `CHANGELOG.md`, `PLUGIN_OVERVIEW.md` (≤ 4000), descriptions say what is true now.
- [ ] `npm run check`, `npm run build`, `node ../../scripts/check-manifests.mjs`; commit.
- [ ] One independent review over the branch range; fix findings RED → GREEN.
