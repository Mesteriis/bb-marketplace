// Tasks (slice 3f): the tasks the owner kept from Find tasks, by due date.
// Local only: Done, Edit and Delete change this list and nothing else. A
// task's message may have left Makosh Mail; the task stays and says so.
import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { TaskView } from "../core/model.ts";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { AiText } from "./ai-text.tsx";
import { LoadingState } from "./empty-states.tsx";
import { TASK_TITLE_MAX } from "./tasks-dialog.tsx";

export const TASK_GONE_TEXT = "The message is no longer in Makosh Mail";

export type TaskPatch = { title?: string; due?: string | null; done?: boolean };

export interface TasksViewProps {
  load: (done: boolean, cursor: string | null) => Promise<{ tasks: TaskView[]; next: string | null }>;
  update: (id: string, patch: TaskPatch) => Promise<void>;
  remove: (id: string) => Promise<void>;
  onOpen: (task: TaskView) => void;
  refreshKey?: number;
}

/** Open tasks by due date (none last), then by when they were kept. */
export function byDue(tasks: readonly TaskView[]): TaskView[] {
  return [...tasks].sort((a, b) => {
    if (a.due !== b.due) {
      if (a.due === null) return 1;
      if (b.due === null) return -1;
      return a.due < b.due ? -1 : 1;
    }
    return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
  });
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export function TasksView({ load, update, remove, onOpen, refreshKey = 0 }: TasksViewProps) {
  const [done, setDone] = useState(false);
  const [tasks, setTasks] = useState<TaskView[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; title: string; due: string } | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const page = await load(done, null);
      setTasks(page.tasks);
      setNext(page.next);
      setProblem(null);
    } catch (error) {
      setProblem(error instanceof Error && error.message !== "" ? error.message : "Tasks could not be loaded");
    }
  }, [done, load]);
  useEffect(() => {
    void reload();
  }, [reload, refreshKey]);

  const run = (work: () => Promise<void>) => {
    work().then(
      () => void reload(),
      (error: unknown) => setProblem(error instanceof Error && error.message !== "" ? error.message : "The change failed"),
    );
  };
  const more = async () => {
    if (next === null) return;
    try {
      const page = await load(done, next);
      setTasks((prev) => [...(prev ?? []), ...page.tasks]);
      setNext(page.next);
    } catch {
      // The list keeps what it has.
    }
  };
  const saveEdit = (event: FormEvent) => {
    event.preventDefault();
    if (editing === null) return;
    const title = editing.title.replace(/[\r\n]+/g, " ").trim();
    if (title === "") return;
    const id = editing.id;
    const due = DAY.test(editing.due) ? editing.due : null;
    setEditing(null);
    run(() => update(id, { title, due }));
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="min-w-0 flex-1 text-lg font-semibold text-foreground">Tasks</h1>
        <div role="group" aria-label="Show" className="flex items-center rounded-md border border-border p-0.5">
          <Button variant={done ? "ghost" : "secondary"} size="sm" className="h-6 px-2 text-xs" aria-pressed={!done} onClick={() => setDone(false)}>
            Open
          </Button>
          <Button variant={done ? "secondary" : "ghost"} size="sm" className="h-6 px-2 text-xs" aria-pressed={done} onClick={() => setDone(true)}>
            Done
          </Button>
        </div>
      </div>
      {problem !== null ? (
        <p role="alert" className="text-sm text-destructive">
          {problem}
        </p>
      ) : null}
      {tasks === null ? (
        problem === null ? <LoadingState label={"Loading tasks\u2026"} /> : null
      ) : tasks.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {done ? "No finished tasks." : "No open tasks. Find tasks in a conversation keeps them here."}
        </p>
      ) : (
        <ul aria-label="Tasks" className="flex flex-col divide-y divide-border rounded-md border border-border">
          {(done ? tasks : byDue(tasks)).map((task) =>
            editing?.id === task.id ? (
              <li key={task.id} className="px-3 py-2">
                <form onSubmit={saveEdit} className="flex flex-wrap items-center gap-2">
                  <Input
                    aria-label="Task title"
                    value={editing.title}
                    maxLength={TASK_TITLE_MAX}
                    onChange={(event) => setEditing({ ...editing, title: event.target.value })}
                    className="h-8 min-w-40 flex-1"
                  />
                  <Input
                    type="date"
                    aria-label="Due date"
                    value={editing.due}
                    onChange={(event) => setEditing({ ...editing, due: event.target.value })}
                    className="h-8 w-40"
                  />
                  <Button type="submit" size="sm" className="h-8" disabled={editing.title.trim() === ""}>
                    Save
                  </Button>
                  <Button type="button" variant="ghost" size="sm" className="h-8" onClick={() => setEditing(null)}>
                    Cancel
                  </Button>
                </form>
              </li>
            ) : (
              <li key={task.id} className="flex flex-wrap items-start gap-2 px-3 py-2">
                <Checkbox
                  aria-label={`Done: ${task.title}`}
                  checked={task.doneAt !== null}
                  onCheckedChange={(checked) => run(() => update(task.id, { done: checked === true }))}
                  className="mt-0.5"
                />
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="text-sm text-foreground">
                    <AiText text={task.title} />
                  </span>
                  <span className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                    {task.due !== null ? <span>{`Due ${task.due}`}</span> : <span>No due date</span>}
                    {task.messageId !== null && task.threadId !== null ? (
                      <button
                        type="button"
                        onClick={() => onOpen(task)}
                        className="text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      >
                        Open the message
                      </button>
                    ) : (
                      <span>{TASK_GONE_TEXT}</span>
                    )}
                  </span>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  onClick={() => setEditing({ id: task.id, title: task.title, due: task.due ?? "" })}
                >
                  Edit
                </Button>
                {confirming === task.id ? (
                  <Button
                    variant="destructive"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    onClick={() => {
                      setConfirming(null);
                      run(() => remove(task.id));
                    }}
                  >
                    Delete task
                  </Button>
                ) : (
                  <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setConfirming(task.id)}>
                    Delete
                  </Button>
                )}
              </li>
            ),
          )}
        </ul>
      )}
      {next !== null ? (
        <Button variant="outline" size="sm" onClick={() => void more()}>
          Load more
        </Button>
      ) : null}
    </div>
  );
}
