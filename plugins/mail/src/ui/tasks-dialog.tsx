// Find tasks (slice 3f): what a model found to do in a conversation, for the
// owner to tick, edit and keep in the local Tasks view. Nothing is kept
// without Keep. A task whose quote is not in the message the model cited
// starts unticked and says so.
import { useEffect, useState } from "react";
import type { AiStartInput } from "../core/contract.ts";
import type { AiResultView } from "../core/model.ts";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useAiJob, type AiJobPorts } from "./ai-job.ts";
import { AI_CAUTION, AiFailure, AiNotesList, AiText, CitationChips, aiLabel, type AiCitation } from "./ai-text.tsx";
import { shownText } from "./agent-send-card.tsx";
import { stopEscape } from "./shortcuts.ts";
import { tx } from "./i18n/index.ts";

type TasksResult = Extract<AiResultView, { kind: "tasks" }>;

export type TaskPick = { index: number; title: string; due: string | null };

/** Longest task title the server keeps. */
export const TASK_TITLE_MAX = 120;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A model's title as an editable one-line value. */
export function editableTitle(title: string): string {
  return shownText(title).replace(/\s+/g, " ").trim().slice(0, TASK_TITLE_MAX);
}

type Row = { index: number; picked: boolean; title: string; due: string };

export function rowsOf(result: TasksResult): Row[] {
  return result.tasks.map((task) => ({
    index: task.index,
    picked: task.evidenceFound,
    title: editableTitle(task.title),
    due: task.due !== null && DAY.test(task.due) ? task.due : "",
  }));
}

/** What Keep sends: ticked rows with a title. */
export function picksOf(rows: readonly Row[]): TaskPick[] {
  return rows
    .filter((row) => row.picked && row.title.trim() !== "")
    .map((row) => ({ index: row.index, title: row.title.trim(), due: DAY.test(row.due) ? row.due : null }));
}

export interface TasksDialogProps {
  /** The request to run while open; null: closed. */
  request: Extract<AiStartInput, { kind: "tasks" }> | null;
  ports: AiJobPorts;
  onKeep: (jobId: string, picks: TaskPick[]) => Promise<number>;
  onCite: (citation: AiCitation) => void;
  onClose: () => void;
  pollMs?: number;
  onCloseAutoFocus?: (event: Event) => void;
}

export function TasksDialog(props: TasksDialogProps) {
  return (
    <Dialog
      open={props.request !== null}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto" onEscapeKeyDown={stopEscape} onCloseAutoFocus={props.onCloseAutoFocus}>
        {props.request !== null ? <TasksBody {...props} request={props.request} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function TasksBody({ request, ports, onKeep, onCite, onClose, pollMs }: TasksDialogProps & { request: NonNullable<TasksDialogProps["request"]> }) {
  const job = useAiJob(ports, pollMs);
  const { run, state } = job;
  const [rows, setRows] = useState<Row[] | null>(null);
  const [keeping, setKeeping] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    void run(request);
  }, [request, run]);
  const result = state.status === "done" && state.result.kind === "tasks" ? state.result : null;
  useEffect(() => {
    setRows(result === null ? null : rowsOf(result));
  }, [result]);

  const picks = rows === null ? [] : picksOf(rows);
  const patch = (index: number, change: Partial<Row>) =>
    setRows((prev) => prev?.map((row) => (row.index === index ? { ...row, ...change } : row)) ?? null);
  const keep = async () => {
    if (state.status !== "done" || state.jobId === null || picks.length === 0) return;
    setKeeping(true);
    setProblem(null);
    try {
      await onKeep(state.jobId, picks);
      onClose();
    } catch (error) {
      setProblem(error instanceof Error && error.message !== "" ? error.message : "The tasks could not be kept");
    } finally {
      setKeeping(false);
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{tx("Find tasks")}</DialogTitle>
        <DialogDescription>
          {result !== null ? aiLabel(result.provider, result.model) : tx("A model reads the conversation and lists what to do.")}
        </DialogDescription>
      </DialogHeader>
      {state.status === "running" ? (
        <p role="status" className="text-sm text-muted-foreground">
          {tx("Finding tasks\u2026")}
        </p>
      ) : null}
      {state.status === "failed" ? <AiFailure state={state} /> : null}
      {result !== null && rows !== null ? (
        rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{tx("No tasks found in this conversation.")}</p>
        ) : (
          <ul aria-label={tx("Tasks found")} className="flex flex-col gap-3">
            {result.tasks.map((task) => {
              const row = rows.find((r) => r.index === task.index);
              if (row === undefined) return null;
              return (
                <li key={task.index} className="flex items-start gap-2">
                  <Checkbox
                    aria-label={tx("Keep task {p1}", { p1: task.index + 1 })}
                    checked={row.picked}
                    onCheckedChange={(checked) => patch(task.index, { picked: checked === true })}
                    className="mt-2"
                  />
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <div className="flex flex-wrap gap-2">
                      <Input
                        aria-label={tx("Task {p1} title", { p1: task.index + 1 })}
                        value={row.title}
                        maxLength={TASK_TITLE_MAX}
                        onChange={(event) => patch(task.index, { title: event.target.value.replace(/[\r\n]+/g, " ") })}
                        className="h-8 min-w-40 flex-1"
                      />
                      <Input
                        type="date"
                        aria-label={tx("Task {p1} due date", { p1: task.index + 1 })}
                        value={row.due}
                        onChange={(event) => patch(task.index, { due: event.target.value })}
                        className="h-8 w-40"
                      />
                    </div>
                    {task.evidence !== "" ? (
                      <blockquote className="border-l-2 border-border pl-2 text-xs text-muted-foreground">
                        <AiText text={task.evidence} />
                        <CitationChips numbers={[task.message]} citations={result.citations} onCite={onCite} />
                      </blockquote>
                    ) : null}
                    {!task.evidenceFound ? (
                      <p className="text-xs text-destructive">{tx("Quote not found in the message; check it before keeping.")}</p>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )
      ) : null}
      {result !== null ? (
        <>
          <AiNotesList notes={result.notes} />
          <p className="text-xs text-muted-foreground">{AI_CAUTION}</p>
        </>
      ) : null}
      {problem !== null ? (
        <p role="alert" className="text-sm text-destructive">
          {problem}
        </p>
      ) : null}
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          {tx("Cancel")}
        </Button>
        <Button disabled={picks.length === 0 || keeping} onClick={() => void keep()}>
          {picks.length === 1 ? tx("Keep 1 task") : `Keep ${picks.length} tasks`}
        </Button>
      </DialogFooter>
    </>
  );
}
