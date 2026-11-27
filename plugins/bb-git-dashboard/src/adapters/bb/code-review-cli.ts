/**
 * `bb git-dashboard review …` — how the agent a review was sent to answers it: `list` the threads sent to it, then
 * `reply`, `resolve` or `dismiss` each one. Ported from diff-review server/cli.ts (MIT, gpambrozio); see
 * THIRD_PARTY_NOTICES.md. Text arrives as words or as `--text-base64`, which an agent fills through BB's
 * `--text-base64-stdin`, so quotes, backticks and new lines survive whatever the shell.
 */
import { PluginCliError } from "@get-bb/plugin-sdk";
import { parseRange } from "../../core/code-review/git-spec.ts";
import { describeLocation, describeTarget, GENERAL_PATH, targetRequestSchema, type ReviewThread, type Severity, type TargetRequest } from "../../core/code-review/model.ts";
import { failureFor } from "../../core/workspace.ts";
import type { AgentCommentInput } from "./code-review-runs.ts";
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
  comment(callerThreadId: string, input: AgentCommentInput): Promise<ReviewThread>;
  /** Asks the window showing the thread to open its copy's Review on a view and file. */
  open(threadId: string, target: TargetRequest, file: string | null): Promise<{copyId: string; route: string}>;
  /** Binds a run's thread that calls in before BB answered its start. */
  bind(callerThreadId: string): Promise<void>;
};
export type CommentOptions = {file: string | undefined; words: readonly string[]; encoded: string | undefined; line: number | undefined;
  endLine: number | undefined; side: "old" | "new" | undefined; severity: Severity | undefined; general: boolean};
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
    const failure = failureFor(error, "GIT_REJECTED");
    throw new PluginCliError(failure.detail ? codeOf(error) + ": " + failure.detail : codeOf(error), {code: codeOf(error).toLowerCase(), hint: failure.next});
  };
  return {
    async list(all: boolean, json: boolean, threadId: string | undefined) {
      await deps.bind(caller(threadId));
      const rows = deps.sentTo(caller(threadId), all);
      if (json) {
        // Whole threads are dropped from the end until the JSON fits, so it always parses; stderr says what was left out.
        let kept = rows;
        while (kept.length && JSON.stringify(kept).length > LIST_MAX_CHARS) kept = kept.slice(0, -1);
        return {exitCode: 0, stdout: JSON.stringify(kept), ...(kept.length < rows.length ? {stderr: (rows.length - kept.length) + " thread(s) left out to fit the output.\n"} : {})};
      }
      const text = rows.length ? rows.map(formatThread).join("\n\n") : all ? "No comment threads were sent to this thread." : "No open comment threads were sent to this thread.";
      return {exitCode: 0, stdout: (text.length > LIST_MAX_CHARS ? text.slice(0, LIST_MAX_CHARS) + "\n… cut" : text) + "\n"};
    },
    async answer(action: AgentAction, id: string, words: readonly string[], encoded: string | undefined, threadId: string | undefined) {
      const text = textOf(words, encoded);
      await deps.bind(caller(threadId));
      const thread = await deps.answer(caller(threadId), id, action, text).catch(refused);
      const draft = thread.comments.at(-1)?.draft;
      // On a pull request's thread the answer waits for the owner, who posts it to the forge.
      if (draft) return {exitCode: 0, stdout: "Saved a draft " + (draft === "resolve" ? "reply that resolves" : "reply") + " in comment thread " + thread.id
        + " (" + describeLocation(thread) + "); the owner posts it to the pull request.\n"};
      return {exitCode: 0, stdout: done[action] + " comment thread " + thread.id + " (" + describeLocation(thread) + ").\n"};
    },
    /** An AI review run's comment on lines of a file, the whole file (`--line 0`) or the whole diff (`--general`). */
    async comment(options: CommentOptions, threadId: string | undefined) {
      const {file, general} = options;
      if (!general && file === undefined) throw new PluginCliError("Give a file, or --general for the whole diff.", {code: "missing_required"});
      // With --general there is no file, so the first word of the comment lands in its place.
      const words = general && file !== undefined ? [file, ...options.words] : options.words;
      const text = textOf(words, options.encoded);
      if (!general && options.line === undefined) throw new PluginCliError("Give --line (0 for the whole file).", {code: "missing_required"});
      const startLine = general ? 0 : options.line!;
      await deps.bind(caller(threadId));
      const thread = await deps.comment(caller(threadId), {filePath: general ? GENERAL_PATH : file!, side: startLine === 0 ? null : options.side ?? "new",
        startLine, endLine: options.endLine ?? startLine, severity: options.severity ?? null, body: text}).catch(refused);
      return {exitCode: 0, stdout: "Added comment thread " + thread.id + " on " + describeLocation(thread) + ".\n"};
    },
    /** `review open [file] [--view …] [--thread …]`: opens the Review in the BB window showing the thread. */
    async open(options: {file: string | undefined; view: string | undefined; base: string | undefined; commit: string | undefined; range: string | undefined;
      thread: string | undefined}, threadId: string | undefined) {
      const target = viewRequest(options);
      const opened = await deps.open(options.thread ?? caller(threadId), target, options.file ?? null).catch(refused);
      const described = target.kind === "branch" || target.kind === "all" ? {kind: target.kind, base: target.base ?? "the default branch"} : target;
      return {exitCode: 0, stdout: "Opening the review of " + describeTarget(described)
        + " in the BB window that shows the thread.\nThe page, in any BB window: " + opened.route + "\n"};
    },
  };
}

/** The view `review open` asks for, from its options; the uncommitted changes when none is named. */
function viewRequest(options: {view: string | undefined; base: string | undefined; commit: string | undefined; range: string | undefined}): TargetRequest {
  const {view, base, commit, range} = options;
  const misuse = (text: string): never => { throw new PluginCliError(text, {code: "unexpected_argument"}); };
  if (range !== undefined && view !== undefined && view !== "range") misuse("--range goes with --view range, or alone.");
  if (range !== undefined || view === "range") return parseRange(range ?? "") ?? misuse("Give --range as a..b or a...b.");
  if (commit !== undefined) return targetRequestSchema.safeParse({kind: "commit", sha: commit}).data ?? misuse("--commit takes a commit hash of 7 to 64 hex characters.");
  if (view === "commit") misuse("--view commit needs --commit <sha>.");
  if (view === "branch" || view === "all") return base === undefined ? {kind: view} : {kind: view, base};
  if (base !== undefined) misuse("--base goes with --view branch or --view all.");
  return targetRequestSchema.safeParse({kind: view ?? "uncommitted"}).data ?? misuse("Unknown view " + view + ".");
}
