import type { ReviewDiffFile } from "../../core/code-review/diff.ts";
import type { ReviewThread, Severity, Side, Target, TargetRequest, ThreadStatus } from "../../core/code-review/model.ts";

export type Placement = {state: "anchored" | "moved"; startLine: number; endLine: number} | {state: "outdated"};
export type ReviewView = {sessionId: string; target: Target; files: ReviewDiffFile[]; truncated: boolean; baseSha: string | null; headSha: string | null;
  threads: ReviewThread[]; placements: Record<string, Placement>};
export type NewThread = {filePath: string; side: Side | null; startLine: number; endLine: number; severity: Severity | null; body: string};

/** What the line review asks of the host; the entry point implements it over RPC. */
export type CodeReviewApi = {
  view(copyId: string, target: TargetRequest, ignoreWhitespace: boolean): Promise<ReviewView>;
  createThread(sessionId: string, thread: NewThread): Promise<void>;
  addComment(threadId: string, body: string): Promise<void>;
  editComment(commentId: string, body: string): Promise<void>;
  deleteComment(commentId: string): Promise<void>;
  setStatus(threadId: string, status: ThreadStatus): Promise<void>;
  send(sessionId: string, threadId: string, threadIds: string[], note: string): Promise<{count: number}>;
  apply(threadId: string, commentId: string): Promise<void>;
  /** Threads working on this copy, to send comments to. */
  targets(copyId: string): Promise<{id: string; title: string}[]>;
  openThread(threadId: string): void;
};
export const message = (error: unknown) => error instanceof Error ? error.message : "Request failed.";
export const severityLabel: Record<Severity, string> = {"must-fix": "Must fix", suggestion: "Suggestion", nit: "Nit", question: "Question"};
export const deliveryLabel = {sent: "Sent", answered: "Answered", no_reply: "No reply"} as const;
