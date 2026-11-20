# Mail: Smart Send and sender insights — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A send time taken from when the recipient usually writes, and insights in the sender card, all counted from stored mail.

**Architecture:** Pure rules in `src/core/sender-rhythm.ts`; one store method `senderExchange(address, accountId, sinceIso, limit)` in both stores; the server adds `insights` to `sender_card` and serves `smart_send_time`; the Send later menu and the sender card show them.

**Spec:** `docs/superpowers/specs/2026-11-20-mail-smart-send-design.md`

## Global Constraints

As in `docs/superpowers/plans/2026-11-20-mail-ai-sorts.md`. The new method joins a list `SMART_SEND_METHODS` in every "later" filter of the contract tests and is refused to plugins. Tests fix the time zone (`process.env.TZ` is not touched: the rules take an `offsetMinutes`/local-parts function so they are pure).

Exact values: 180 days, 500 messages each way, at least 5 incoming, 3 pairs for a median, pairs within 14 days, weekdays at 80 %, a three-hour span, at least 60 minutes ahead, most-with 3 people with 2 messages each.

## Review Focus

1. No model call, nothing leaves the computer; nothing about a correspondent in a log line.
2. Too little data says nothing; the smart time is never in the past or closer than an hour, and passes `validSendAt`.
3. Local time is the owner's; the rules do not depend on the machine's zone in tests.
4. SQLite and the fake give the same exchange rows; the owner's own addresses are left out of "most with".

### Task 1: The rules
**Files:** Create `src/core/sender-rhythm.ts` (+test).
- [ ] Tests first; implement; commit.

### Task 2: Store and server
**Files:** `ports.ts`, `sqlite-store.ts`, `fakes.ts` (`senderExchange`), store test; `model.ts` (`insights`), `contract.ts` (`smart_send_time`, `SMART_SEND_METHODS`), contract tests, `src/adapters/bb/slice-3h-rpc.ts` (card insights), `server.ts` (handler), `server.test.ts`.
- [ ] Tests first; implement; `npm run check`; commit.

### Task 3: The page
**Files:** `src/ui/send-later-menu.tsx` (+test), `src/ui/composer.tsx`, `src/ui/sender-card.tsx` (+test), `app.tsx`, `ru.ts`.
- [ ] Tests first; implement; `npm run check`; `npm run build`; commit.

### Task 4: Documents, gates, review
- [ ] README, CHANGELOG; check, build, manifests; commit; one independent review; fixes RED → GREEN.
