import { useEffect, useState } from "react";
import { isActive, type Run } from "../../core/ci/model.ts";
import { ciSummary, runSeconds } from "../../core/ci/summary.ts";
import { ago, duration } from "../../core/i18n/time.ts";
import { useLanguage, useT } from "../i18n/use-t.tsx";
import { Icon } from "../system/icon.tsx";
import { stateText } from "./ci-api.ts";

type T = ReturnType<typeof useT>;

/** Re-renders once a second while `enabled`, for live durations. */
export function useNow(enabled: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [enabled]);
  return now;
}

const icons: Record<Run["state"], string> = {queued: "Clock", waiting: "Clock", running: "Loading", success: "CircleCheck", failure: "CircleX",
  cancelled: "Circle", skipped: "Circle", neutral: "Circle"};

/** A run's or job's state: its mark and its word, in the state's colour; `quiet` keeps the word for screen readers only. */
export function RunState({state, text, quiet = false}: {state: Run["state"]; text: string; quiet?: boolean}) {
  return <span className="git-ci-st" data-state={state}><Icon name={icons[state]} small/>{quiet ? <span className="g-sr">{text}</span> : text}</span>;
}

/** "12 min ago", "just now"; the exact time goes to the tooltip. */
export function Since({at, now}: {at: string; now: number}) {
  const t = useT();
  const {language} = useLanguage();
  const when = ago(language, now, at);
  return <time dateTime={at} title={at.replace("T", " ").slice(0, 16)}>{when === t("time.now") ? when : t("ci.ago", {when})}</time>;
}

/** How long a run took, in the words of the language; a dash when unknown. */
export function RunDuration({run, now}: {run: Run; now: number}) {
  const {language} = useLanguage();
  const seconds = runSeconds(run, now);
  return <>{seconds === null ? "—" : duration(language, seconds)}</>;
}

/** The line of numbers over a list of runs: running, queued, failed and how often the finished ones succeeded. */
export function CiNumbers({runs}: {runs: Run[]}) {
  const t = useT();
  const summary = ciSummary(runs);
  // A plural form carries its number ("1 failed"): the number is drawn bold, the word plain.
  const part = (text: string) => { const space = text.indexOf(" "); return <><strong className="g-num">{text.slice(0, space)}</strong>{text.slice(space)}</>; };
  return <p className="git-ci-numbers" aria-label={t("ci.numbers", {n: summary.total})}>
    <span>{part(t("ci.w.running", {n: summary.running}))}</span>
    <span>{part(t("ci.w.queued", {n: summary.queued}))}</span>
    <span className={summary.failed ? "g-bad" : undefined}>{part(t("ci.w.failed", {n: summary.failed}))}</span>
    {summary.successRate !== null && <span title={t("ci.rate-hint")}>{part(t("ci.w.rate", {n: summary.successRate}))}</span>}
  </p>;
}

export type RunRow = {key: string; run: Run; repository?: string};

/** The runs as a table: run, (repository), state, branch, event, started, duration; a row opens its run. */
export function RunsTable({rows, now, onOpen, label}: {rows: RunRow[]; now: number; onOpen(row: RunRow): void; label: string}) {
  const t = useT();
  const withRepository = rows.some(row => row.repository !== undefined);
  return <div className="g-scroll git-ci-table"><table className="g-table" aria-label={label}>
    <thead><tr><th scope="col">{t("ci.col.run")}</th>{withRepository && <th scope="col">{t("ci.col.repository")}</th>}
      <th scope="col">{t("ci.col.status")}</th><th scope="col">{t("ci.col.branch")}</th><th scope="col" data-col="event">{t("ci.col.event")}</th>
      <th scope="col">{t("ci.col.started")}</th><th scope="col">{t("ci.col.duration")}</th></tr></thead>
    <tbody>{rows.map(row => <RunLine key={row.key} t={t} row={row} now={now} withRepository={withRepository} onOpen={() => onOpen(row)}/>)}</tbody>
  </table></div>;
}

function RunLine({t, row, now, withRepository, onOpen}: {t: T; row: RunRow; now: number; withRepository: boolean; onOpen(): void}) {
  const {run} = row;
  return <tr className="git-ci-row" data-state={run.state} onClick={onOpen}>
    <th scope="row"><button type="button" className="git-ci-entry" onClick={event => { event.stopPropagation(); onOpen(); }}>
      {runName(run)}</button></th>
    {withRepository && <td className="git-ci-repo">{row.repository}</td>}
    <td><RunState state={run.state} text={stateText(t, run, now)}/></td>
    <td className="git-ci-branch-cell">{run.branch ? <span className="g-branch" title={run.branch}>{run.branch}</span> : "—"}</td>
    <td data-col="event">{run.event ?? "—"}</td>
    <td className="git-ci-when"><Since at={run.startedAt ?? run.createdAt} now={now}/></td>
    <td className="g-num"><RunDuration run={run} now={now}/></td>
  </tr>;
}

/** "CI #482 · wire up saved cards": the workflow, the run's number and its title. */
export const runName = (run: Run) => run.workflow + " #" + (run.number ?? run.id) + (run.title ? " · " + run.title : "");

/** Whether any of the runs is still going, for live clocks and quicker polling. */
export const anyActive = (runs: Run[]) => runs.some(run => isActive(run.state));
