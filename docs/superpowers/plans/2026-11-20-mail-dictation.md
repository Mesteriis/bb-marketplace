# Mail: dictation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Speak a message: a Dictate button records, BB's voice service transcribes, the text is inserted at the cursor.

**Architecture:** A browser-only hook (`src/ui/dictation.ts`) with injected recorder and microphone; a pure text step (`src/core/dictation-text.ts`); an editor helper that inserts paragraphs at the selection; a port filled in `app.tsx` with the page SDK's `system.transcribeVoice`.

**Spec:** `docs/superpowers/specs/2026-11-20-mail-dictation-design.md`

## Global Constraints

As in `docs/superpowers/plans/2026-11-20-mail-ai-sorts.md`. No server change and no new RPC method. `src/ui` imports no `@get-bb/*`: the SDK call lives in `app.tsx`.

Exact values: 5 minutes; 20 000 characters; one retry.

## Review Focus

1. The microphone is released at every end; nothing records without the visible state.
2. Audio goes only to the port; nothing is stored or logged.
3. The inserted text is plain, cleaned, one Undo; a draft that changed meanwhile still gets the text at the current selection.

### Task 1: The text step and the editor insertion
**Files:** Create `src/core/dictation-text.ts` (+test); `src/ui/compose-editor.tsx` (`insertParagraphs`) (+test).
### Task 2: The hook
**Files:** Create `src/ui/dictation.ts` (+test).
### Task 3: The button and the wiring
**Files:** `src/ui/compose-toolbar.tsx`, `src/ui/composer.tsx` (+tests), `app.tsx`, `ru.ts`.
### Task 4: Documents, gates, review
