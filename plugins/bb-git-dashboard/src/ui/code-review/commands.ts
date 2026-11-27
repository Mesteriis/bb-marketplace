/**
 * Palette commands for the Review's actions. A command runs outside the Review (BB hands it only the thread in view
 * and its panel), so it opens the thread's Review tab and leaves the action here: a showing Review of that thread
 * takes it at once, otherwise the Review takes it when it shows. An action no Review takes within a few seconds is
 * dropped, so a stale one never fires later. Ported from diff-review app/commands.ts (MIT, gpambrozio); see
 * THIRD_PARTY_NOTICES.md.
 */
import { useEffect, useRef } from "react";

export const REVIEW_COMMANDS = {
  reload: "reload the diff",
  send: "send comments to the agent",
  "ai-review": "start an AI review",
  "comment-diff": "comment on the whole diff",
  find: "find in the diff",
  "go-to": "go to a file, comment or view…",
  "next-comment": "next comment",
  "previous-comment": "previous comment",
  "toggle-style": "switch between side by side and unified",
  "toggle-only-commented": "show only files with comments, or all",
  "toggle-whitespace": "hide or show whitespace changes",
  clear: "clear the review…",
} as const;
export type ReviewCommand = keyof typeof REVIEW_COMMANDS;

/** How long an action waits for its Review to show, in milliseconds. */
export const PENDING_MS = 5_000;
type Handler = (command: ReviewCommand) => void;
const handlers = new Map<string, Set<Handler>>();
const pending = new Map<string, {command: ReviewCommand; at: number}>();

/** Hands `command` to the showing Review of `key` (a thread id), or keeps it for the one about to show. */
export function dispatchReviewCommand(key: string, command: ReviewCommand, now = Date.now()) {
  const listening = handlers.get(key);
  if (listening?.size) { for (const handler of listening) handler(command); return; }
  pending.set(key, {command, at: now});
}

/** Takes the commands for `key` while mounted, including one left for it just before it showed. */
export function takeReviewCommands(key: string, handler: Handler, now = Date.now): () => void {
  const set = handlers.get(key) ?? new Set();
  set.add(handler);
  handlers.set(key, set);
  const waiting = pending.get(key);
  pending.delete(key);
  if (waiting && now() - waiting.at <= PENDING_MS) handler(waiting.command);
  return () => { set.delete(handler); if (!set.size) handlers.delete(key); };
}

export function useReviewCommands(key: string, handler: Handler) {
  const latest = useRef(handler);
  latest.current = handler;
  useEffect(() => takeReviewCommands(key, command => latest.current(command)), [key]);
}
