import { useEffect, useMemo, useRef, useState } from "react";
import { filterLines } from "../../core/ci/log.ts";
import { isActive, type Job } from "../../core/ci/model.ts";
import type { JobLog } from "../../core/ci/pipelines.ts";
import { message, type CiApi } from "./ci-api.ts";
import { useT } from "../i18n/use-t.tsx";
import { Icon } from "../system/icon.tsx";

const livePoll = 5_000;

/**
 * A job log opened at its error line; polled while the job runs where the forge streams logs. A filter keeps the
 * lines with every word; Follow the end keeps the newest line in view while the log grows.
 */
export function LogView({api, copyId, runId, job, liveLog, liveLimitation}: {
  api: CiApi; copyId: string; runId: string; job: Job; liveLog: boolean; liveLimitation: string | null;
}) {
  const t = useT();
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

  if (running && !liveLog) return <p className="g-state-page" role="status">{liveLimitation ?? t("ci.log.after")}</p>;
  if (error) return <div className="g-banner bad" role="alert">{error}</div>;
  if (log === undefined) return <p className="g-state-page" role="status">{t("ci.log.loading")}</p>;
  if (log === null) return notes.length
    ? <div className="g-state-page" role="status"><p>{t("ci.log.notes")}</p><ul className="git-ci-lines">{notes.map((note, index) => <li key={index}>{note}</li>)}</ul></div>
    : <p className="g-state-page" role="status">{t("ci.log.none")}</p>;
  const filtering = query.trim().length > 0;
  return <div className="git-ci-log-box">
    <div className="git-ci-log-tools">
      <label className="git-ci-log-find"><Icon name="Search" small/>
        <input type="search" aria-label={t("ci.log.filter")} placeholder={t("ci.log.filter")} value={query} onChange={event => setQuery(event.target.value)}/></label>
      {filtering && <span className="g-muted g-num" role="status">{t("ci.log.shown", {n: shown.length, all: lines.length})}</span>}
      <span className="git-ci-follow"><button type="button" role="switch" id={"git-ci-follow-" + job.id} className="g-tog" aria-checked={follow}
        aria-label={t("ci.log.follow")} onClick={() => setFollow(value => !value)}/><label htmlFor={"git-ci-follow-" + job.id}>{t("ci.log.follow")}</label></span>
      <button type="button" className="g-btn" onClick={() => void api.copy(filtering ? shown.map(index => lines[index]).join("\n") : log.text)
        .then(done => setCopied(done ? t(filtering ? "ci.log.copied-shown" : "ci.log.copied") : t("ci.copy-refused")))}>
        <Icon name="Copy" small/>{t(filtering ? "ci.log.copy-shown" : "ci.log.copy")}</button>
      {job.url && <a className="git-ci-link" href={job.url} target="_blank" rel="noreferrer"><Icon name="ExternalLink" small/>{t("ci.log.job-on-forge")}</a>}
      {copied && <span className="g-muted" role="status">{copied}</span>}
    </div>
    {(errorAt !== null && !filtering || log.truncated || notes.length > 0) && <div className="git-ci-log-note">
      {errorAt !== null && !filtering && <span className="g-bad"><Icon name="CircleX" small/>{t("ci.log.opened-at", {n: errorAt + 1})}</span>}
      {log.truncated && <span className="g-muted">{t("ci.log.tail")}</span>}
      {notes.length > 0 && <ul className="git-ci-lines" aria-label={t("ci.log.annotations")}>{notes.map((note, index) => <li key={index}>{note}</li>)}</ul>}
    </div>}
    <pre ref={pane} className="git-ci-log" aria-label={t("ci.log.of", {name: job.name})}>{shown.map(index =>
      <span key={index} className="git-ci-line" data-error={index === errorAt || undefined} ref={index === errorAt ? marker : undefined}>
        <span className="git-ci-number" aria-hidden="true">{index + 1}</span>{lines[index] + "\n"}</span>)}</pre>
    {filtering && !shown.length && <p className="g-state-page">{t("ci.log.no-match")}</p>}
  </div>;
}
