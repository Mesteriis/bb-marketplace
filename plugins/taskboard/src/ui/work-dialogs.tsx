import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { Column, Task, TaskRun, TimeEntry, WorklogRecord } from "../core/index.ts";
import { messageOf, type Notify, type TaskboardApi } from "./api.ts";

const selectClass =
  "rounded-md border border-input bg-transparent px-2 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

interface TakeIntoWorkDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  task: Task | null;
  columns: Column[];
  api: TaskboardApi;
  notify: Notify;
  onTaken: (run: TaskRun) => void;
}

export function TakeIntoWorkDialog({ open, onOpenChange, task, columns, api, notify, onTaken }: TakeIntoWorkDialogProps) {
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  const [projectId, setProjectId] = useState("");
  const [startStatusId, setStartStatusId] = useState("");
  const [nextStatusId, setNextStatusId] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setLoading(true);
      const find = (name: string) => columns.find((column) => column.name.toLowerCase() === name.toLowerCase());
      setStartStatusId(find("In progress")?.id ?? columns[0]?.id ?? "");
      setNextStatusId(find("Review")?.id ?? find("Done")?.id ?? columns[columns.length - 1]?.id ?? "");
      api
        .listProjects()
        .then((list) => {
          setProjects(list);
          setProjectId(list[0]?.id ?? "");
        })
        .catch((error) => notify("error", messageOf(error)))
        .finally(() => setLoading(false));
    }
  }, [open, columns, api, notify]);

  const start = async () => {
    if (task === null) return;
    setBusy(true);
    try {
      const run = await api.takeIntoWork({ taskId: task.id, projectId, startStatusId, nextStatusId });
      onTaken(run);
      onOpenChange(false);
    } catch (error) {
      notify("error", messageOf(error));
    } finally {
      setBusy(false);
    }
  };

  const disabled = busy || loading || projectId === "" || startStatusId === "" || nextStatusId === "";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Take into work</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <label htmlFor="work-project" className="text-sm font-medium">Project</label>
            <select id="work-project" className={selectClass} value={projectId} onChange={(event) => setProjectId(event.target.value)}>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>{project.name}</option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="work-start" className="text-sm font-medium">Start status</label>
            <select id="work-start" className={selectClass} value={startStatusId} onChange={(event) => setStartStatusId(event.target.value)}>
              {columns.map((column) => <option key={column.id} value={column.id}>{column.name}</option>)}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="work-next" className="text-sm font-medium">Completion target</label>
            <select id="work-next" className={selectClass} value={nextStatusId} onChange={(event) => setNextStatusId(event.target.value)}>
              {columns.map((column) => <option key={column.id} value={column.id}>{column.name}</option>)}
            </select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={disabled} onClick={() => void start()}>{busy ? "Starting…" : "Start"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface TimeEntryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entry: TimeEntry | null;
  api: TaskboardApi;
  notify: Notify;
  onSubmitted: (worklog: WorklogRecord) => void;
}

export function TimeEntryDialog({ open, onOpenChange, entry, api, notify, onSubmitted }: TimeEntryDialogProps) {
  const [duration, setDuration] = useState(0);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open && entry) {
      setDuration(entry.durationSeconds);
      setComment(entry.comment);
    }
  }, [open, entry]);

  const saveDraft = async () => {
    if (!entry) return;
    try { await api.updateTimeEntry({ entryId: entry.id, durationSeconds: duration, comment }); } catch (error) { notify("error", messageOf(error)); }
  };

  const confirm = async () => {
    if (!entry) return;
    setBusy(true);
    try {
      const worklog = await api.submitTimeEntry({ entryId: entry.id, durationSeconds: duration, comment });
      onSubmitted(worklog);
      onOpenChange(false);
    } catch (error) {
      notify("error", messageOf(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) void saveDraft(); onOpenChange(next); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Log time</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <label htmlFor="time-duration" className="text-sm font-medium">Duration (seconds)</label>
            <Input id="time-duration" type="number" min={1} value={duration} onChange={(event) => setDuration(Number(event.target.value))} />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="time-comment" className="text-sm font-medium">Comment</label>
            <textarea id="time-comment" className="rounded-md border border-input bg-transparent px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" rows={3} value={comment} onChange={(event) => setComment(event.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => { void saveDraft(); onOpenChange(false); }}>Later</Button>
          <Button disabled={busy || duration < 1} onClick={() => void confirm()}>{busy ? "Submitting…" : "Confirm"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
