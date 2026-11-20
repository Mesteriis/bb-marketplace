# Mail: Ask AI with actions — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ask's answer can carry up to three actions the owner runs with one click: show a search, reply or write with drafted text, archive / mark read / flag cited Inbox messages.

**Architecture:** A pure parser (`src/core/ask-actions.ts`) reads the `actions` key of the existing Ask answer; `parseAskAnswer` returns them; the server maps cited numbers to stored messages in the result view; the Ask panel renders buttons and the app runs them through code that already exists (search, reply with initial text, `message_action`).

**Spec:** `docs/superpowers/specs/2026-11-20-mail-ask-actions-design.md`

## Global Constraints

As in `docs/superpowers/plans/2026-11-20-mail-ai-sorts.md` (paths under `plugins/mail`, check/build/manifests, no host code in core and ui, example.* fixtures, Russian lines, no push, no reload). No new RPC method: only the `ask` result view grows.

Exact values: 3 actions; query 200 characters; paragraphs 4 000 characters in all; 20 messages per `act`; actions `archive`, `mark_read`, `flag`.

## Review Focus

1. No action runs without the owner's click; nothing destructive can be proposed.
2. Drafted text passes the link rule; allowed links come from the question only.
3. Numbers map to the excerpts the plugin sent; an `act` touches only Inbox messages; ids never come from the model.
4. The proposed search is parsed by Mail's own parser; a query with a note is dropped.

### Task 1: The parser and the prompt
**Files:** Create `src/core/ask-actions.ts` (+test). Modify `src/core/ai-input.ts` (`askAnswerInput` task text, `AskAnswer.actions`, `parseAskAnswer`), its tests.
- [ ] Tests first; implement; `npm run check`; commit.

### Task 2: The result view
**Files:** `src/core/model.ts` (ask view `actions`), `server.ts` (`aiResultView` maps numbers; link rule with the question's links through the job context), `src/adapters/bb/ai-jobs.ts` if the context is needed, `server.test.ts`.
- [ ] Tests first; implement; `npm run check`; commit.

### Task 3: The panel and the app
**Files:** `src/ui/ask-panel.tsx` (+test), `src/ui/mail-page.tsx`, `app.tsx`, `ru.ts`.
- [ ] Tests first; implement; `npm run check`; `npm run build`; commit.

### Task 4: Documents, gates, review
- [ ] README, CHANGELOG, overview (≤ 4000); check, build, manifests; commit; one independent review; fixes RED → GREEN.
