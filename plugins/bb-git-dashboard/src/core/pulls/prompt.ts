// Ported from plugins/bb-github-pr-dashboard/prs.ts (MIT, © 2026 Muhammad Ahsan, revision 898660bc).
// Prompts for an agent: one review thread or failed check, or everything blocking the pull request. Forge text is fenced.
import type { FixSubject, PrDetail } from "./detail.ts";

const MAX_QUOTE = 6000;
const MAX_ANNOTATIONS = 20;

/** Text from GitHub, fenced one backtick longer than any run inside it so a bot's ``` blocks stay whole. */
function quote(text: string): string {
  const trimmed = text.trim();
  const body = trimmed.length > MAX_QUOTE ? `${trimmed.slice(0, MAX_QUOTE)}\n… (cut here, the rest is on GitHub)` : trimmed;
  const fence = "`".repeat(Math.max(2, ...(body.match(/`+/g) ?? []).map((run) => run.length)) + 1);
  return `${fence}\n${body}\n${fence}`;
}

/** The prompt an agent gets: the PR and its branch, then the comment with its replies, or the failed job with its errors. */
export function fixPrompt(pr: Pick<PrDetail, "url" | "repo" | "headRefName">, subject: FixSubject): string {
  const head = `Pull request ${pr.url} (${pr.repo}, branch \`${pr.headRefName}\`).`;
  if (subject.kind === "thread") {
    const t = subject.thread;
    const where = t.line === null ? "" : t.startLine && t.startLine !== t.line ? ` at lines ${t.startLine}–${t.line}` : ` at line ${t.line}`;
    const notes = [t.side === "LEFT" ? "a line of the old version" : "", t.isOutdated ? "outdated: the code has changed since" : ""].filter(Boolean);
    const [first, ...replies] = t.comments;
    return [
      head,
      "",
      `In \`${t.path}\`${where}${notes.length > 0 ? ` (${notes.join("; ")})` : ""} — review comment from @${first?.author ?? "unknown"}${first ? ` (${first.url})` : ""}:`,
      quote(first?.body ?? ""),
      ...replies.flatMap((c) => ["", `Reply from @${c.author}:`, quote(c.body)]),
      "",
      `Address this comment on branch \`${pr.headRefName}\`. If it is wrong, say why instead of changing the code.`,
    ].join("\n");
  }
  const c = subject.check;
  const errors = c.annotations
    .slice(0, MAX_ANNOTATIONS)
    .map((a) => `${a.path}${a.line ? `:${a.line}` : ""}${a.level ? ` ${a.level}` : ""}: ${a.message}`);
  const more = c.annotations.length > MAX_ANNOTATIONS ? ` (the first ${MAX_ANNOTATIONS} of ${c.annotations.length})` : "";
  return [
    head,
    "",
    `The CI job "${c.workflow ? `${c.workflow} / ${c.name}` : c.name}" failed${c.conclusion ? ` (${c.conclusion.toLowerCase().replace(/_/g, " ")})` : ""}${c.title ? `: ${c.title}` : "."}`,
    ...(errors.length > 0 ? ["", `Errors from the run${more}:`, quote(errors.join("\n"))] : []),
    ...(c.url ? ["", `Logs: ${c.url}`] : []),
    "",
    `Find why it fails and fix it on branch \`${pr.headRefName}\`.`,
  ].join("\n");
}

/** "owner/name", lowercased, from a GitHub git remote (https or ssh); null for anything else. */

type PromptPr = Pick<PrDetail, "url" | "repo" | "title" | "headRefName" | "baseRefName" | "author">;
const about = (pr: PromptPr) =>
  `Pull request ${pr.url}: "${pr.title}" (${pr.repo}, \`${pr.headRefName}\` into \`${pr.baseRefName}\`, by @${pr.author}).`;

/** Starting prompts for the PR menu's thread actions. */
export const prPrompts = {
  link: (pr: PromptPr) => `${about(pr)}\n\nLinking this pull request to this thread for context. No action needed yet.`,
  ask: (pr: PromptPr) => `${about(pr)}\n\nQuestion: `,
  explain: (pr: PromptPr) =>
    `${about(pr)}\n\nExplain this pull request. Read its description and diff (\`gh pr view\`, \`gh pr diff\`), then walk me through the change in a sensible reading order: what it does, why, and how the pieces fit. Point out what deserves a close read: risky logic, edge cases, missing tests, anything surprising.`,
};

/** Every unresolved review thread and failed job in one prompt; each section is what its own Fix with agent would send. */
export function findingsPrompt(pr: PromptPr, subjects: readonly FixSubject[]): string {
  const sections = subjects.map((s, i) => {
    // fixPrompt is [head, "", ...body, "", instruction]: keep the body.
    const body = fixPrompt(pr, s).split("\n").slice(2, -2);
    return [`### ${i + 1}. ${s.kind === "thread" ? "Review comment" : "Failed CI job"}`, ...body].join("\n");
  });
  return [
    about(pr),
    "",
    `Fix what is blocking it on branch \`${pr.headRefName}\`:`,
    "",
    sections.join("\n\n"),
    "",
    "Work through them in order. If a review comment is wrong, say why instead of changing the code. Finish with a short summary of what you changed.",
  ].join("\n");
}

