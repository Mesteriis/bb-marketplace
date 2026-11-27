import { useEffect, useState } from "react";
import { describeLocation, type ReviewThread } from "../../core/code-review/model.ts";
import { ExecutionChoice, useRunDefaults } from "./ai-runs.tsx";
import { message, severityLabel, type CodeReviewApi } from "./review-api.ts";

/**
 * Sends open comment threads to a thread working on this copy: the current thread in a thread's tab, or one picked
 * from the copy's threads; or "Fix in a new thread", an AI run on this copy. Threads still waiting for an answer
 * start unticked.
 */
export function SendForm({api, copyId, sessionId, threads, currentThreadId, onClose, onSent}: {
  api: CodeReviewApi; copyId: string; sessionId: string; threads: ReviewThread[]; currentThreadId?: string; onClose(): void; onSent(text: string): void;
}) {
  const open = threads.filter(thread => thread.status === "open");
  const [chosen, setChosen] = useState<string[]>(() => open.filter(thread => thread.delivery?.state !== "sent").map(thread => thread.id));
  const [note, setNote] = useState("");
  const [targets, setTargets] = useState<{id: string; title: string}[]>();
  const [target, setTarget] = useState(currentThreadId ?? "");
  const [pending, setPending] = useState(false);
  const [fresh, setFresh] = useState(false);
  const run = useRunDefaults(api, copyId, currentThreadId ?? null, fresh);
  const [error, setError] = useState("");
  useEffect(() => {
    if (currentThreadId) return;
    let active = true;
    api.targets(copyId).then(rows => { if (active) { setTargets(rows); setTarget(current => current || rows[0]?.id || ""); } },
      cause => { if (active) setError(message(cause)); });
    return () => { active = false; };
  }, [api, copyId, currentThreadId]);
  const toggle = (id: string) => setChosen(value => value.includes(id) ? value.filter(item => item !== id) : [...value, id]);
  const send = async () => {
    setPending(true); setError("");
    try {
      const plural = (count: number) => count + " comment thread" + (count === 1 ? "" : "s");
      if (fresh) {
        if (!run.execution) return;
        const {run: started, count} = await api.fix(sessionId, chosen, note, run.execution, currentThreadId ?? null);
        onSent(started.status !== "running" ? started.summary ?? "The run was closed before it started." : "Sent " + plural(count) + " to a new thread.");
      } else {
        const {count} = await api.send(sessionId, target, chosen, note);
        onSent("Sent " + plural(count) + " to the agent.");
      }
    } catch (cause) { setError(message(cause)); }
    finally { setPending(false); }
  };
  return <fieldset className="git-ci-threads git-stack" aria-label="Send to agent">
    <legend>Send to agent</legend>
    {!open.length && <p className="git-muted">There are no open comment threads.</p>}
    <div className="git-ci-thread-list">{open.map(thread => <label key={thread.id}>
      <input type="checkbox" checked={chosen.includes(thread.id)} onChange={() => toggle(thread.id)}/>{" "}
      {describeLocation(thread)}{thread.severity ? " · " + severityLabel[thread.severity] : ""}
      <span className="git-muted"> — {thread.comments.at(-1)?.body.split("\n")[0].slice(0, 80)}</span>
      {thread.delivery?.state === "sent" && <span className="git-muted"> (waiting for an answer)</span>}</label>)}</div>
    <label className="git-ci-thread-note">Review summary (optional)
      <textarea value={note} maxLength={20_000} onChange={event => setNote(event.target.value)}/></label>
    <div className="git-row" role="radiogroup" aria-label="Where to send">
      <label><input type="radio" checked={!fresh} onChange={() => setFresh(false)}/> {currentThreadId ? "This thread" : "A thread on this copy"}</label>
      <label><input type="radio" checked={fresh} onChange={() => setFresh(true)}/> Fix in a new thread</label>
    </div>
    {fresh ? <ExecutionChoice api={api} run={run} disabled={pending}/> : currentThreadId ? <p className="git-muted">To this thread.</p> : <label>To thread{" "}
      <select value={target} onChange={event => setTarget(event.target.value)} disabled={!targets?.length}>
        {targets?.map(row => <option key={row.id} value={row.id}>{row.title}</option>)}
      </select>
      {targets && !targets.length && <span className="git-muted"> No thread of this project works in this copy. Open a thread here first.</span>}
    </label>}
    <div className="git-row">
      <button type="button" className="git-primary" disabled={pending || !chosen.length || (fresh ? !run.execution : !target)} onClick={() => void send()}>{pending ? "Sending…" : "Send " + chosen.length}</button>
      <button type="button" onClick={onClose}>Close</button>
    </div>
    {error && <p className="git-error" role="alert">{error}</p>}
  </fieldset>;
}
