import { useEffect, useState } from "react";
import { message, type CiApi, type ThreadRef } from "./ci-api.ts";

/** Chooses threads of the copy's project; used to send a run and to subscribe to new failures. */
export function ThreadPicker({api, copyId, label, action, initial, onDone}: {
  api: CiApi; copyId: string; label: string; action: string;
  initial?: "subscribed"; onDone(threadIds: string[]): Promise<string | null>;
}) {
  const [threads, setThreads] = useState<ThreadRef[]>();
  const [chosen, setChosen] = useState<string[]>([]);
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    api.threads(copyId).then(result => {
      if (!active) return;
      setThreads(result.threads);
      if (initial === "subscribed") setChosen(result.subscribed);
    }, cause => { if (active) setError(message(cause)); });
    return () => { active = false; };
  }, [api, copyId, initial]);
  const toggle = (id: string) => setChosen(value => value.includes(id) ? value.filter(item => item !== id) : [...value, id]);
  const submit = async () => {
    setPending(true);
    setError("");
    try { setStatus(await onDone(chosen) ?? ""); }
    catch (cause) { setError(message(cause)); }
    finally { setPending(false); }
  };
  return <fieldset className="git-ci-threads git-stack">
    <legend>{label}</legend>
    {!threads && !error && <p className="git-muted" role="status">Loading threads…</p>}
    {threads?.length === 0 && <p className="git-muted">This project has no open threads.</p>}
    {threads && threads.length > 0 && <div className="git-ci-thread-list">{threads.map(thread =>
      <label key={thread.id}><input type="checkbox" checked={chosen.includes(thread.id)} onChange={() => toggle(thread.id)}/> {thread.title}</label>)}</div>}
    <div className="git-row">
      <button type="button" disabled={pending || !threads || (initial !== "subscribed" && !chosen.length)} onClick={() => void submit()}>{pending ? "Working…" : action}</button>
      {status && <span className="git-muted" role="status">{status}</span>}
    </div>
    {error && <p className="git-error" role="alert">{error}</p>}
  </fieldset>;
}
