import { useEffect, useState } from "react";
import { message, type CiApi, type ThreadRef } from "./ci-api.ts";

/** What a failed run is sent with unless the owner writes something else. */
export const defaultNote = "This CI run failed. Please find the cause and fix it.";
const recentKey = (copyId: string) => "git-ci-recent/" + copyId;
const recentLimit = 5;

function recent(copyId: string): string[] {
  try { return (JSON.parse(localStorage.getItem(recentKey(copyId)) ?? "[]") as unknown[]).filter(id => typeof id === "string"); }
  catch { return []; }
}
function remember(copyId: string, threadIds: string[]) {
  const next = [...new Set([...threadIds, ...recent(copyId)])].slice(0, recentLimit);
  try { localStorage.setItem(recentKey(copyId), JSON.stringify(next)); } catch { /* not persisted */ }
}

type SendOptions = {note: string; includeLogs: boolean};

/**
 * Chooses threads of the copy's project; used to send a run and to subscribe to new failures. With `compose` the
 * owner also writes a message and decides whether the failed jobs' log excerpts go along; the last recipients are
 * chosen again next time.
 */
export function ThreadPicker({api, copyId, label, action, initial, compose, onDone}: {
  api: CiApi; copyId: string; label: string; action: string;
  initial?: "subscribed"; compose?: {note: string}; onDone(threadIds: string[], options: SendOptions): Promise<string | null>;
}) {
  const [threads, setThreads] = useState<ThreadRef[]>();
  const [chosen, setChosen] = useState<string[]>([]);
  const [note, setNote] = useState(compose?.note ?? "");
  const [includeLogs, setIncludeLogs] = useState(true);
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    api.threads(copyId).then(result => {
      if (!active) return;
      setThreads(result.threads);
      if (initial === "subscribed") setChosen(result.subscribed);
      else if (compose) setChosen(recent(copyId).filter(id => result.threads.some(thread => thread.id === id)));
    }, cause => { if (active) setError(message(cause)); });
    return () => { active = false; };
    // `compose` is read once, when the picker opens.
  }, [api, copyId, initial]);
  const toggle = (id: string) => setChosen(value => value.includes(id) ? value.filter(item => item !== id) : [...value, id]);
  const submit = async () => {
    setPending(true);
    setError("");
    try {
      setStatus(await onDone(chosen, {note, includeLogs}) ?? "");
      if (compose) remember(copyId, chosen);
    } catch (cause) { setError(message(cause)); }
    finally { setPending(false); }
  };
  return <fieldset className="git-ci-threads git-stack">
    <legend>{label}</legend>
    {!threads && !error && <p className="git-muted" role="status">Loading threads…</p>}
    {threads?.length === 0 && <p className="git-muted">This project has no open threads.</p>}
    {threads && threads.length > 0 && <div className="git-ci-thread-list">{threads.map(thread =>
      <label key={thread.id}><input type="checkbox" checked={chosen.includes(thread.id)} onChange={() => toggle(thread.id)}/> {thread.title}</label>)}</div>}
    {compose && <>
      <label className="git-ci-thread-note">Add a message (optional)
        <textarea value={note} maxLength={2000} onChange={event => setNote(event.target.value)}/></label>
      <label><input type="checkbox" checked={includeLogs} onChange={event => setIncludeLogs(event.target.checked)}/> Include log excerpts of failed jobs</label>
    </>}
    <div className="git-row">
      <button type="button" disabled={pending || !threads || (initial !== "subscribed" && !chosen.length)} onClick={() => void submit()}>{pending ? "Working…" : action}</button>
      {status && <span className="git-muted" role="status">{status}</span>}
    </div>
    {error && <p className="git-error" role="alert">{error}</p>}
  </fieldset>;
}
