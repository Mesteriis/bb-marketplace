import { useEffect, useState, type ReactNode } from "react";
import { isActive, type Run, type RunFilter } from "../../core/ci/model.ts";
import { useT } from "../i18n/use-t.tsx";
import { Icon } from "../system/icon.tsx";
import { message, type CiApi, type RunsPage } from "./ci-api.ts";
import { RunsTable, useNow } from "./ci-parts.tsx";
import { DispatchDialog } from "./dispatch-dialog.tsx";
import { RunDetail } from "./run-detail.tsx";
import { RunFilterSeg } from "./run-filter.tsx";
import { TemplatePage } from "./template-page.tsx";
import { ThreadsDialog } from "./thread-picker.tsx";
import "./ci.css";

export { useNow } from "./ci-parts.tsx";

/** What the tab shows: the runs, one run, or the templates; in a page it lives in the address. */
export type CiView = {kind: "runs"} | {kind: "run"; runId: string} | {kind: "templates"};

/**
 * CI/CD of the linked repository: runs by filter with paging, failure notifications, manual runs and templates; a
 * run opens as its own page. `view` and `onView` put the place in the address; without them it is kept here.
 */
export function CiPanel({api, copyId, currentThreadId, repository = "", view: routed, onView, onSection, forge}: {
  api: CiApi; copyId: string; currentThreadId?: string; repository?: string;
  view?: CiView; onView?(view: CiView): void;
  /** Goes to the CI/CD section over every repository. */
  onSection?(): void;
  /** The forge and account line, with the connection controls, beside the filters. */
  forge?: ReactNode;
}) {
  const t = useT();
  const [kept, setKept] = useState<CiView>({kind: "runs"});
  const view = routed ?? kept;
  const go = onView ?? setKept;
  const [filter, setFilter] = useState<RunFilter>("all");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<RunsPage>();
  const [error, setError] = useState("");
  const [dispatching, setDispatching] = useState<{workflowId: string | null; ref: string | null} | null>(null);
  const [notifying, setNotifying] = useState(false);
  const [subscribed, setSubscribed] = useState<number | null>(null);
  const [notice, setNotice] = useState("");
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
  useEffect(() => {
    let active = true;
    api.threads(copyId).then(result => { if (active) setSubscribed(result.subscribed.length); }, () => {});
    return () => { active = false; };
  }, [api, copyId]);

  const now = useNow(!!data?.items.some(run => isActive(run.state)));
  const refresh = () => setRevision(value => value + 1);
  const rerunWith = (run: Run) => setDispatching({workflowId: run.workflowId, ref: run.branch});
  const dialog = dispatching && <DispatchDialog key={(dispatching.workflowId ?? "") + "@" + (dispatching.ref ?? "")} api={api} copyId={copyId}
    initialWorkflow={dispatching.workflowId} initialRef={dispatching.ref} inputsLimitation={data?.limitations.dispatchInputs ?? null}
    onClose={() => setDispatching(null)} onDone={() => { setDispatching(null); setNotice(t("ci.dispatched")); refresh(); }}/>;
  if (view.kind === "templates") return <TemplatePage api={api} copyId={copyId} onClose={() => { go({kind: "runs"}); refresh(); }}/>;
  if (view.kind === "run") return <>
    {/* The run reads itself; the list's answer only adds what may be written, so a failed list still leaves the page and its path. */}
    {error && !data && <div className="g-banner bad" role="alert">{error}</div>}
    <RunDetail api={api} copyId={copyId} runId={view.runId} page={data} notice={notice} repository={repository} onBack={() => go({kind: "runs"})} onSection={onSection}
      onChanged={refresh} currentThreadId={currentThreadId} onRunWith={data?.operations.dispatch ? rerunWith : undefined}/>
    {dialog}
  </>;
  return <div className="git-ci git-ci-tab">
    <div className="git-ci-bar">
      <RunFilterSeg value={filter} onChange={next => { setFilter(next); setPage(1); }}/>
      {/* It opens the choice of threads rather than flipping a state, so it is a button that says the state. */}
      <button type="button" className="git-ci-notify" aria-haspopup="dialog" disabled={subscribed === null}
        aria-label={t("ci.notify") + ": " + t(subscribed ? "ci.notify-state-on" : "ci.notify-state-off")} onClick={() => setNotifying(true)}>
        <span className="g-tog" data-on={!!subscribed} aria-hidden="true"/>{t("ci.notify")}</button>
      {forge}
      <span className="git-ci-bar-end">
        <button type="button" className="g-btn" onClick={() => go({kind: "templates"})}><Icon name="FileText" small/>{t("ci.templates")}</button>
        {data?.operations.dispatch && <button type="button" className="g-btn" aria-haspopup="dialog"
          onClick={() => setDispatching({workflowId: null, ref: null})}><Icon name="Play" small/>{t("ci.run-workflow")}</button>}
        <button type="button" className="g-btn ghost" onClick={refresh}><Icon name="RotateCcw" small/>{t("ci.refresh")}</button>
      </span>
    </div>
    {data?.limitations.dispatch && !data.operations.dispatch && <p className="git-ci-status g-muted">{data.limitations.dispatch}</p>}
    {notice && <p className="git-ci-status g-muted" role="status">{notice}</p>}
    {error && <div className="g-banner bad" role="alert">{error}</div>}
    {!data && !error && <p className="g-state-page" role="status">{t("ci.loading")}</p>}
    {data && !data.items.length && <p className="g-state-page">{t(filter === "all" ? "ci.none" : filter === "active" ? "ci.none-active" : "ci.none-failed")}</p>}
    {data && data.items.length > 0 && <RunsTable label={t("ci.runs")} rows={data.items.map(run => ({key: run.id + "#" + run.attempt, run}))} now={now}
      onOpen={row => go({kind: "run", runId: row.run.id})}/>}
    {data && (page > 1 || data.more) && <div className="git-ci-pages">
      <button type="button" className="g-btn" disabled={page <= 1} onClick={() => setPage(value => value - 1)}><Icon name="ChevronLeft" small/>{t("ci.newer")}</button>
      <button type="button" className="g-btn" disabled={!data.more} onClick={() => setPage(value => value + 1)}>{t("ci.older")}<Icon name="ChevronRight" small/></button>
      <span className="g-muted">{t("ci.page", {n: page})}</span>
    </div>}
    {dialog}
    {notifying && <ThreadsDialog title={t("ci.notify")} onClose={() => setNotifying(false)} api={api} copyId={copyId} initial="subscribed"
      label={t("ci.notify-to")} action={t("ci.save")} onDone={async threadIds => {
        const result = await api.subscribe(copyId, threadIds);
        setSubscribed(result.subscribed.length);
        return result.subscribed.length ? t("ci.notify-on", {n: result.subscribed.length}) : t("ci.notify-off");
      }}/>}
  </div>;
}
