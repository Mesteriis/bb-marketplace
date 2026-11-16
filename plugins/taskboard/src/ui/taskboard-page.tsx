import { JiraProjectKanban } from "./jira-project-kanban.tsx";
import { groupTasksByProject, projectKeyForTask } from "../core/projects.ts";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { useIsCompactViewport } from "@/components/ui/hooks/use-compact-viewport";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { BoardView, Column, Connection, ConnectionCreateInput, ConnectionUpdateInput, Task, TaskRun, TimeEntry, WorklogRecord } from "../core/index.ts";
import { messageOf, noNotify, type Notify, type TaskboardApi } from "./api.ts";
import { BoardSettings, ConnectionForm, ConnectionsManager, TaskForm } from "./forms.tsx";
import { TaskDetails } from "./task-details.tsx";
import { KanbanView, ListView } from "./views.tsx";
import { TakeIntoWorkDialog, TimeEntryDialog } from "./work-dialogs.tsx";

interface TaskboardPageProps {
  api: TaskboardApi;
  notify?: Notify;
  /** Host navigation: opens a spawned thread. */
  openThread?: (threadId: string) => void;
}

type ViewMode = "list" | "kanban";

export function TaskboardPage({ api, notify = noNotify, openThread }: TaskboardPageProps) {
  const [boards, setBoards] = useState<BoardView[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [activeBoardId, setActiveBoardId] = useState<string | null>(null);
  const [columns, setColumns] = useState<Column[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [tasksLoading, setTasksLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tasksVersion, setTasksVersion] = useState(0);
  const [view, setView] = useState<ViewMode>("list");
  const [detailsTaskId, setDetailsTaskId] = useState<string | null>(null);
  const [taskForm, setTaskForm] = useState<{ task: Task | null } | null>(null);
  const [connectionForm, setConnectionForm] = useState<{ connection: Connection | null } | null>(null);
  const [manageConnections, setManageConnections] = useState(false);
  const [boardFormOpen, setBoardFormOpen] = useState(false);
  const [boardName, setBoardName] = useState("");
  const [confirmDeleteBoard, setConfirmDeleteBoard] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [busyConnectionId, setBusyConnectionId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [originFilter, setOriginFilter] = useState<"all" | "local" | "jira">("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [labelFilter, setLabelFilter] = useState<string>("all");
  const [workDialogTask, setWorkDialogTask] = useState<Task | null>(null);
  const [timeEntry, setTimeEntry] = useState<TimeEntry | null>(null);
  const [activeRun, setActiveRun] = useState<TaskRun | null>(null);
  const [cancelableRun, setCancelableRun] = useState<TaskRun | null>(null);
  const [timeEntries, setTimeEntries] = useState<TimeEntry[]>([]);
  const [autoOpenedEntryId, setAutoOpenedEntryId] = useState<string | null>(null);
  const isCompact = useIsCompactViewport();
  const [pendingMoves, setPendingMoves] = useState<Set<string>>(new Set());

  const activeBoard = boards.find((board) => board.id === activeBoardId) ?? null;
  const activeConnection =
    activeBoard?.connectionId != null ? connections.find((connection) => connection.id === activeBoard.connectionId) ?? null : null;
  const connectionPresent = activeBoard?.connectionId != null && activeConnection !== null;
  const isRemoteBoard = activeBoard?.connectionId != null || tasks.some((task) => task.origin === "jira");
  const detailsTask = tasks.find((task) => task.id === detailsTaskId) ?? null;
  const pendingEntry = detailsTaskId !== null ? timeEntries.find((entry) => entry.taskId === detailsTaskId && entry.state === "pending") ?? null : null;
  const failedEntry = detailsTaskId !== null ? timeEntries.find((entry) => entry.taskId === detailsTaskId && entry.state === "failed") ?? null : null;
  const unknownEntry = detailsTaskId !== null ? timeEntries.find((entry) => entry.taskId === detailsTaskId && entry.state === "unknown") ?? null : null;

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [nextBoards, nextConnections] = await Promise.all([api.listBoards(), api.listConnections()]);
      setBoards(nextBoards);
      setConnections(nextConnections);
      setActiveBoardId((previous) => {
        if (previous !== null && nextBoards.some((board) => board.id === previous)) return previous;
        return nextBoards[0]?.id ?? null;
      });
    } catch (error) {
      setLoadError(messageOf(error));
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (activeBoardId === null) {
      setColumns([]);
      setTasks([]);
      return;
    }
    let cancelled = false;
    // Clear the previous board's tasks so a failed load never shows them.
    setColumns([]);
    setTasks([]);
    setTasksLoading(true);
    api
      .listTasks(activeBoardId)
      .then((result) => {
        if (!cancelled) {
          setColumns(result.columns);
          setTasks(result.tasks);
        }
      })
      .catch((error) => {
        if (!cancelled) notify("error", messageOf(error));
      })
      .finally(() => {
        if (!cancelled) setTasksLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api, activeBoardId, tasksVersion, notify]);

  useEffect(() => {
    if (detailsTaskId === null) {
      setActiveRun(null);
      return;
    }
    let cancelled = false;
    const tick = () => {
      api
        .listRuns(detailsTaskId)
        .then((runs) => {
          if (!cancelled) {
            setActiveRun(runs.find((run) => run.state === "active") ?? null);
            setCancelableRun(runs.find((run) => (run.state === "failed" || run.state === "provisioning") && run.threadId === null) ?? null);
          }
        })
        .catch(() => {});
      api
        .listTimeEntriesByTask(detailsTaskId)
        .then((entries) => { if (!cancelled) setTimeEntries(entries); })
        .catch(() => {});
    };
    tick();
    const timer = setInterval(tick, 5000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [api, detailsTaskId]);

  useEffect(() => {
    if (pendingEntry !== null && pendingEntry.state === "pending" && autoOpenedEntryId !== pendingEntry.id) {
      setAutoOpenedEntryId(pendingEntry.id);
      setTimeEntry(pendingEntry);
    }
  }, [pendingEntry, autoOpenedEntryId]);

  const reloadTasks = useCallback(() => setTasksVersion((version) => version + 1), []);

  const [projectFilter, setProjectFilter] = useState("all");
  const filteredTasks = useMemo(() => {
    const query = search.trim().toLowerCase();
    return tasks.filter((task) => {
      if (task.inScope === false) return false;
      if (projectFilter !== "all" && projectKeyForTask(task) !== projectFilter) return false;
      if (originFilter !== "all" && task.origin !== originFilter) return false;
      if (statusFilter !== "all" && task.status !== statusFilter) return false;
      if (labelFilter !== "all" && !task.labels.includes(labelFilter)) return false;
      if (query !== "") {
        const hay = (task.title + " " + task.description + " " + (task.originKey ?? "") + " " + task.labels.join(" ")).toLowerCase();
        if (!hay.includes(query)) return false;
      }
      return true;
    });
  }, [tasks, search, originFilter, statusFilter, labelFilter, projectFilter]);

  const allLabels = useMemo(() => [...new Set(tasks.filter((task) => task.inScope !== false).flatMap((task) => task.labels))].sort(), [tasks]);
  const filtersActive = projectFilter !== "all" || search.trim() !== "" || originFilter !== "all" || statusFilter !== "all" || labelFilter !== "all";

  const canMove = useCallback((task: Task) => !pendingMoves.has(task.id) && (task.origin === "local" || connectionPresent), [connectionPresent, pendingMoves]);

  const createBoard = useCallback(async () => {
    const name = boardName.trim();
    if (name === "") return;
    try {
      const board = await api.createBoard(name);
      setBoards((previous) => [...previous, board]);
      setActiveBoardId(board.id);
      setBoardName("");
      setBoardFormOpen(false);
      notify("success", "Board created");
    } catch (error) {
      notify("error", messageOf(error));
    }
  }, [api, boardName, notify]);

  const deleteActiveBoard = useCallback(async () => {
    if (activeBoardId === null) return;
    if (!confirmDeleteBoard) {
      setConfirmDeleteBoard(true);
      return;
    }
    try {
      await api.deleteBoard(activeBoardId);
      setConfirmDeleteBoard(false);
      setDetailsTaskId(null);
      await load();
      notify("success", "Board deleted");
    } catch (error) {
      setConfirmDeleteBoard(false);
      notify("error", messageOf(error));
    }
  }, [activeBoardId, api, confirmDeleteBoard, load, notify]);

  const moveTask = useCallback(async (taskId: string, status: string) => {
    // Serialize per task: no overlapping moves for the same task.
    if (pendingMoves.has(taskId)) return;
    const before = tasks.find((task) => task.id === taskId);
    if (before === undefined || before.status === status) return;
    setPendingMoves((previous) => new Set(previous).add(taskId));
    setTasks((previous) => previous.map((task) => (task.id === taskId ? { ...task, status } : task)));
    try {
      const moved = await api.moveTask(taskId, status);
      setTasks((previous) => previous.map((task) => (task.id === taskId ? moved : task)));
    } catch (error) {
      notify("error", messageOf(error));
      // Reconcile against the confirmed server state after any rejection.
      reloadTasks();
    } finally {
      setPendingMoves((previous) => {
        const next = new Set(previous);
        next.delete(taskId);
        return next;
      });
    }
  }, [api, notify, pendingMoves, reloadTasks, tasks]);

  const saveTask = useCallback(async (input: { title: string; description: string; status?: string }) => {
    if (taskForm === null || activeBoardId === null) return;
    if (taskForm.task === null) {
      const task = await api.createTask({ boardId: activeBoardId, title: input.title, description: input.description, status: input.status });
      setTasks((previous) => [...previous, task]);
    } else {
      const before = taskForm.task;
      let updated = await api.updateTask({ taskId: before.id, title: input.title, description: input.description });
      if (input.status !== undefined && input.status !== before.status) {
        updated = await api.moveTask(before.id, input.status);
      }
      setTasks((previous) => previous.map((task) => (task.id === updated.id ? updated : task)));
    }
  }, [activeBoardId, api, taskForm]);

  const deleteTask = useCallback(async (taskId: string) => {
    try {
      await api.deleteTask(taskId);
      setTasks((previous) => previous.filter((task) => task.id !== taskId));
      if (detailsTaskId === taskId) setDetailsTaskId(null);
    } catch (error) {
      notify("error", messageOf(error));
    }
  }, [api, detailsTaskId, notify]);

  const saveConnection = useCallback(async (input: ConnectionCreateInput | ConnectionUpdateInput) => {
    if ("connectionId" in input) {
      const updated = await api.updateConnection(input);
      setConnections((previous) => previous.map((connection) => (connection.id === updated.id ? updated : connection)));
    } else {
      const created = await api.createConnection(input);
      setConnections((previous) => [...previous, created]);
    }
  }, [api]);

  const deleteConnection = useCallback(async (connectionId: string) => {
    try {
      await api.deleteConnection(connectionId);
      setConnections((previous) => previous.filter((connection) => connection.id !== connectionId));
      notify("success", "Connection deleted");
    } catch (error) {
      notify("error", messageOf(error));
    }
  }, [api, notify]);

  const testConnection = useCallback(async (connectionId: string) => {
    try {
      await api.testConnection(connectionId);
      notify("success", "Connection works");
    } catch (error) {
      notify("error", messageOf(error));
    }
  }, [api, notify]);

  const fetchIssuesFor = useCallback(async (connectionId: string) => {
    setBusyConnectionId(connectionId);
    try {
      const result = await api.fetchIssues(connectionId);
      notify("success", "Imported " + result.imported + " issues" + (result.truncated ? " (more available)" : ""));
      const nextBoards = await api.listBoards();
      setBoards(nextBoards);
      const bound = nextBoards.find((board) => board.connectionId === connectionId);
      if (bound !== undefined) setActiveBoardId(bound.id);
      setTasksVersion((version) => version + 1);
    } catch (error) {
      notify("error", messageOf(error));
    } finally {
      setBusyConnectionId(null);
    }
  }, [api, notify]);

  const applyTransition = useCallback(async (transitionId: string) => {
    if (detailsTask === null || detailsTask.originKey === null) return;
    const connectionId = activeBoard?.connectionId ?? null;
    if (connectionId === null) return;
    try {
      const updated = await api.applyTransition(connectionId, detailsTask.originKey, transitionId);
      notify("success", "Status updated");
      // Reload so a newly-created destination column appears.
      setTasks((previous) => previous.map((task) => (task.id === updated.id ? updated : task)));
      reloadTasks();
    } catch (error) {
      notify("error", messageOf(error));
    }
  }, [activeBoard?.connectionId, api, detailsTask, notify, reloadTasks]);

  const onTaken = useCallback((run: TaskRun) => {
    setActiveRun(run);
    notify("success", "Work started");
    reloadTasks();
    if (run.threadId !== null) openThread?.(run.threadId);
  }, [notify, openThread, reloadTasks]);

  const onComplete = useCallback(async () => {
    if (activeRun === null) return;
    try {
      const entry = await api.completeRun({ runId: activeRun.id });
      setTimeEntry(entry);
      setActiveRun(null);
      reloadTasks();
    } catch (error) {
      notify("error", messageOf(error));
    }
  }, [activeRun, api, notify, reloadTasks]);

  const onTimeSubmitted = useCallback((worklog: WorklogRecord) => {
    notify("success", worklog.remote ? "Time logged in Jira" : "Time logged locally");
    setTimeEntries((previous) => previous.filter((entry) => entry.id !== timeEntry?.id));
    setTimeEntry(null);
  }, [notify, timeEntry]);

  const onRetryTime = useCallback(async () => {
    if (failedEntry === null || detailsTaskId === null) return;
    try {
      await api.retryTimeEntry(failedEntry.id);
      setTimeEntries(await api.listTimeEntriesByTask(detailsTaskId));
    } catch (error) { notify("error", messageOf(error)); }
  }, [api, detailsTaskId, failedEntry, notify]);

  const onCancelRun = useCallback(async () => {
    if (cancelableRun === null || detailsTaskId === null) return;
    try {
      await api.cancelRun(cancelableRun.id);
      notify("success", "Run cancelled");
      setCancelableRun(null);
      const runs = await api.listRuns(detailsTaskId);
      setActiveRun(runs.find((run) => run.state === "active") ?? null);
    } catch (error) { notify("error", messageOf(error)); }
  }, [api, cancelableRun, detailsTaskId, notify]);

  const onResolveTime = useCallback(async () => {
    if (unknownEntry === null || detailsTaskId === null) return;
    try {
      await api.resolveTimeEntry({ entryId: unknownEntry.id });
      notify("success", "Time marked as logged");
      setTimeEntries(await api.listTimeEntriesByTask(detailsTaskId));
    } catch (error) { notify("error", messageOf(error)); }
  }, [api, detailsTaskId, notify, unknownEntry]);

  const saveBoardSettings = useCallback(async (input: { name: string; columns: { id?: string; name: string; order: number }[] }) => {
    if (activeBoardId === null) return;
    const updated = await api.updateBoard({ boardId: activeBoardId, name: input.name, columns: input.columns });
    setBoards((previous) => previous.map((board) => (board.id === updated.id ? updated : board)));
    setTasksVersion((version) => version + 1);
    notify("success", "Board updated");
  }, [activeBoardId, api, notify]);

  const clearFilters = useCallback(() => {
    setSearch("");
    setProjectFilter("all");
    setOriginFilter("all");
    setStatusFilter("all");
    setLabelFilter("all");
  }, []);

  if (loading) {
    return <div className="flex h-full items-center justify-center p-8 text-sm text-muted-foreground">Loading…</div>;
  }

  if (loadError !== null && boards.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-sm text-destructive">
        {loadError}
      </div>
    );
  }

  const dialogs = (
    <>
      <TaskForm
        open={taskForm !== null}
        onOpenChange={(open) => { if (!open) setTaskForm(null); }}
        initial={taskForm?.task ? { title: taskForm.task.title, description: taskForm.task.description, status: taskForm.task.status } : null}
        columns={columns}
        notify={notify}
        onSave={saveTask}
      />
      <ConnectionForm open={connectionForm !== null} onOpenChange={(open) => { if (!open) setConnectionForm(null); }} initial={connectionForm?.connection ?? null} notify={notify} onSave={saveConnection} />
      <ConnectionsManager
        open={manageConnections}
        onOpenChange={setManageConnections}
        connections={connections}
        busyConnectionId={busyConnectionId}
        onNew={() => { setManageConnections(false); setConnectionForm({ connection: null }); }}
        onEdit={(connection) => { setManageConnections(false); setConnectionForm({ connection }); }}
        onDelete={(id) => void deleteConnection(id)}
        onTest={(id) => void testConnection(id)}
        onFetch={(id) => void fetchIssuesFor(id)}
      />
      {activeBoard !== null && (
        <BoardSettings open={settingsOpen} onOpenChange={setSettingsOpen} board={activeBoard} readonlyColumns={isRemoteBoard} notify={notify} onSave={saveBoardSettings} />
      )}
      <TakeIntoWorkDialog open={workDialogTask !== null} onOpenChange={(open) => { if (!open) setWorkDialogTask(null); }} task={workDialogTask} columns={columns} api={api} notify={notify} onTaken={onTaken} />
      <TimeEntryDialog open={timeEntry !== null} onOpenChange={(open) => { if (!open) setTimeEntry(null); }} entry={timeEntry} api={api} notify={notify} onSubmitted={onTimeSubmitted} />
    </>
  );

  if (boards.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <p className="text-sm text-muted-foreground">No boards yet.</p>
        <p className="text-xs text-muted-foreground">Create a local board, or add a Jira connection and fetch issues.</p>
        <div className="flex gap-2">
          <Button onClick={() => setBoardFormOpen(true)}>New board</Button>
          <Button variant="outline" onClick={() => setManageConnections(true)}>Add Jira connection</Button>
        </div>
        {boardFormOpen && (
          <div className="flex items-center gap-2">
            <Input autoFocus value={boardName} onChange={(event) => setBoardName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void createBoard(); }} placeholder="Board name" aria-label="Board name" />
            <Button onClick={() => void createBoard()}>Create</Button>
            <Button variant="ghost" onClick={() => { setBoardFormOpen(false); setBoardName(""); }}>Cancel</Button>
          </div>
        )}
        {dialogs}
      </div>
    );
  }

  return (
    <div className="relative flex h-full flex-col overflow-x-hidden" data-taskboard-root>
      <header className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2">
        <select
          aria-label="Board"
          className="rounded-md border border-input bg-transparent px-2 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          value={activeBoardId ?? ""}
          onChange={(event) => {
            setActiveBoardId(event.target.value);
            setProjectFilter("all");
            setDetailsTaskId(null);
            setConfirmDeleteBoard(false);
          }}
        >
          {boards.map((board) => (
            <option key={board.id} value={board.id}>{board.name}</option>
          ))}
        </select>
        <Button variant="ghost" size="sm" onClick={() => setBoardFormOpen(true)}>New board</Button>
        {!isRemoteBoard && <Button variant="ghost" size="sm" onClick={() => setSettingsOpen(true)}>Board settings</Button>}
        <Button variant="ghost" size="sm" className={cn(confirmDeleteBoard && "text-destructive")} onClick={() => void deleteActiveBoard()}>
          {confirmDeleteBoard ? "Really delete?" : "Delete board"}
        </Button>
        {boardFormOpen && (
          <div className="flex items-center gap-1">
            <Input autoFocus value={boardName} onChange={(event) => setBoardName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void createBoard(); }} placeholder="Board name" aria-label="New board name" className="h-8" />
            <Button size="sm" onClick={() => void createBoard()}>Create</Button>
            <Button size="sm" variant="ghost" onClick={() => { setBoardFormOpen(false); setBoardName(""); }}>Cancel</Button>
          </div>
        )}
        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
          <div className="flex rounded-md border border-input p-0.5" role="group" aria-label="View">
            <button type="button" aria-pressed={view === "list"} className={cn("rounded px-2.5 py-1 text-xs font-medium", view === "list" ? "bg-secondary" : "text-muted-foreground")} onClick={() => setView("list")}>List</button>
            <button type="button" aria-pressed={view === "kanban"} className={cn("rounded px-2.5 py-1 text-xs font-medium", view === "kanban" ? "bg-secondary" : "text-muted-foreground")} onClick={() => setView("kanban")}>Board</button>
          </div>
          {(view === "list" || !isRemoteBoard) && <Button size="sm" onClick={() => setTaskForm({ task: null })}>New task</Button>}
          {view === "list" && activeBoard?.connectionId != null && activeConnection != null && (
            <Button size="sm" variant="outline" disabled={busyConnectionId === activeBoard.connectionId} onClick={() => void fetchIssuesFor(activeBoard.connectionId!)}>
              {busyConnectionId === activeBoard.connectionId ? "Fetching…" : "Fetch issues"}
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={() => setManageConnections(true)}>Connections</Button>
        </div>
      </header>

      {(view === "list" || !isRemoteBoard) && <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2">
        <Input placeholder="Search tasks" aria-label="Search tasks" value={search} onChange={(event) => setSearch(event.target.value)} className="h-8 w-40 max-w-full" />
        <select aria-label="Project filter" className="h-8 max-w-full rounded-md border border-input bg-transparent px-2 text-xs" value={projectFilter} onChange={(e) => setProjectFilter(e.target.value)}>
          <option value="all">All projects</option>
          {groupTasksByProject(tasks.filter(t => t.inScope !== false)).map(g => <option key={g.project} value={g.project}>{g.project}</option>)}
        </select>
        <select aria-label="Origin filter" className="h-8 rounded-md border border-input bg-transparent px-2 text-xs" value={originFilter} onChange={(event) => setOriginFilter(event.target.value as "all" | "local" | "jira")}>
          <option value="all">All origins</option>
          <option value="local">Local</option>
          <option value="jira">Jira</option>
        </select>
        <select aria-label="Status filter" className="h-8 rounded-md border border-input bg-transparent px-2 text-xs" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
          <option value="all">All statuses</option>
          {columns.map((column) => (
            <option key={column.id} value={column.id}>{column.name}</option>
          ))}
        </select>
        <select aria-label="Label filter" className="h-8 rounded-md border border-input bg-transparent px-2 text-xs" value={labelFilter} onChange={(event) => setLabelFilter(event.target.value)}>
          <option value="all">All labels</option>
          {allLabels.map((label) => (
            <option key={label} value={label}>{label}</option>
          ))}
        </select>
        {filtersActive && <Button variant="ghost" size="sm" onClick={clearFilters}>Clear</Button>}
      </div>}

      <div className="flex min-h-0 flex-1">
        <main className="min-w-0 flex-1 overflow-auto">
          {view === "kanban" && isRemoteBoard ? (
            activeBoard?.connectionId && connectionPresent ? <JiraProjectKanban key={activeBoard.connectionId} connectionId={activeBoard.connectionId} api={api} refreshKey={tasksVersion} notify={notify} onOpen={(task) => { setTasks(previous => [...previous.filter(t => t.id !== task.id), task]); setDetailsTaskId(task.id); if (activeBoardId) void api.listTasks(activeBoardId).then(result => { setTasks(result.tasks); setColumns(result.columns); }).catch(error => notify("error", messageOf(error))); }} /> : <p className="p-8 text-sm text-muted-foreground">Connect Jira to view the project Kanban.</p>
          ) : tasksLoading ? (
            <div className="flex h-full items-center justify-center p-8 text-sm text-muted-foreground">Loading tasks…</div>
          ) : filteredTasks.length === 0 ? (
            <p className="p-8 text-center text-sm text-muted-foreground">{filtersActive ? "No tasks match these filters." : "No tasks yet."}</p>
          ) : groupTasksByProject(filteredTasks).map((group) => (
            <section key={group.project} aria-label={"Project " + group.project}>
              <h2 className="px-4 pt-4 text-sm font-semibold">{group.project}</h2>
              {view === "list" ? <ListView tasks={group.tasks} columns={columns} canMove={canMove} onOpen={(task) => setDetailsTaskId(task.id)} onMove={(id, status) => void moveTask(id, status)} /> : <KanbanView tasks={group.tasks} columns={columns} canMove={canMove} onOpen={(task) => setDetailsTaskId(task.id)} onMove={(id, status) => void moveTask(id, status)} />}
            </section>
          ))}
        </main>
        {detailsTask !== null && !isCompact && (
          <TaskDetails
            task={detailsTask}
            columns={columns}
            connectionId={activeBoard?.connectionId ?? null}
            connectionPresent={connectionPresent}
            api={api}
            notify={notify}
            onMove={(id, status) => void moveTask(id, status)}
            onApplyTransition={(transitionId) => applyTransition(transitionId)}
            onEdit={(task) => setTaskForm({ task })}
            onDelete={(id) => void deleteTask(id)}
            run={activeRun}
            cancelableRun={cancelableRun}
            pendingEntry={pendingEntry}
            failedEntry={failedEntry}
            unknownEntry={unknownEntry}
            onTakeIntoWork={() => setWorkDialogTask(detailsTask)}
            onComplete={() => void onComplete()}
            onCancelRun={() => void onCancelRun()}
            onRetryTime={() => void onRetryTime()}
            onResolveTime={() => void onResolveTime()}
            onPreparedTimeEntry={(entry) => { setAutoOpenedEntryId(entry.id); setTimeEntry(entry); }}
            onOpenTimeEntry={() => { if (pendingEntry !== null) setTimeEntry(pendingEntry); }}
            onClose={() => setDetailsTaskId(null)}
          />
        )}
      </div>

      {isCompact && detailsTask !== null && (
        <div className="absolute inset-0 z-40 bg-background">
          <TaskDetails
            task={detailsTask}
            columns={columns}
            connectionId={activeBoard?.connectionId ?? null}
            connectionPresent={connectionPresent}
            fill
            api={api}
            notify={notify}
            onMove={(id, status) => void moveTask(id, status)}
            onApplyTransition={(transitionId) => applyTransition(transitionId)}
            onEdit={(task) => setTaskForm({ task })}
            onDelete={(id) => void deleteTask(id)}
            run={activeRun}
            cancelableRun={cancelableRun}
            pendingEntry={pendingEntry}
            failedEntry={failedEntry}
            unknownEntry={unknownEntry}
            onTakeIntoWork={() => setWorkDialogTask(detailsTask)}
            onComplete={() => void onComplete()}
            onCancelRun={() => void onCancelRun()}
            onRetryTime={() => void onRetryTime()}
            onResolveTime={() => void onResolveTime()}
            onPreparedTimeEntry={(entry) => { setAutoOpenedEntryId(entry.id); setTimeEntry(entry); }}
            onOpenTimeEntry={() => { if (pendingEntry !== null) setTimeEntry(pendingEntry); }}
            onClose={() => setDetailsTaskId(null)}
          />
        </div>
      )}

      {dialogs}
    </div>
  );
}
