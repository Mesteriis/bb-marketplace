import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { MessageKey } from "../../core/i18n/dictionary.ts";
import { ago } from "../../core/i18n/time.ts";
import { isActive } from "../../core/ci/model.ts";
import { reasonOf } from "../../core/overview/items.ts";
import { copyRepositories, projectTable, projectViews, viewRows, type ProjectRow, type ProjectView, type TableCopy } from "../../core/projects/table.ts";
import { repositoryKey } from "../../core/project-workspace.ts";
import { homeRelative } from "../../core/short-path.ts";
import type { Copy } from "../../core/workspace.ts";
import { useLanguage, useT } from "../i18n/use-t.tsx";
import type { OverviewData } from "../overview/overview-api.ts";
import { PageHead } from "../shell/page-head.tsx";
import { Icon } from "../system/icon.tsx";
import type { BulkAnswer, ProjectsApi } from "./projects-api.ts";
import "./projects.css";

type T = ReturnType<typeof useT>;
const bulkLimit = 50;
const forgeNames: Record<string, string> = {github: "GitHub", gitlab: "GitLab", gitea: "Gitea", azure: "Azure DevOps"};
const tones = {"ci-failed": "bad", conflict: "warn", changes: "warn", threads: "", ready: "good", "ci-running": ""} as Record<string, string>;

/**
 * The attached copies as one table by category: branch, changes, sync, my pull request and CI of each, under views
 * (All, Need attention, With changes, My PRs, CI failed). Chosen copies are fetched or pulled together.
 */
export function ProjectsPage({api, copies, categoryOf, hostName, title, ready, adding, onAdd}: {api: ProjectsApi; copies: Copy[];
  hostName(hostId: string): string;
  /** A copy's category (the top folder of its project), "" when its project has no folder. */
  categoryOf(copy: Copy): string;
  title: string; ready: boolean;
  /** The form to attach a copy, shown under the head while open. */
  adding: ReactNode; onAdd(): void}) {
  const t = useT();
  const {language} = useLanguage();
  const [data, setData] = useState<OverviewData | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [view, setView] = useState<ProjectView>("all");
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{text: string; failures: string[]} | null>(null);
  const request = useRef(0);
  const read = useCallback((refresh: boolean) => {
    const call = ++request.current;
    setLoading(true);
    setError("");
    api.load(refresh).then(value => { if (call === request.current) setData(value); },
      (failure: unknown) => { if (call === request.current) setError(failure instanceof Error ? failure.message : String(failure)); })
      .finally(() => { if (call === request.current) setLoading(false); });
  }, [api]);
  useEffect(() => { if (ready) read(false); }, [ready, read]);

  const table = useMemo(() => {
    const states = new Map((data?.input.copies ?? []).map(state => [state.copyId, state]));
    const repositories = copyRepositories(data?.input.runs ?? [], new Map(copies.map(copy => [copy.id, repositoryKey(copy)])));
    const input: TableCopy[] = copies.map(copy => ({copyId: copy.id, name: copy.repositoryName ?? copy.root.split(/[\\/]/).pop() ?? copy.root,
      place: hostName(copy.hostId) + " · " + homeRelative(copy.root), repository: repositories.get(copy.id) ?? null, category: categoryOf(copy), state: states.get(copy.id) ?? null}));
    return projectTable({copies: input, mine: data?.input.mine ?? [], runs: data?.input.runs ?? []});
  }, [data, copies, categoryOf, hostName]);
  // The forge of each repository, and which repositories have more than one copy here: those rows say their machine and path.
  const forges = useMemo(() => new Map((data?.input.runs ?? []).flatMap(entry => entry.forge ? [[entry.repository, entry.forge] as const] : [])), [data]);
  const shared = useMemo(() => {
    const seen = new Map<string, number>();
    for (const row of table.rows) { const key = row.repository ?? row.name; seen.set(key, (seen.get(key) ?? 0) + 1); }
    return new Set([...seen].filter(([, n]) => n > 1).map(([key]) => key));
  }, [table]);
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const shown = viewRows(table.rows, view).filter(row => words.every(word =>
    [row.name, row.branch, row.upstream, row.repository, row.place].some(value => value?.toLowerCase().includes(word))));
  const categories = [...new Set(shown.map(row => row.category))];
  const chosen = shown.filter(row => picked.has(row.copyId));
  const toggle = (id: string, set: Set<string>, update: (next: Set<string>) => void) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id); else next.add(id);
    update(next);
  };
  const run = async (action: "fetch" | "pull") => {
    setBusy(true);
    setNotice(null);
    const byCopy = new Map(copies.map(copy => [copy.id, copy]));
    const hosts = new Map<string, Copy[]>();
    for (const row of chosen) { const copy = byCopy.get(row.copyId); if (copy) hosts.set(copy.hostId, [...hosts.get(copy.hostId) ?? [], copy]); }
    let ok = 0;
    const failures: string[] = [];
    try {
      for (const [hostId, list] of hosts) {
        const answers = await api.bulk(hostId, list.map(copy => copy.root), action).catch((failure: unknown) =>
          list.map((copy): BulkAnswer => ({root: copy.root, ok: false, code: failure instanceof Error ? failure.message : String(failure)})));
        for (const answer of answers) {
          // A pull that could not fast-forward (changes, another upstream, diverged) answers with the status: still behind.
          const code = !answer.ok ? answer.code ?? "FAILED" : action === "pull" && (answer.behind ?? 0) > 0 ? "NOT_FAST_FORWARD" : null;
          if (code === null) { ok++; continue; }
          const copy = list.find(item => item.root === answer.root);
          failures.push(t("pj.bulk-failed", {name: table.rows.find(row => row.copyId === copy?.id)?.name ?? answer.root, code}));
        }
      }
    } finally {
      setBusy(false);
      setNotice({text: t("pj.bulk-done", {action: t(action === "fetch" ? "pj.fetch" : "pj.pull"), ok, failed: failures.length}), failures});
      read(true);
    }
  };
  // What was not read is named, as on the overview: rows then lack their pull request, CI or status, not the copies.
  const sources = (data?.failed ?? []).map(source => source === "copies" ? t("ov.src.copies", {n: data?.copiesFailed ?? 0})
    : t(("ov.src." + source) as MessageKey)).join(", ");
  const all = shown.length > 0 && shown.every(row => picked.has(row.copyId));

  return <div className="g-page git-projects">
    <PageHead title={title} sub={t("pj.sub", {n: copies.length})} actions={<>
      <input className="g-inp git-projects-search" type="search" aria-label={t("pj.search")} placeholder={t("pj.search")} value={query}
        onChange={event => setQuery(event.target.value)}/>
      <button type="button" className="g-btn" disabled={loading || !ready} onClick={() => read(true)}><Icon name="RotateCcw" small/>{t("ov.refresh")}</button>
      <button type="button" className="g-btn" aria-expanded={Boolean(adding)} onClick={onAdd}>{t("pj.attach")}</button>
    </>}/>
    {adding}
    <div className="g-views git-projects-bar">
      <div role="tablist" aria-label={t("pj.views")} className="git-projects-tabs">
        {projectViews.map(option => <button key={option} id={"git-projects-" + option} type="button" role="tab" aria-selected={view === option}
          aria-controls="git-projects-panel" tabIndex={view === option ? 0 : -1}
          onClick={() => setView(option)} onKeyDown={event => {
            const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
            if (!step) return;
            const next = projectViews[(projectViews.indexOf(option) + step + projectViews.length) % projectViews.length];
            setView(next);
            (event.currentTarget.parentElement?.querySelector("[data-view=\"" + next + "\"]") as HTMLElement | null)?.focus();
          }} data-view={option}>
          {t(("pj.view." + option) as MessageKey)} <span className="g-num git-projects-count">{table.counts[option]}</span>
        </button>)}
      </div>
      {chosen.length > 0 && <div className="git-projects-bulk" role="group" aria-label={t("pj.selected", {n: chosen.length})}>
        <span>{t("pj.selected", {n: chosen.length})}</span>
        <button type="button" className="g-btn" disabled={busy || chosen.length > bulkLimit} title={chosen.length > bulkLimit ? t("pj.bulk-limit") : undefined}
          onClick={() => void run("fetch")}><Icon name="RotateCcw" small/>{t("pj.fetch")}</button>
        <button type="button" className="g-btn" disabled={busy || chosen.length > bulkLimit} title={chosen.length > bulkLimit ? t("pj.bulk-limit") : undefined}
          onClick={() => void run("pull")}><Icon name="ArrowDown" small/>{t("pj.pull")}</button>
      </div>}
    </div>
    {error && <div className="g-banner bad" role="alert">{error}</div>}
    {sources && <div className="g-banner warn" role="status">{t("ov.partial", {sources})}</div>}
    {data?.limited && <div className="g-banner" role="status">{t("ov.limited", {n: data.limited})}</div>}
    {notice && <div className={"g-banner" + (notice.failures.length ? " warn" : "")} role="status">
      <span>{notice.text}{notice.failures.length ? " — " + notice.failures.join("; ") : ""}</span></div>}
    {!copies.length ? <div className="g-state-page" role="status"><strong>{t("pj.empty")}</strong></div>
      : !data ? (error ? null : <p className="g-state-page" role="status">{t("common.loading")}</p>)
      : !shown.length ? <div className="g-state-page" role="status">{t("pj.none")}</div>
      : <div className="git-projects-scroll" role="tabpanel" id="git-projects-panel" aria-labelledby={"git-projects-" + view}>
        <table className="g-table two git-projects-table">
          <thead><tr>
            <th className="git-projects-pick"><input type="checkbox" aria-label={t("pj.select-all")} checked={all}
              onChange={() => setPicked(previous => {
                const next = new Set(previous);
                for (const row of shown) { if (all) next.delete(row.copyId); else next.add(row.copyId); }
                return next;
              })}/></th>
            <th>{t("pj.col.project")}</th><th>{t("pj.col.branch")}</th><th>{t("pj.col.changes")}</th>
            <th>{t("pj.col.sync")}</th><th>{t("pj.col.pr")}</th><th>{t("pj.col.ci")}</th>
          </tr></thead>
          {categories.map(category => {
            const name = category || t("shell.noFolder");
            const rows = shown.filter(row => row.category === category);
            const open = !closed.has(category);
            return <tbody key={category}>
              <tr className="group"><td colSpan={7}>
                <button type="button" className="git-projects-group" aria-expanded={open} aria-label={t(open ? "pj.hide" : "pj.show", {name})}
                  onClick={() => toggle(category, closed, setClosed)}>
                  <Icon name={open ? "ChevronDown" : "ChevronRight"} small/>{name} <span className="g-num g-count">{rows.length}</span>
                </button>
              </td></tr>
              {open && rows.map(row => <Row key={row.copyId} row={row} forge={row.repository ? forges.get(row.repository) ?? null : null}
                shared={shared.has(row.repository ?? row.name)} t={t} now={data?.at ?? Date.now()} language={language}
                picked={picked.has(row.copyId)} onPick={() => toggle(row.copyId, picked, setPicked)} api={api}/>)}
            </tbody>;
          })}
        </table>
      </div>}
  </div>;
}

function Row({row, forge, shared, t, now, language, picked, onPick, api}: {row: ProjectRow; forge: string | null;
  /** Another copy of the same repository is listed: the row says its machine and path. */
  shared: boolean; t: T; now: number; language: ReturnType<typeof useLanguage>["language"];
  picked: boolean; onPick(): void; api: ProjectsApi}) {
  const reason = row.pr ? reasonOf(row.pr) : null;
  const ci = row.ci;
  const ciTone = !ci ? "" : ci.state === "failure" ? "g-bad" : ci.state === "success" ? "g-good" : "";
  const ciWord = !ci ? t("pj.ci.none") : ci.state === "success" ? t("pj.ci.success") : ci.state === "failure" ? t("pj.ci.failure")
    : isActive(ci.state) ? t("pj.ci.running") : ci.state === "cancelled" ? t("pj.ci.cancelled") : t("pj.ci.skipped");
  return <tr className={picked ? "sel" : undefined}>
    <td className="git-projects-pick"><input type="checkbox" aria-label={t("pj.select", {name: row.name})} checked={picked} onChange={onPick}/></td>
    <td><button type="button" className="git-projects-name" onClick={() => api.openCopy(row.copyId)}>{row.name}</button>
      <div className="git-projects-repo" title={row.place}>{[forge ? forgeNames[forge] ?? forge : null, row.repository, shared || !row.repository ? row.place : null]
        .filter(Boolean).join(" · ")}</div></td>
    <td>{row.unreadable ? <span className="g-warn">{t("pj.unreadable")}</span>
      : <span className="g-branch" title={row.branch ?? undefined}>{row.branch ?? t("pj.detached")}</span>}</td>
    <td className="g-num">{row.files ? t("pj.files", {n: row.files}) : "—"}</td>
    <td className="g-num git-projects-sync">{row.unreadable ? "—" : row.branch !== null && row.upstream === null ? <span>{t("pj.unpublished")}</span>
      : row.ahead || row.behind ? <>{row.ahead ? <span>↑{row.ahead}</span> : null}{row.behind ? <span className="g-warn">↓{row.behind}</span> : null}</>
      : <span aria-label={t("pj.in-sync")} title={t("pj.in-sync")}>✓</span>}</td>
    <td>{row.pr ? <button type="button" className={"g-chip git-projects-pr " + (reason ? tones[reason] ?? "" : "line")}
      onClick={() => api.openPr({accountId: row.pr!.accountId, repo: row.pr!.repo, number: row.pr!.number})}>
      #{row.pr.number} {reason ? t(("ov.kind." + reason) as MessageKey) : t("pj.pr-open")}</button> : "—"}</td>
    <td className={ciTone}>{ci ? <span className="git-projects-ci"><Icon name={ci.state === "success" ? "CircleCheck" : ci.state === "failure" ? "CircleX" : "Clock"} small/>
      {ciWord}<span className="git-projects-when">{ago(language, now, ci.startedAt ?? ci.createdAt)}</span></span>
      : <span className="git-projects-when">{ciWord}</span>}</td>
  </tr>;
}
