// Make a task from a mail (slice 3g, #21): on a Taskboard board when
// Taskboard answers, else a Mail task with a note and a due date. When
// Taskboard does not answer, the dialog offers the local task instead of an
// error. The excerpt is the server's redacted, quote-free text; the page
// sends only the owner's choices.
import { useEffect, useId, useState } from "react";
import type { RpcOut, TaskTargetsOutput } from "../core/contract.ts";
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
import { cn } from "@/lib/utils";
import { BB_TEXT, errorText, FIELD_CLASS, type BbCall } from "./bb-ports.ts";
import { stopEscape } from "./shortcuts.ts";
import { tx } from "./i18n/index.ts";

export interface TaskRequest {
  messageId: string;
  /** The subject as the list shows it: the editable title. */
  subject: string;
  inAiScope: boolean;
}

export type TaskMade = Extract<RpcOut<"task_from_mail">, { kind: "taskboard" | "local" }>;

export interface TaskDialogProps {
  request: TaskRequest | null;
  call: BbCall;
  onMade: (made: TaskMade, boardName: string | null) => void;
  onClose: () => void;
}

export function TaskDialog(props: TaskDialogProps) {
  return (
    <Dialog
      open={props.request !== null}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto" onEscapeKeyDown={stopEscape}>
        {props.request !== null ? <TaskBody {...props} request={props.request} /> : null}
      </DialogContent>
    </Dialog>
  );
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function TaskBody({ request, call, onMade, onClose }: TaskDialogProps & { request: TaskRequest }) {
  const ids = { title: useId(), note: useId(), board: useId(), due: useId() };
  const [targets, setTargets] = useState<TaskTargetsOutput | null>(null);
  const [where, setWhere] = useState<"taskboard" | "local">("local");
  const [boardId, setBoardId] = useState<string>("");
  const [title, setTitle] = useState(request.subject.trim().slice(0, 500));
  const [note, setNote] = useState("");
  const [excerpt, setExcerpt] = useState(request.inAiScope);
  const [due, setDue] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  /** Taskboard did not answer on Create: the local task is offered. */
  const [unavailable, setUnavailable] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    call("task_targets", {}).then(
      (found) => {
        if (!live) return;
        setTargets(found);
        const boards = found.taskboard?.boards ?? [];
        if (found.target !== "local" && boards.length > 0 && request.inAiScope) {
          setWhere("taskboard");
          setBoardId(boards.some((b) => b.id === found.lastBoardId) ? found.lastBoardId! : boards[0]!.id);
        }
      },
      () => {
        if (live) setTargets({ taskboard: null, reason: "Taskboard did not answer", lastBoardId: null, target: "auto" });
      },
    );
    return () => {
      live = false;
    };
  }, [call, request.inAiScope]);

  const boards = targets?.taskboard?.boards ?? [];
  const make = async (target: "taskboard" | "local") => {
    if (title.trim() === "") return;
    setBusy(true);
    setProblem(null);
    try {
      const made = await call("task_from_mail", {
        messageId: request.messageId,
        target:
          target === "taskboard"
            ? { kind: "taskboard", boardId }
            : { kind: "local", due: DAY.test(due) ? due : null },
        title: title.trim(),
        ...(note.trim() !== "" ? { note } : {}),
        excerpt: excerpt && request.inAiScope,
      });
      if (made.kind === "unavailable") {
        setUnavailable(made.reason);
        return;
      }
      onMade(made, made.kind === "taskboard" ? (boards.find((b) => b.id === boardId)?.name ?? null) : null);
      onClose();
    } catch (error) {
      setProblem(errorText(error, "The task could not be made"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{tx("Make a task")}</DialogTitle>
        <DialogDescription>
          {where === "taskboard" ? tx("On your Taskboard board.") : tx("Kept in Mail's own Tasks.")}
        </DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-3">
        {targets === null ? (
          <p role="status" className="text-sm text-muted-foreground">
            {tx("Looking for Taskboard\u2026")}
          </p>
        ) : boards.length > 0 ? (
          <fieldset className="flex flex-col gap-1">
            <legend className="text-xs font-medium text-muted-foreground">{tx("Where")}</legend>
            <div className="flex flex-wrap gap-3 text-sm">
              <label className="flex items-center gap-1.5">
                <input
                  type="radio"
                  name="task-where"
                  checked={where === "taskboard"}
                  disabled={!request.inAiScope}
                  onChange={() => setWhere("taskboard")}
                />
                {request.inAiScope ? tx("Taskboard") : `Taskboard (${BB_TEXT.out_of_scope})`}
              </label>
              <label className="flex items-center gap-1.5">
                <input type="radio" name="task-where" checked={where === "local"} onChange={() => setWhere("local")} />
                {tx("Mail tasks")}
              </label>
            </div>
          </fieldset>
        ) : targets.reason !== null ? (
          <p className="text-xs text-muted-foreground">{`${targets.reason}; the task is kept in Mail.`}</p>
        ) : null}
        {where === "taskboard" && boards.length > 0 ? (
          <div className="flex flex-col gap-1">
            <label htmlFor={ids.board} className="text-xs font-medium text-muted-foreground">
              {tx("Board")}
            </label>
            <select id={ids.board} className={cn(FIELD_CLASS, "h-8")} value={boardId} onChange={(e) => setBoardId(e.target.value)}>
              {boards.map((board) => (
                <option key={board.id} value={board.id}>
                  {board.name}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        <div className="flex flex-col gap-1">
          <label htmlFor={ids.title} className="text-xs font-medium text-muted-foreground">
            {tx("Title")}
          </label>
          <Input id={ids.title} value={title} maxLength={500} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={ids.note} className="text-xs font-medium text-muted-foreground">
            {tx("Note (optional)")}
          </label>
          <textarea
            id={ids.note}
            rows={3}
            maxLength={4000}
            className={cn(FIELD_CLASS, "resize-y py-2")}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
        <label className="flex items-center gap-2 text-sm" title={request.inAiScope ? undefined : BB_TEXT.out_of_scope}>
          <Checkbox
            checked={excerpt && request.inAiScope}
            disabled={!request.inAiScope}
            onCheckedChange={(checked) => setExcerpt(checked === true)}
          />
          {tx("Include an excerpt of the mail (passwords and codes hidden)")}
        </label>
        {!request.inAiScope ? <p className="text-xs text-muted-foreground">{BB_TEXT.out_of_scope}</p> : null}
        {where === "local" ? (
          <div className="flex flex-col gap-1">
            <label htmlFor={ids.due} className="text-xs font-medium text-muted-foreground">
              {tx("Due (optional)")}
            </label>
            <Input id={ids.due} type="date" value={due} onChange={(e) => setDue(e.target.value)} />
          </div>
        ) : null}
        {unavailable !== null ? (
          <div role="alert" className="flex flex-col gap-2 rounded-md border border-border p-2 text-sm">
            <p>{`${unavailable}; keep the task in Mail?`}</p>
            <div>
              <Button size="sm" className="h-7 px-2" disabled={busy} onClick={() => void make("local")}>
                {tx("Keep it in Mail")}
              </Button>
            </div>
          </div>
        ) : null}
        {problem !== null ? (
          <p role="alert" className="text-sm text-destructive">
            {problem}
          </p>
        ) : null}
      </div>
      <DialogFooter>
        <Button variant="ghost" size="sm" onClick={onClose}>
          {tx("Cancel")}
        </Button>
        <Button
          size="sm"
          disabled={busy || targets === null || title.trim() === "" || (where === "taskboard" && boardId === "")}
          onClick={() => void make(where)}
        >
          {tx("Create")}
        </Button>
      </DialogFooter>
    </>
  );
}
