import { useEffect, useMemo, useState } from "react";
import { isActive, type RunFilter } from "../../core/ci/model.ts";
import { useT } from "../i18n/use-t.tsx";
import { PageHead } from "../shell/page-head.tsx";
import { Icon } from "../system/icon.tsx";
import { message, type CiApi, type OverviewRow } from "./ci-api.ts";
import { CiNumbers, RunsTable, useNow } from "./ci-parts.tsx";
import { RunFilterSeg } from "./run-filter.tsx";
import "./ci.css";

/** CI/CD across every linked repository: one head, the numbers, and the latest runs; a row opens that run. */
export function CiOverview({api, onOpen}: {api: CiApi; onOpen(copyId: string, runId: string): void}) {
  const t = useT();
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
    }, cause => {
      if (!active) return;
      setError(message(cause));
      timer = setTimeout(load, 60_000);
    });
    void load();
    return () => { active = false; clearTimeout(timer); };
  }, [api, revision]);
  const scoped = useMemo(() => (rows ?? []).filter(row => !repository || row.copyId === repository), [rows, repository]);
  const runs = useMemo(() => scoped.flatMap(row => row.runs.map(run => ({key: row.copyId + "/" + run.id + "#" + run.attempt, run, repository: row.repository, copyId: row.copyId})))
    .sort((left, right) => right.run.createdAt.localeCompare(left.run.createdAt)), [scoped]);
  const visible = runs.filter(({run}) => filter === "all" || (filter === "active" ? isActive(run.state) : run.state === "failure"));
  const now = useNow(runs.some(({run}) => isActive(run.state)));
  return <div className="g-page git-ci">
    <PageHead title={t("section.ci")} sub={t("ci.sub")} actions={<>
      {rows && rows.length > 0 && <select className="g-inp" aria-label={t("ci.repository")} value={repository} onChange={event => setRepository(event.target.value)}>
        <option value="">{t("ci.all-repositories")}</option>
        {rows.map(row => <option key={row.copyId} value={row.copyId}>{row.repository}</option>)}
      </select>}
      <RunFilterSeg value={filter} onChange={setFilter}/>
      <button type="button" className="g-btn" onClick={() => setRevision(value => value + 1)}><Icon name="RotateCcw" small/>{t("ci.refresh")}</button>
    </>}/>
    {error && <div className="g-banner bad" role="alert">{error}</div>}
    {!rows && !error && <p className="g-state-page" role="status">{t("ci.loading")}</p>}
    {rows && !rows.length && <p className="g-state-page">{t("ci.no-linked")}</p>}
    {rows && rows.length > 0 && <>
      <CiNumbers runs={runs.map(({run}) => run)}/>
      {scoped.filter(row => row.error).map(row => <div key={row.copyId} className="g-banner bad" role="alert">{row.repository}: {row.error}</div>)}
      {!visible.length ? <p className="g-state-page">{t(filter === "active" ? "ci.none-active" : filter === "failed" ? "ci.none-failed" : "ci.none")}</p>
        : <RunsTable label={t("ci.runs")} rows={visible} now={now} onOpen={row => {
          const found = visible.find(item => item.key === row.key);
          if (found) onOpen(found.copyId, found.run.id);
        }}/>}
    </>}
  </div>;
}
