import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { TimeEntry, WorklogRecord } from "../core/index.ts";
import { messageOf, type Notify, type TaskboardApi } from "./api.ts";

export function TaskWorklogs({ taskId, api, notify, onPrepared }: { taskId: string; api: TaskboardApi; notify: Notify; onPrepared: (entry: TimeEntry) => void }) {
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<WorklogRecord[] | null>(null);
  const prepare = async () => {
    if (!api.prepareWorklog || busy) return;
    setBusy(true);
    try { onPrepared(await api.prepareWorklog({ taskId, durationSeconds: 1800, comment: "" })); }
    catch (error) { notify("error", messageOf(error)); }
    finally { setBusy(false); }
  };
  const load = async () => {
    try { setHistory(await api.listWorklogs!(taskId)); }
    catch (error) { notify("error", messageOf(error)); }
  };
  return <div className="flex flex-col gap-2 border-t border-border pt-3">
    <span className="text-xs font-medium text-muted-foreground">Time tracking</span>
    {api.prepareWorklog && <Button variant="outline" size="sm" disabled={busy} onClick={() => void prepare()}>{busy ? "Preparing…" : "Log time"}</Button>}
    {api.listWorklogs && <Button variant="ghost" size="sm" onClick={() => void load()}>Refresh worklog history</Button>}
    {history !== null && <div aria-label="Worklog history" className="flex flex-col gap-2 text-xs">
      <p className="text-muted-foreground">Entries recorded through Taskboard</p>
      {history.length === 0 && <p>No time logged yet.</p>}
      {history.map((log) => <div key={log.id} className="rounded border border-border p-2">
        <p>{log.durationSeconds} seconds · {log.remote ? "Jira" : "Local"} · {new Date(log.startedAtIso).toLocaleString()}</p>
        <p className="whitespace-pre-wrap break-words">{log.comment}</p>
      </div>)}
    </div>}
  </div>;
}
