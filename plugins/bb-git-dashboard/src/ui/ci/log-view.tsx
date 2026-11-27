import { useEffect, useRef, useState } from "react";
import type { Job } from "../../core/ci/model.ts";
import type { JobLog } from "../../core/ci/pipelines.ts";
import { message, type CiApi } from "./ci-api.ts";

const livePoll = 5_000;

/** A job log opened at its error line; polled while the job runs where the forge streams logs. */
export function LogView({api, copyId, runId, job, liveLog, liveLimitation}: {
  api: CiApi; copyId: string; runId: string; job: Job; liveLog: boolean; liveLimitation: string | null;
}) {
  const [log, setLog] = useState<JobLog | undefined>();
  const [errorAt, setErrorAt] = useState<number | null>(null);
  const [error, setError] = useState("");
  const marker = useRef<HTMLSpanElement>(null);
  const running = job.state === "running" || job.state === "queued";
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () => api.log(copyId, runId, job.id).then(result => {
      if (!active) return;
      setLog(result.log);
      setErrorAt(result.errorLine);
      setError("");
      if (running && liveLog) timer = setTimeout(load, livePoll);
    }, cause => { if (active) setError(message(cause)); });
    if (!running || liveLog) void load();
    return () => { active = false; clearTimeout(timer); };
  }, [api, copyId, runId, job.id, running, liveLog]);
  useEffect(() => { marker.current?.scrollIntoView({block: "center"}); }, [errorAt, log]);

  if (running && !liveLog) return <p className="git-muted" role="status">{liveLimitation ?? "The log is available when the job ends."}</p>;
  if (error) return <p className="git-error" role="alert">{error}</p>;
  if (log === undefined) return <p className="git-muted" role="status">Loading log…</p>;
  if (log === null) return <p className="git-muted" role="status">The forge has not published a log for this job yet.</p>;
  const lines = log.text.replace(/\n$/, "").split("\n");
  return <div className="git-stack">
    {log.truncated && <p className="git-muted">Showing the end of a long log.</p>}
    {errorAt !== null && <p className="git-muted">Opened at the error on line {errorAt + 1}.</p>}
    <pre className="git-code git-ci-log" aria-label={"Log of " + job.name}>{lines.map((line, index) =>
      <span key={index} className="git-ci-line" data-error={index === errorAt || undefined} ref={index === errorAt ? marker : undefined}>
        <span className="git-ci-number" aria-hidden="true">{index + 1}</span>{line + "\n"}</span>)}</pre>
  </div>;
}
