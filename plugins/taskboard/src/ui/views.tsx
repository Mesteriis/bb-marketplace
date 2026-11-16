import { useState } from "react";
import { cn } from "@/lib/utils";
import type { Column, Task } from "../core/index.ts";

function groupTasks(tasks: Task[], columns: Column[]): Map<string, Task[]> {
  const map = new Map<string, Task[]>();
  for (const column of columns) map.set(column.id, []);
  for (const task of tasks) {
    const list = map.get(task.status);
    if (list !== undefined) list.push(task);
  }
  return map;
}

export function OriginBadge({ task }: { task: Task }) {
  if (task.origin !== "jira") return null;
  return (
    <span className="shrink-0 rounded border border-border px-1.5 py-0.5 text-xs tabular-nums text-muted-foreground">
      {task.originKey}
    </span>
  );
}

function LabelChips({ task }: { task: Task }) {
  return (
    <>
      {task.labels.slice(0, 3).map((label) => (
        <span key={label} className="shrink-0 rounded-full border border-border px-1.5 py-0.5 text-xs text-muted-foreground">
          {label}
        </span>
      ))}
    </>
  );
}

interface ViewProps {
  tasks: Task[];
  columns: Column[];
  canMove: (task: Task) => boolean;
  onOpen: (task: Task) => void;
  onMove: (taskId: string, status: string) => void;
}

function MoveSelect({ task, columns, canMove, onMove }: { task: Task; columns: Column[]; canMove: boolean; onMove: (id: string, status: string) => void }) {
  return (
    <select
      aria-label="Move task"
      className="shrink-0 rounded-md border border-input bg-transparent px-2 py-1 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
      value={task.status}
      disabled={!canMove}
      onChange={(event) => onMove(task.id, event.target.value)}
    >
      {columns.map((column) => (
        <option key={column.id} value={column.id}>{column.name}</option>
      ))}
    </select>
  );
}

export function ListView({ tasks, columns, canMove, onOpen, onMove }: ViewProps) {
  if (tasks.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-sm text-muted-foreground">
        No tasks match. Create one, fetch issues from Jira, or clear the filters.
      </div>
    );
  }
  const byColumn = groupTasks(tasks, columns);
  return (
    <div className="flex flex-col gap-6 p-4">
      {columns.map((column) => {
        const list = byColumn.get(column.id) ?? [];
        return (
          <section key={column.id} aria-label={column.name}>
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {column.name} <span className="font-normal normal-case">({list.length})</span>
            </h2>
            {list.length === 0 ? (
              <div className="rounded-md border border-dashed border-border p-3 text-center text-xs text-muted-foreground">
                Empty
              </div>
            ) : (
              <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
                {list.map((task) => (
                  <li key={task.id} className="flex items-center gap-2 px-3 py-2">
                    <button type="button" className="min-w-0 flex-1 truncate text-left text-sm hover:underline" onClick={() => onOpen(task)}>
                      {task.title}
                    </button>
                    <OriginBadge task={task} />
                    <LabelChips task={task} />
                    <MoveSelect task={task} columns={columns} canMove={canMove(task)} onMove={onMove} />
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}

export function KanbanView({ tasks, columns, canMove, onOpen, onMove }: ViewProps) {
  const [dragging, setDragging] = useState<string | null>(null);
  const byColumn = groupTasks(tasks, columns);
  if (tasks.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-sm text-muted-foreground">
        No tasks match. Create one, fetch issues from Jira, or clear the filters.
      </div>
    );
  }
  return (
    <div className="flex h-full gap-4 overflow-x-auto p-4">
      {columns.map((column) => {
        const list = byColumn.get(column.id) ?? [];
        return (
          <div
            key={column.id}
            className="flex w-64 shrink-0 flex-col rounded-lg border border-border bg-muted/40"
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              const id = event.dataTransfer.getData("text/plain");
              if (id !== "") onMove(id, column.id);
              setDragging(null);
            }}
          >
            <h2 className="px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {column.name} <span className="font-normal normal-case">({list.length})</span>
            </h2>
            <div className="flex min-h-[120px] flex-1 flex-col gap-2 px-2 pb-2">
              {list.map((task) => {
                const movable = canMove(task);
                return (
                  <div
                    key={task.id}
                    draggable={movable}
                    onDragStart={(event) => {
                      event.dataTransfer.setData("text/plain", task.id);
                      setDragging(task.id);
                    }}
                    onDragEnd={() => setDragging(null)}
                    className={cn(
                      "cursor-grab rounded-md border border-border bg-card p-2 shadow-sm",
                      !movable && "cursor-default",
                      dragging === task.id && "opacity-50",
                    )}
                  >
                    <button type="button" className="block w-full text-left text-sm" onClick={() => onOpen(task)}>
                      {task.title}
                    </button>
                    <div className="mt-1.5 flex items-center gap-1.5">
                      <OriginBadge task={task} />
                      <LabelChips task={task} />
                    </div>
                    <div className="mt-1.5">
                      <MoveSelect task={task} columns={columns} canMove={movable} onMove={onMove} />
                    </div>
                  </div>
                );
              })}
              {list.length === 0 && (
                <div className="rounded-md border border-dashed border-border p-3 text-center text-xs text-muted-foreground">
                  Drop tasks here
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
