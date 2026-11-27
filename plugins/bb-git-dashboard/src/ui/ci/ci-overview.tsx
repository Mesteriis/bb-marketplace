import { useEffect, useMemo, useState } from "react";
import { isActive, type RunFilter } from "../../core/ci/model.ts";
import { elapsed } from "../../core/ci/summary.ts";
import { message, stateText, type CiApi, type OverviewRow } from "./ci-api.ts";
import { CiTiles, useNow } from "./ci-panel.tsx";
import "./ci.css";

const filters: {value: RunFilter; label: string}[] = [{value: "all", label: "All"}, {value: "active", label: "Active"}, {value: "failed", label: "Failed"}];
const when = (value: string) => value.replace("T", " ").slice(0, 16);

/** CI/CD across every linked repository: tiles, a repository filter and the latest runs; a row opens its repository. */
export function CiOverview({api, onOpen}: {api: CiApi; onOpen(copyId: string): void}) {
  const [rows, setRows] = useState<OverviewRow[]>();
  const [error, setError] = useState("");
  const [repository, setRepository] = useState("");
  const [filter, setFilter] = useState<RunFilter>("all");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () => api.overview().then(result => {
      if (!active) return;
      setRows(result.repositories);
      setError("");
      const busy = result.repositories.some(row => row.runs.some(run => isActive(run.state)));
      timer = setTimeout(load, busy ? 15_000 : 60_000);
    }, cause => { if (active) setError(message(cause)); });
    void load();
    return () => { active = false; clearTimeout(timer); };
  }, [api, revision]);
  const scoped = useMemo(() => (rows ?? []).filter(row => !repository || row.copyId === repository), [rows, repository]);
  const runs = useMemo(() => scoped.flatMap(row => row.runs.map(run => ({row, run})))
    .sort((left, right) => right.run.createdAt.localeCompare(left.run.createdAt)), [scoped]);
  const visible = runs.filter(({run}) => filter === "all" || (filter === "active" ? isActive(run.state) : run.state === "failure"));
  const now = useNow(runs.some(({run}) => isActive(run.state)));
  return <section className="git-project-code git-stack git-ci">
    <div className="git-project-title"><div><h2>CI/CD</h2><p className="git-muted">Latest runs of every linked repository</p></div>
      <button type="button" onClick={() => setRevision(value => value + 1)}>Refresh</button></div>
    {error && <p className="git-error" role="alert">{error}</p>}
    {!rows && !error && <p className="git-muted" role="status">Loading runs…</p>}
    {rows && !rows.length && <p className="git-muted">No repository is linked to a forge account yet. Link one from its CI/CD section.</p>}
    {rows && rows.length > 0 && <>
      <div className="git-row git-ci-toolbar">
        <select aria-label="Repository" value={repository} onChange={event => setRepository(event.target.value)}>
          <option value="">All repositories</option>
          {rows.map(row => <option key={row.copyId} value={row.copyId}>{row.repository}</option>)}
        </select>
        <div className="git-row" role="group" aria-label="Runs to show">{filters.map(item =>
          <button key={item.value} type="button" aria-pressed={filter === item.value} onClick={() => setFilter(item.value)}>{item.label}</button>)}</div>
      </div>
      <CiTiles runs={runs.map(({run}) => run)}/>
      {scoped.filter(row => row.error).map(row => <p key={row.copyId} className="git-error" role="alert">{row.repository}: {row.error}</p>)}
      {!visible.length && <p className="git-muted">{filter === "active" ? "Nothing is running." : filter === "failed" ? "No failed runs." : "No runs yet."}</p>}
      {visible.length > 0 && <div className="git-workspace-table"><table>
        <thead><tr><th scope="col">Run</th><th scope="col">Repository</th><th scope="col">Status</th><th scope="col">Branch</th><th scope="col">Started</th><th scope="col">Duration</th></tr></thead>
        <tbody>{visible.map(({row, run}) => <tr key={row.copyId + "/" + run.id + "#" + run.attempt} onClick={() => onOpen(row.copyId)}>
          <th scope="row"><button type="button" className="git-table-entry" onClick={event => { event.stopPropagation(); onOpen(row.copyId); }}>
            {run.workflow} #{run.number ?? run.id}</button>{run.title && <span className="git-muted"> {run.title}</span>}</th>
          <td>{row.repository}</td>
          <td><span className="git-state" data-state={run.state}>{stateText(run, now)}</span></td>
          <td>{run.branch ?? "—"}</td>
          <td><time dateTime={run.createdAt}>{when(run.createdAt)}</time></td>
          <td>{elapsed(run, now) ?? "—"}</td>
        </tr>)}</tbody>
      </table></div>}
    </>}
  </section>;
}
