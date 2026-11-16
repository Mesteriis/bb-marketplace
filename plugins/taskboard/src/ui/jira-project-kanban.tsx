import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { Task, JiraTransition } from "../core/index.ts";
import type { JiraBoard, JiraProject, JiraKanbanColumn } from "../core/jira-kanban.ts";
import { messageOf, type TaskboardApi, type Notify } from "./api.ts";

type Snapshot = { columns: JiraKanbanColumn[]; items: { task: Task; statusId: string }[] };
const selectClass = "max-w-full rounded border border-input bg-background px-2 py-1.5 text-sm";

export function JiraProjectKanban({ connectionId, api, notify, onOpen, refreshKey }: { connectionId: string; api: TaskboardApi; notify: Notify; onOpen: (task: Task) => void; refreshKey?: number }) {
  const [projects, setProjects] = useState<JiraProject[]>([]);
  const [project, setProject] = useState("");
  const [boards, setBoards] = useState<JiraBoard[]>([]);
  const [boardId, setBoardId] = useState(0);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);
  const [query, setQuery] = useState("");
  const [choice, setChoice] = useState<{ task: Task; transitions: JiraTransition[] } | null>(null);
  useEffect(() => {
    let cancelled = false;
    api.jiraProjects?.(connectionId).then(result => { if (!cancelled) setProjects(result); }).catch(e => { if (!cancelled) setError(messageOf(e)); });
    return () => { cancelled = true; };
  }, [api, connectionId]);
  useEffect(() => {
    if (!project) return;
    let cancelled = false;
    setBusy(true); setError("");
    api.jiraBoards?.(connectionId, project).then(result => { if (!cancelled) { setBoards(result); setBoardId(result.length === 1 ? result[0].id : 0); } }).catch(e => { if (!cancelled) setError(messageOf(e)); }).finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, [api, connectionId, project]);
  useEffect(() => {
    if (!project || !boardId) return;
    let cancelled = false;
    setBusy(true); setError("");
    api.jiraKanban?.(connectionId, project, boardId).then(result => { if (!cancelled) setSnapshot(result); }).catch(e => { if (!cancelled) setError(messageOf(e)); }).finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, [api, connectionId, project, boardId, version, refreshKey]);

  async function transition(task: Task, id: string) {
    if (!task.originKey || busy) return;
    setBusy(true); setChoice(null);
    try { await api.applyTransition(connectionId, task.originKey, id); setVersion(v => v + 1); }
    catch (e) { notify("error", messageOf(e)); setVersion(v => v + 1); }
    finally { setBusy(false); }
  }
  async function move(task: Task, column: JiraKanbanColumn) {
    if (!task.originKey || busy) return;
    setBusy(true);
    try {
      const transitions = (await api.listTransitions(connectionId, task.originKey)).filter(t => t.toId && column.statusIds.includes(t.toId));
      if (!transitions.length) throw new Error("Jira does not allow a transition to this column");
      setChoice({ task, transitions });
    } catch (e) { notify("error", messageOf(e)); }
    finally { setBusy(false); }
  }
  const items = snapshot?.items.filter(item => (item.task.title + " " + item.task.originKey).toLowerCase().includes(query.toLowerCase())) ?? [];
  const unmapped = items.filter(item => !snapshot?.columns.some(column => column.statusIds.includes(item.statusId))).length;
  return <div className="flex h-full min-w-0 flex-col">
    <div className="flex flex-wrap gap-2 border-b border-border p-4">
      <select aria-label="Jira project" value={project} className={selectClass} onChange={e => { setBusy(false); setProject(e.target.value); setBoards([]); setBoardId(0); setSnapshot(null); setError(""); setChoice(null); }}>
        <option value="">Select a Jira project</option>
        {projects.map(p => <option key={p.key} value={p.key}>{p.key} — {p.name}</option>)}
      </select>
      {project && <select aria-label="Jira board" value={boardId} className={selectClass} onChange={e => { setBusy(false); setSnapshot(null); setBoardId(Number(e.target.value)); setChoice(null); }}>
        <option value={0}>Select a Jira Kanban board</option>
        {boards.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
      </select>}
      {snapshot && <><Input aria-label="Search board tasks" placeholder="Search board tasks" value={query} onChange={e => setQuery(e.target.value)} className="w-44" /><Button variant="outline" disabled={busy} onClick={() => setVersion(v => v + 1)}>Refresh Jira board</Button></>}
    </div>
    {error && <p role="alert" className="p-4 text-sm text-destructive">{error}</p>}
    {!project && <p className="p-8 text-sm text-muted-foreground">Select a Jira project to view Kanban. All assigned tasks are available in List.</p>}
    {project && !busy && !boards.length && !error && <p className="p-8 text-sm text-muted-foreground">No accessible Kanban boards for this project.</p>}
    {busy && <p className="p-4 text-sm text-muted-foreground">Loading Jira board…</p>}
    {snapshot && <>
      {unmapped > 0 && <p className="px-4 text-xs text-muted-foreground">{unmapped} issues have statuses outside this board's columns (backlog or unmapped).</p>}
      <div className="flex min-h-0 flex-1 gap-4 overflow-auto p-4">
        {snapshot.columns.map((column, index) => {
          const tasks = items.filter(item => column.statusIds.includes(item.statusId));
          return <section key={index} aria-label={column.name} className="w-72 shrink-0 rounded-lg border border-border bg-muted/40" onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); const task = items.find(i => i.task.id === e.dataTransfer.getData("text/plain"))?.task; if (task) void move(task, column); }}>
            <h2 className="p-3 text-sm font-semibold">{column.name} ({tasks.length}){column.min !== undefined && <span className="ml-2 text-xs font-normal">WIP min {column.min}</span>}{column.max !== undefined && <span className="ml-2 text-xs font-normal">WIP max {column.max}</span>}</h2>
            <div className="flex flex-col gap-2 p-2">{tasks.map(({ task, statusId }) => <div key={task.id} draggable={!busy} onDragStart={e => e.dataTransfer.setData("text/plain", task.id)} className="rounded border border-border bg-card p-3 shadow-sm">
              <button type="button" className="w-full break-words text-left text-sm" onClick={() => onOpen(task)}>{task.title}</button>
              <p className="mt-1 text-xs text-muted-foreground">{task.originKey}</p>
              <select aria-label={"Move " + task.originKey} disabled={busy} className={selectClass + " mt-2"} value={snapshot.columns.findIndex(c => c.statusIds.includes(statusId))} onChange={e => void move(task, snapshot.columns[Number(e.target.value)])}>
                {snapshot.columns.map((c, i) => <option key={i} value={i}>{c.name}</option>)}
              </select>
            </div>)}</div>
          </section>;
        })}
      </div>
    </>}
    <Dialog open={choice !== null} onOpenChange={open => { if (!open) setChoice(null); }}><DialogContent><DialogHeader><DialogTitle>Choose Jira transition</DialogTitle></DialogHeader>
      {choice?.transitions.map(t => <Button key={t.id} disabled={busy} onClick={() => void transition(choice.task, t.id)}>{t.name} → {t.toName}</Button>)}
    </DialogContent></Dialog>
  </div>;
}
