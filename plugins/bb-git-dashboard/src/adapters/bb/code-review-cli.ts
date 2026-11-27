/**
 * `bb git-dashboard review …` — how the agent a review was sent to answers it: `list` the threads sent to it, then
 * `reply`, `resolve` or `dismiss` each one. Ported from diff-review server/cli.ts (MIT, gpambrozio); see
 * THIRD_PARTY_NOTICES.md. Text arrives as words or as `--text-base64`, which an agent fills through BB's
 * `--text-base64-stdin`, so quotes, backticks and new lines survive whatever the shell.
 */
import { PluginCliError } from "@get-bb/plugin-sdk";
import { describeLocation, type ReviewThread } from "../../core/code-review/model.ts";
import type { AgentAction } from "./code-review-service.ts";

/** The longest text a command takes, in UTF-8 bytes; its base64 still fits BB's 16 KiB stdin line. */
export const TEXT_MAX_BYTES = 12_000;
/** Output stays well under BB's cap for a plugin command's output. */
const LIST_MAX_CHARS = 500_000;

/** Strict base64 of valid UTF-8. A heredoc always ends its text with a new line, so one trailing "\n" is dropped. */
export function decodeText(encoded: string): string {
  const compact = encoded.trim();
  if (compact.length > Math.ceil((TEXT_MAX_BYTES + 1) / 3) * 4) throw new PluginCliError(`The text is longer than ${TEXT_MAX_BYTES} bytes.`, {code: "text_too_long"});
  if (compact.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) throw new PluginCliError("--text-base64 is not valid base64.", {code: "invalid_value"});
  const decoded = Buffer.from(compact, "base64");
  const bytes = decoded.at(-1) === 0x0a ? decoded.subarray(0, -1) : decoded;
  if (bytes.byteLength > TEXT_MAX_BYTES) throw new PluginCliError(`The text is longer than ${TEXT_MAX_BYTES} bytes.`, {code: "text_too_long"});
  try { return new TextDecoder("utf-8", {fatal: true, ignoreBOM: true}).decode(bytes); }
  catch { throw new PluginCliError("--text-base64 does not decode to UTF-8 text.", {code: "invalid_value"}); }
}

export function textOf(words: readonly string[], encoded: string | undefined): string {
  const joined = words.join(" ");
  if (encoded !== undefined && joined.trim() !== "") throw new PluginCliError("Give the text as words or as --text-base64, not both.", {code: "unexpected_argument"});
  const text = encoded === undefined ? joined : decodeText(encoded);
  if (Buffer.byteLength(text, "utf8") > TEXT_MAX_BYTES) throw new PluginCliError(`The text is longer than ${TEXT_MAX_BYTES} bytes.`, {code: "text_too_long"});
  return text;
}

const indent = (text: string, by: string) => text.split("\n").map(line => by + line).join("\n");

/** One thread as `list` prints it. */
export function formatThread(thread: ReviewThread): string {
  const facts = [thread.status, describeLocation(thread), ...(thread.severity ? [thread.severity] : [])];
  const lines = [thread.id + "  " + facts.join(" · ")];
  if (thread.anchorContent !== null) lines.push("  Code:", indent(thread.anchorContent, "    | "));
  for (const comment of thread.comments) {
    lines.push("  " + (comment.authorType === "user" ? "User" : "Agent (" + comment.authorName + ")") + ":", indent(comment.body, "    "));
  }
  return lines.join("\n");
}

export type ReviewCliDeps = {
  sentTo(callerThreadId: string, all: boolean): ReviewThread[];
  answer(callerThreadId: string, prefix: string, action: AgentAction, text: string): Promise<ReviewThread>;
};
const done: Record<AgentAction, string> = {reply: "Replied in", resolve: "Resolved", dismiss: "Dismissed"};
const codeOf = (error: unknown) => error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : "GIT_REJECTED";

/** The `review` commands; each needs the calling thread, the one the comments were sent to. */
export function reviewCommands(deps: ReviewCliDeps) {
  const caller = (threadId: string | undefined) => {
    if (!threadId) throw new PluginCliError("Run this inside the BB thread the comments were sent to.", {code: "thread_required"});
    return threadId;
  };
  const refused = (error: unknown): never => {
    if (error instanceof PluginCliError) throw error;
    throw new PluginCliError(codeOf(error), {code: codeOf(error).toLowerCase()});
  };
  return {
    list(all: boolean, json: boolean, threadId: string | undefined) {
      const rows = deps.sentTo(caller(threadId), all);
      if (json) return {exitCode: 0, stdout: JSON.stringify(rows).slice(0, LIST_MAX_CHARS)};
      const text = rows.length ? rows.map(formatThread).join("\n\n") : all ? "No comment threads were sent to this thread." : "No open comment threads were sent to this thread.";
      return {exitCode: 0, stdout: (text.length > LIST_MAX_CHARS ? text.slice(0, LIST_MAX_CHARS) + "\n… cut" : text) + "\n"};
    },
    async answer(action: AgentAction, id: string, words: readonly string[], encoded: string | undefined, threadId: string | undefined) {
      const text = textOf(words, encoded);
      const thread = await deps.answer(caller(threadId), id, action, text).catch(refused);
      return {exitCode: 0, stdout: done[action] + " comment thread " + thread.id + " (" + describeLocation(thread) + ").\n"};
    },
  };
}
