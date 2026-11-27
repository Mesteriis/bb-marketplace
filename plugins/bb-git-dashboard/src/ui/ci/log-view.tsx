import { useEffect, useMemo, useRef, useState } from "react";
import { filterLines } from "../../core/ci/log.ts";
import { isActive, type Job } from "../../core/ci/model.ts";
import type { JobLog } from "../../core/ci/pipelines.ts";
import { message, type CiApi } from "./ci-api.ts";

const livePoll = 5_000;

/**
 * A job log opened at its error line; polled while the job runs where the forge streams logs. A filter keeps the
 * lines with every word; Follow the end keeps the newest line in view while the log grows.
 */
export function LogView({api, copyId, runId, job, liveLog, liveLimitation}: {
  api: CiApi; copyId: string; runId: string; job: Job; liveLog: boolean; liveLimitation: string | null;
}) {
  const [log, setLog] = useState<JobLog | undefined>();
  const [errorAt, setErrorAt] = useState<number | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [follow, setFollow] = useState(false);
  const [copied, setCopied] = useState("");
  const pane = useRef<HTMLPreElement>(null);
  const marker = useRef<HTMLSpanElement>(null);
  const placed = useRef<number | null>(null);
  const running = isActive(job.state);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () => api.log(copyId, runId, job.id).then(result => {
      if (!active) return;
      setLog(result.log);
      setErrorAt(result.errorLine);
      setNotes(result.notes);
      setError("");
      if (running && liveLog) timer = setTimeout(load, livePoll);
    }, cause => { if (active) setError(message(cause)); });
    if (!running || liveLog) void load();
    return () => { active = false; clearTimeout(timer); };
  }, [api, copyId, runId, job.id, running, liveLog]);
  // Scroll only the log itself: scrollIntoView would also move the page and hide the panel header.
  // Only when the error line first appears or moves, so live polling does not undo the user's own scrolling.
  useEffect(() => {
    const line = marker.current;
    const box = line?.closest("pre");
    if (follow || !line || !box || placed.current === errorAt) return;
    box.scrollTop = line.offsetTop - box.clientHeight / 2;
    placed.current = errorAt;
  }, [errorAt, log, follow]);
  useEffect(() => {
    if (follow && pane.current) pane.current.scrollTop = pane.current.scrollHeight;
  }, [follow, log, query]);
  const lines = useMemo(() => log ? log.text.replace(/\n$/, "").split("\n") : [], [log]);
  const shown = useMemo(() => filterLines(lines, query), [lines, query]);

  if (running && !liveLog) return <p className="git-muted" role="status">{liveLimitation ?? "The log is available when the job ends."}</p>;
  if (error) return <p className="git-error" role="alert">{error}</p>;
  if (log === undefined) return <p className="git-muted" role="status">Loading log…</p>;
  if (log === null) return notes.length
    ? <div className="git-stack" role="status"><p>The forge reports for this job:</p><ul className="git-ci-lines">{notes.map((note, index) => <li key={index}>{note}</li>)}</ul></div>
    : <p className="git-muted" role="status">The forge has not published a log for this job yet.</p>;
  const filtering = query.trim().length > 0;
  return <div className="git-stack">
    <div className="git-row git-ci-log-tools">
      <input type="search" aria-label="Filter log lines" placeholder="Filter" value={query} onChange={event => setQuery(event.target.value)}/>
      {filtering && <span className="git-muted" role="status">{shown.length} of {lines.length} lines</span>}
      <label><input type="checkbox" checked={follow} onChange={event => setFollow(event.target.checked)}/> Follow the end</label>
      <button type="button" onClick={() => void api.copy(log.text).then(done => setCopied(done ? "Log copied." : "The browser did not allow copying."))}>Copy log</button>
      {job.url && <a href={job.url} target="_blank" rel="noreferrer">Open job on the forge</a>}
      {copied && <span className="git-muted" role="status">{copied}</span>}
    </div>
    {notes.length > 0 && <ul className="git-ci-lines" aria-label="Annotations">{notes.map((note, index) => <li key={index}>{note}</li>)}</ul>}
    {log.truncated && <p className="git-muted">Showing the end of a long log.</p>}
    {errorAt !== null && <p className="git-muted">Opened at the error on line {errorAt + 1}.</p>}
    <pre ref={pane} className="git-code git-ci-log" aria-label={"Log of " + job.name}>{shown.map(index =>
      <span key={index} className="git-ci-line" data-error={index === errorAt || undefined} ref={index === errorAt ? marker : undefined}>
        <span className="git-ci-number" aria-hidden="true">{index + 1}</span>{lines[index] + "\n"}</span>)}</pre>
    {filtering && !shown.length && <p className="git-muted">No line contains every word of the filter.</p>}
  </div>;
}
