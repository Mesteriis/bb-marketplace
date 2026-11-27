import { useEffect, useState } from "react";
import { isActive, type RunFilter } from "../../core/ci/model.ts";
import { message, stateLabel, stateText, type CiApi, type RunsPage } from "./ci-api.ts";
import { DispatchForm } from "./dispatch-form.tsx";
import { RunDetail } from "./run-detail.tsx";
import { ThreadPicker } from "./thread-picker.tsx";
import "./ci.css";

const filters: {value: RunFilter; label: string}[] = [{value: "all", label: "All"}, {value: "active", label: "Active"}, {value: "failed", label: "Failed"}];
const when = (value: string | null) => value ? value.replace("T", " ").slice(0, 16) : "—";

/** CI/CD of the linked repository: runs by filter, one run in detail, manual runs and failure notifications. */
export function CiPanel({api, copyId}: {api: CiApi; copyId: string}) {
  const [filter, setFilter] = useState<RunFilter>("all");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<RunsPage>();
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [dispatching, setDispatching] = useState(false);
  const [notifying, setNotifying] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () => api.runs(copyId, filter, page).then(result => {
      if (!active) return;
      setData(result);
      setError("");
      const busy = result.items.some(run => isActive(run.state));
      timer = setTimeout(load, busy ? 15_000 : 60_000);
    }, cause => { if (active) setError(message(cause)); });
    void load();
    return () => { active = false; clearTimeout(timer); };
  }, [api, copyId, filter, page, revision]);

  const refresh = () => setRevision(value => value + 1);
  if (selected && data) return <RunDetail api={api} copyId={copyId} runId={selected} page={data} onBack={() => setSelected(null)} onChanged={refresh}/>;
  return <div className="git-stack git-ci">
    <div className="git-row git-ci-toolbar">
      <div className="git-row" role="group" aria-label="Runs to show">{filters.map(item =>
        <button key={item.value} type="button" aria-pressed={filter === item.value} onClick={() => { setFilter(item.value); setPage(1); }}>{item.label}</button>)}</div>
      <span className="git-ci-spacer"/>
      {data?.operations.dispatch && <button type="button" className="git-primary" aria-expanded={dispatching} onClick={() => setDispatching(value => !value)}>Run workflow</button>}
      <button type="button" aria-expanded={notifying} onClick={() => setNotifying(value => !value)}>Failure notifications</button>
      <button type="button" onClick={refresh}>Refresh</button>
    </div>
    {dispatching && <DispatchForm api={api} copyId={copyId} inputsLimitation={data?.limitations.dispatchInputs ?? null}
      onClose={() => setDispatching(false)} onDone={() => { setDispatching(false); refresh(); }}/>}
    {notifying && <ThreadPicker api={api} copyId={copyId} initial="subscribed" label="Send each new failed run to" action="Save"
      onDone={async threadIds => {
        const result = await api.subscribe(copyId, threadIds);
        return result.subscribed.length ? "New failures go to " + result.subscribed.length + " thread(s)." : "Notifications are off.";
      }}/>}
    {error && <p className="git-error" role="alert">{error}</p>}
    {!data && !error && <p className="git-muted" role="status">Loading runs…</p>}
    {data && !data.items.length && <p className="git-muted">{filter === "all" ? "No runs yet." : filter === "active" ? "Nothing is running." : "No failed runs."}</p>}
    {data && data.items.length > 0 && <div className="git-workspace-table"><table>
      <thead><tr><th scope="col">Run</th><th scope="col">Status</th><th scope="col">Branch</th><th scope="col" data-col="event">Event</th><th scope="col">Started</th></tr></thead>
      <tbody>{data.items.map(run => <tr key={run.id + "#" + run.attempt} data-selected="false" onClick={() => setSelected(run.id)}>
        <th scope="row"><button type="button" className="git-table-entry" onClick={event => { event.stopPropagation(); setSelected(run.id); }}>
          {run.workflow} #{run.number ?? run.id}</button>{run.title && <span className="git-muted"> {run.title}</span>}</th>
        <td><span className="git-state" data-state={run.state}>{stateText(run)}</span></td>
        <td>{run.branch ?? "—"}</td><td data-col="event">{run.event ?? "—"}</td>
        <td><time dateTime={run.createdAt}>{when(run.createdAt)}</time></td>
      </tr>)}</tbody>
    </table></div>}
    {data && (page > 1 || data.more) && <div className="git-row">
      <button type="button" disabled={page <= 1} onClick={() => setPage(value => value - 1)}>Newer</button>
      <span className="git-muted">Page {page}</span>
      <button type="button" disabled={!data.more} onClick={() => setPage(value => value + 1)}>Older</button>
    </div>}
  </div>;
}
