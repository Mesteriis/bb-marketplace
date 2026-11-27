import type { ReviewDiffFile } from "../../core/code-review/diff.ts";
import type { ComponentType } from "react";
import type { Execution, ReviewRun, ReviewThread, Severity, Side, Target, TargetRequest, ThreadStatus } from "../../core/code-review/model.ts";
import type { ExplainPlace } from "../../core/code-review/run-prompts.ts";

export type Placement = {state: "anchored" | "moved"; startLine: number; endLine: number} | {state: "outdated"};
export type ReviewView = {sessionId: string; target: Target; files: ReviewDiffFile[]; truncated: boolean; baseSha: string | null; headSha: string | null;
  threads: ReviewThread[]; placements: Record<string, Placement>};
export type NewThread = {filePath: string; side: Side | null; startLine: number; endLine: number; anchorContent: string | null; severity: Severity | null; body: string};

/** Where BB reads the provider catalog for a run: the reviewed thread's environment, or the copy's host. */
export type RunRouting = {kind: "environment"; environmentId: string} | {kind: "host"; hostId: string};
export type RunDefaults = {execution: Execution | null; message: string | null; permissionMode: "auto" | "accept-edits"; place: RunRouting | null};
/** BB's provider and model picker, given by the entry point: the UI layer holds no host code. */
export type ExecutionPickerProps = {value: Execution; onChange(value: Execution): void; routing: RunRouting; disabled?: boolean};

/** What the line review asks of the host; the entry point implements it over RPC. `viewer`: the thread whose tab asks. */
export type CodeReviewApi = {
  view(copyId: string, target: TargetRequest, ignoreWhitespace: boolean): Promise<ReviewView>;
  createThread(sessionId: string, thread: NewThread, viewer?: string | null): Promise<void>;
  addComment(threadId: string, body: string, viewer?: string | null): Promise<void>;
  editComment(commentId: string, body: string): Promise<void>;
  deleteComment(commentId: string): Promise<void>;
  setStatus(threadId: string, status: ThreadStatus): Promise<void>;
  send(sessionId: string, threadId: string, threadIds: string[], note: string): Promise<{count: number}>;
  apply(threadId: string, commentId: string): Promise<void>;
  /** Threads working on this copy, to send comments to. */
  targets(copyId: string): Promise<{id: string; title: string}[]>;
  openThread(threadId: string): void;
  runDefaults(copyId: string, viewer: string | null): Promise<RunDefaults>;
  /** The view's AI runs not yet closed, newest first. */
  runs(sessionId: string): Promise<ReviewRun[]>;
  startReview(sessionId: string, focuses: string[], instructions: string, execution: Execution, viewer: string | null): Promise<ReviewRun>;
  startSummary(sessionId: string, execution: Execution, viewer: string | null): Promise<ReviewRun>;
  startExplain(sessionId: string, place: ExplainPlace, viewer: string | null): Promise<ReviewRun>;
  fix(sessionId: string, threadIds: string[], note: string, execution: Execution, viewer: string | null): Promise<{run: ReviewRun; count: number}>;
  closeRun(runId: string): Promise<void>;
  ExecutionPicker: ComponentType<ExecutionPickerProps>;
};
export const message = (error: unknown) => error instanceof Error ? error.message : "Request failed.";
export const severityLabel: Record<Severity, string> = {"must-fix": "Must fix", suggestion: "Suggestion", nit: "Nit", question: "Question"};
export const deliveryLabel = {sent: "Sent", answered: "Answered", no_reply: "No reply"} as const;
