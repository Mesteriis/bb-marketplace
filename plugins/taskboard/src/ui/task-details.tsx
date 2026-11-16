import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import type { Column, JiraTransition, Task, TaskRun, TimeEntry } from "../core/index.ts";
import type { Notify, TaskboardApi } from "./api.ts";

interface TaskDetailsProps {
  task: Task;
  columns: Column[];
  connectionId: string | null;
  connectionPresent: boolean;
  fill?: boolean;
  api: TaskboardApi;
  notify: Notify;
  onMove: (taskId: string, status: string) => void;
  onApplyTransition: (transitionId: string) => Promise<void>;
  onEdit: (task: Task) => void;
  onDelete: (taskId: string) => void;
  onClose: () => void;
  run: TaskRun | null;
  cancelableRun: TaskRun | null;
  pendingEntry: TimeEntry | null;
  failedEntry: TimeEntry | null;
  unknownEntry: TimeEntry | null;
  onTakeIntoWork: () => void;
  onComplete: () => void;
  onCancelRun: () => void;
  onRetryTime: () => void;
  onResolveTime: () => void;
  onOpenTimeEntry: () => void;
}

export function TaskDetails({
  task,
  columns,
  connectionId,
  connectionPresent,
  fill = false,
  api,
  notify,
  onMove,
  onApplyTransition,
  onEdit,
  onDelete,
  onClose,
  run,
  cancelableRun,
  pendingEntry,
  failedEntry,
  unknownEntry,
  onTakeIntoWork,
  onComplete,
  onCancelRun,
  onRetryTime,
  onResolveTime,
  onOpenTimeEntry,
}: TaskDetailsProps) {
  const [transitions, setTransitions] = useState<JiraTransition[]>([]);
  const [transitionsLoading, setTransitionsLoading] = useState(false);
  const [applyingId, setApplyingId] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const isJira = task.origin === "jira" && task.originKey !== null;
  const canMove = task.origin === "local" || connectionPresent;

  const loadTransitions = useCallback(async () => {
    if (!isJira || connectionId === null || task.originKey === null || !connectionPresent) {
      setTransitions([]);
      return;
    }
    setTransitionsLoading(true);
    try {
      setTransitions(await api.listTransitions(connectionId, task.originKey));
    } catch (error) {
      setTransitions([]);
      notify("error", "Could not load transitions");
    } finally {
      setTransitionsLoading(false);
    }
  }, [api, connectionId, connectionPresent, isJira, notify, task.originKey]);

  useEffect(() => {
    void loadTransitions();
  }, [loadTransitions, task.id, task.updatedAt]);

  useEffect(() => setConfirmingDelete(false), [task.id]);

  return (
    <aside
      className={cn("flex shrink-0 flex-col border-l border-border", fill ? "h-full w-full" : "w-80")}
      aria-label="Task details"
    >
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
        <h2 className="truncate text-sm font-semibold">Task details</h2>
        <Button variant="ghost" size="icon" aria-label="Close details" onClick={onClose}>
          <Icon name="X" aria-hidden="true" />
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4">
        <div className="flex flex-col gap-1">
          <h3 className="text-base font-semibold leading-snug">{task.title}</h3>
          {isJira && (
            <span className="flex items-center gap-1.5">
              <a className="text-xs text-muted-foreground underline-offset-2 hover:underline" href={task.originUrl ?? undefined} target="_blank" rel="noreferrer">
                {task.originKey}
              </a>
              <span className="rounded border border-border px-1.5 py-0.5 text-xs text-muted-foreground">read-only</span>
            </span>
          )}
          {task.origin === "local" && <span className="text-xs text-muted-foreground">Local task</span>}
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-muted-foreground" htmlFor="details-status">Status</label>
          <select
            id="details-status"
            className="rounded-md border border-input bg-transparent px-2 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
            value={task.status}
            disabled={!canMove}
            onChange={(event) => onMove(task.id, event.target.value)}
          >
            {columns.map((column) => (
              <option key={column.id} value={column.id}>{column.name}</option>
            ))}
          </select>
          {isJira && !connectionPresent && (
            <span className="text-xs text-muted-foreground">Connection removed — remote moves are unavailable</span>
          )}
        </div>

        {task.labels.length > 0 && (
          <div className="flex flex-wrap gap-1.5" aria-label="Labels">
            {task.labels.map((label) => (
              <span key={label} className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">{label}</span>
            ))}
          </div>
        )}

        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">Description</span>
          <p className="whitespace-pre-wrap text-sm">{task.description !== "" ? task.description : "No description"}</p>
        </div>

        <div className="flex flex-col gap-2 border-t border-border pt-3">
          <span className="text-xs font-medium text-muted-foreground">Work</span>
          {run !== null ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="truncate text-xs text-muted-foreground">In work</span>
              <Button variant="outline" size="sm" onClick={onComplete}>Complete</Button>
            </div>
          ) : (
            <Button variant="outline" size="sm" onClick={onTakeIntoWork}>Take into work</Button>
          )}
          {cancelableRun !== null && (
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">A previous run failed before any thread was created.</span>
              <Button variant="ghost" size="sm" onClick={onCancelRun}>Cancel run</Button>
            </div>
          )}
          {pendingEntry !== null && (
            <Button variant="ghost" size="sm" onClick={onOpenTimeEntry}>Log time (pending)</Button>
          )}
          {failedEntry !== null && (
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">Time submission failed.</span>
              <Button variant="outline" size="sm" onClick={onRetryTime}>Retry time</Button>
            </div>
          )}
          {unknownEntry !== null && (
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">Time may already be logged in Jira. Check Jira, then mark it logged.</span>
              <Button variant="outline" size="sm" onClick={onResolveTime}>Mark logged</Button>
            </div>
          )}
        </div>

        {isJira && connectionPresent && (
          <div className="flex flex-col gap-2">
            <span className="text-xs font-medium text-muted-foreground">Transitions</span>
            {transitionsLoading && <span className="text-xs text-muted-foreground">Loading transitions…</span>}
            {!transitionsLoading && transitions.length === 0 && <span className="text-xs text-muted-foreground">No transitions available</span>}
            {transitions.map((transition) => (
              <Button
                key={transition.id}
                variant="outline"
                size="sm"
                className="justify-start"
                disabled={applyingId !== null}
                onClick={() => {
                  setApplyingId(transition.id);
                  onApplyTransition(transition.id).finally(() => setApplyingId(null));
                }}
              >
                {applyingId === transition.id ? "Applying…" : transition.name}
              </Button>
            ))}
          </div>
        )}
      </div>
      <div className="flex gap-2 border-t border-border px-4 py-3">
        {task.origin === "local" && <Button variant="outline" size="sm" onClick={() => onEdit(task)}>Edit</Button>}
        <Button variant="destructive" size="sm" onClick={() => { if (!confirmingDelete) { setConfirmingDelete(true); return; } onDelete(task.id); }}>
          {confirmingDelete ? "Really delete?" : "Delete"}
        </Button>
      </div>
    </aside>
  );
}
