import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { MessageKey } from "../../core/i18n/dictionary.ts";
import { ago } from "../../core/i18n/time.ts";
import { overviewItems, type OverviewGroup, type OverviewItem, type OverviewKind } from "../../core/overview/items.ts";
import { overviewStages, type BoardCard } from "../../core/overview/stages.ts";
import { useLanguage, useT } from "../i18n/use-t.tsx";
import { PageHead } from "../shell/page-head.tsx";
import { Icon } from "../system/icon.tsx";
import type { OverviewApi, OverviewData, OverviewSource, OverviewTarget } from "./overview-api.ts";
import "./overview.css";

type View = "list" | "board";
const groups: OverviewGroup[] = ["action", "finish", "waiting"];
const icons: Record<OverviewKind, string> = {
  "ci-failed": "CircleX", review: "Eye", conflict: "AlertTriangle", threads: "MessageSquare",
  ready: "CircleCheck", unpushed: "ArrowUp", "ci-running": "Clock", behind: "ArrowDown",
};
const tones: Record<OverviewKind, string> = {
  "ci-failed": "g-bad", review: "g-vio", conflict: "g-warn", threads: "", ready: "g-good", unpushed: "", "ci-running": "", behind: "",
};
// One action per item, and where it leads: the overview itself writes nothing.
const actions: Record<OverviewKind, MessageKey> = {
  "ci-failed": "ov.do.checks", review: "ov.do.review", conflict: "ov.do.open-pr", threads: "ov.do.reply",
  ready: "ov.do.open-pr", unpushed: "ov.do.copy", "ci-running": "ov.do.ci", behind: "ov.do.copy",
};
function targetOf(item: Pick<OverviewItem, "pr" | "copyId" | "run">): OverviewTarget | null {
  if (item.pr) return {kind: "pr", accountId: item.pr.accountId, repo: item.pr.repo, number: item.pr.number};
  if (item.copyId) return {kind: "copy", copyId: item.copyId, section: item.run ? "actions" : "code"};
  return null;
}

/** The overview: what needs you, what you can finish and what goes on without you, as a list or a board by stage. */
export function OverviewPage({api, initialView}: {api: OverviewApi; initialView: View}) {
  const t = useT();
  const {language} = useLanguage();
  const [view, setView] = useState<View>(initialView);
  const [data, setData] = useState<OverviewData | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const read = useCallback((refresh: boolean) => {
    setLoading(true);
    setError("");
    api.load(refresh).then(value => { setData(value); setNow(Date.now()); }, (failure: unknown) => setError(failure instanceof Error ? failure.message : String(failure)))
      .finally(() => setLoading(false));
  }, [api]);
  useEffect(() => { read(false); }, [read]);
  useEffect(() => { setView(initialView); }, [initialView]);
  const items = useMemo(() => data ? overviewItems(data.input) : [], [data]);
  const current = items.find(item => item.key === selected) ?? items[0] ?? null;
  const choose = (next: View) => { setView(next); api.saveView(next); };
  const sources = (failed: OverviewSource[], copies: number) => failed.map(source =>
    source === "copies" ? t("ov.src.copies", {n: copies}) : t(("ov.src." + source) as MessageKey)).join(", ");

  const head = <PageHead title={t("section.overview")} sub={data ? t("ov.sub", {projects: data.projects, when: ago(language, now, new Date(data.at).toISOString())}) : undefined}
    actions={<>
      <div className="g-seg" role="group" aria-label={t("ov.view")}>
        {(["list", "board"] as const).map(option => <button key={option} type="button" aria-pressed={view === option} onClick={() => choose(option)}>
          <Icon name={option === "list" ? "ListView" : "GridView"} small/>{t(option === "list" ? "ov.list" : "ov.board")}
        </button>)}
      </div>
      <button type="button" className="g-btn" disabled={loading} onClick={() => read(true)}><Icon name="RotateCcw" small/>{t("ov.refresh")}</button>
    </>}/>;

  return <div className="g-page git-overview">
    {head}
    {error && <div className="g-banner bad" role="alert">{error}</div>}
    {data && data.failed.length > 0 && <div className="g-banner warn" role="status">{t("ov.partial", {sources: sources(data.failed, data.copiesFailed)})}</div>}
    {!data && !error && <p className="g-state-page" role="status">{t("common.loading")}</p>}
    {data && view === "list" && (items.length === 0
      ? <div className="g-state-page" role="status"><strong>{t("ov.empty")}</strong></div>
      : <div className="git-overview-split">
        <List items={items} current={current} now={now} onSelect={setSelected} onOpen={item => { const target = targetOf(item); if (target) api.open(target); }}/>
        {current && <Details item={current} api={api}/>}
      </div>)}
    {data && view === "board" && <Board data={data} now={now} api={api}/>}
  </div>;
}

function List({items, current, now, onSelect, onOpen}: {items: OverviewItem[]; current: OverviewItem | null; now: number;
  onSelect(key: string): void; onOpen(item: OverviewItem): void}) {
  const t = useT();
  const {language} = useLanguage();
  const list = useRef<HTMLDivElement>(null);
  // j/k and the arrows move the selection, Enter takes the item's action.
  const keys = (event: KeyboardEvent) => {
    if ((event.target as HTMLElement).closest("button") && event.key === "Enter") return;
    const index = items.findIndex(item => item.key === current?.key);
    const step = event.key === "j" || event.key === "ArrowDown" ? 1 : event.key === "k" || event.key === "ArrowUp" ? -1 : 0;
    if (step) {
      event.preventDefault();
      const next = items[Math.min(items.length - 1, Math.max(0, index + step))];
      if (next) { onSelect(next.key); list.current?.querySelector<HTMLElement>("[data-key=\"" + CSS.escape(next.key) + "\"]")?.focus(); }
    } else if (event.key === "Enter" && current) { event.preventDefault(); onOpen(current); }
  };
  return <div className="git-overview-list" ref={list} onKeyDown={keys}>
    {groups.map(group => {
      const rows = items.filter(item => item.group === group);
      if (!rows.length) return null;
      return <section key={group} aria-labelledby={"git-ov-" + group}>
        <h2 className="g-sec git-overview-group" id={"git-ov-" + group}>{t(("ov.group." + group) as MessageKey)} <span className="g-num">{rows.length}</span></h2>
        <ul role="listbox" aria-labelledby={"git-ov-" + group}>
          {rows.map(item => <li key={item.key} role="option" aria-selected={item.key === current?.key} data-key={item.key}
            tabIndex={item.key === current?.key ? 0 : -1} className={"g-it" + (item.key === current?.key ? " sel" : "")}
            onClick={() => onSelect(item.key)} onFocus={() => onSelect(item.key)} onDoubleClick={() => onOpen(item)}>
            <span className={tones[item.kind]}><Icon name={icons[item.kind]}/></span>
            <div className="git-overview-text">
              <div className="git-overview-title"><span className={"git-overview-kind " + tones[item.kind]}>{t(("ov.kind." + item.kind) as MessageKey)}</span>
                <span className="g-ell">{titleOf(item)}</span></div>
              <div className="g-muted git-overview-meta g-ell">{metaOf(t, item)}</div>
            </div>
            <span className="g-muted g-num git-overview-when">{ago(language, now, item.at)}</span>
            <button type="button" className="g-btn sm" tabIndex={-1} onClick={event => { event.stopPropagation(); onOpen(item); }}>{t(actions[item.kind])}</button>
          </li>)}
        </ul>
      </section>;
    })}
  </div>;
}

const titleOf = (item: Pick<OverviewItem, "pr" | "copy" | "run" | "repository">) =>
  item.pr?.title ?? (item.copy ? item.copy.name : item.run ? item.run.title : item.repository ?? "");
function metaOf(t: ReturnType<typeof useT>, item: OverviewItem): string {
  const pr = item.pr;
  if (pr && item.kind === "review") return t("ov.meta.review", {repo: pr.repo, number: pr.number, author: pr.author});
  if (pr && item.kind === "threads") return t("ov.meta.threads", {repo: pr.repo, number: pr.number, n: pr.unresolvedThreads});
  if (pr) return t("ov.meta.pr", {repo: pr.repo, number: pr.number, branch: pr.headRefName});
  if (item.copy && item.kind === "unpushed") return t("ov.meta.unpushed", {branch: item.copy.branch ?? "HEAD", n: item.copy.ahead});
  if (item.copy && item.kind === "behind") return t("ov.meta.behind", {branch: item.copy.branch ?? "HEAD", n: item.copy.behind});
  if (item.run) return t("ov.meta.run", {repository: item.repository ?? "", workflow: item.run.workflow, branch: item.run.branch ?? ""});
  return "";
}

function Details({item, api}: {item: OverviewItem; api: OverviewApi}) {
  const t = useT();
  const target = targetOf(item);
  const pr = item.pr;
  return <aside className="git-overview-details" aria-label={t("ov.details")}>
    <div className="g-muted git-overview-meta">{metaOf(t, item)}</div>
    <h2>{titleOf(item)}{pr ? <span className="g-muted"> #{pr.number}</span> : null}</h2>
    <div className="git-overview-chips">
      <span className={"g-chip " + ({"g-bad": "bad", "g-good": "good", "g-warn": "warn", "g-vio": "vio", "": "line"}[tones[item.kind]] ?? "line")}>
        {t(("ov.kind." + item.kind) as MessageKey)}</span>
      {pr && pr.additions !== null && <span className="g-num"><span className="g-good">+{pr.additions}</span> <span className="g-bad">−{pr.deletions ?? 0}</span></span>}
    </div>
    {pr && item.kind !== "review" && <section>
      <h3 className="g-sec">{t("ov.blockers")}</h3>
      {pr.blockers.length ? <ul className="git-overview-blockers">{pr.blockers.map(blocker => <li key={blocker}><Icon name="AlertCircle" small/>{blocker}</li>)}</ul>
        : <p className="g-muted">{t("ov.no-blockers")}</p>}
      {pr.failingChecks.length > 0 && <div className="git-overview-chips">{pr.failingChecks.map(check => <span key={check.name} className="g-chip bad">{check.name}</span>)}</div>}
    </section>}
    <div className="git-overview-actions">
      {target && <button type="button" className="g-btn pri" onClick={() => api.open(target)}>{t(actions[item.kind])}</button>}
      {pr && <api.Link href={pr.url}>{t("ov.on-forge")}</api.Link>}
    </div>
  </aside>;
}

function Board({data, now, api}: {data: OverviewData; now: number; api: OverviewApi}) {
  const t = useT();
  const {language} = useLanguage();
  const stages = useMemo(() => overviewStages(data.input), [data]);
  const card = (item: BoardCard) => {
    const target = targetOf(item);
    return <li key={item.key}>
      <button type="button" className="git-overview-card" disabled={!target} onClick={() => { if (target) api.open(target); }}>
        <span className="g-muted git-overview-meta g-ell">{item.pr ? item.pr.repo + " #" + item.pr.number : item.copy ? item.copy.branch ?? "" : item.repository ?? ""}</span>
        <span className="git-overview-card-title">{titleOf(item)}</span>
        <span className="g-muted git-overview-meta">{item.pr ? item.pr.blockers.join(" · ") || ago(language, now, item.at)
          : item.copy ? t("ov.meta.unpushed", {branch: item.copy.branch ?? "HEAD", n: item.copy.ahead}) : ago(language, now, item.at)}</span>
      </button>
    </li>;
  };
  const columns: [MessageKey, BoardCard[]][] = [["ov.stage.local", stages.local], ["ov.stage.open", stages.open], ["ov.stage.review", stages.review],
    ["ov.stage.ready", stages.ready], ["ov.stage.merged", stages.merged]];
  return <div className="git-overview-board">
    <section className="git-overview-now" aria-label={t("ov.stage.ci")}>
      <h2 className="g-sec">{t("ov.stage.ci")} <span className="g-num">{stages.ciNow.length}</span></h2>
      {stages.ciNow.length ? <ul>{stages.ciNow.map(card)}</ul> : <p className="g-muted">{t("ov.stage.none")}</p>}
    </section>
    <div className="git-overview-columns g-scroll">
      {columns.map(([label, cards]) => <section key={label} className="git-overview-column" aria-label={t(label)}>
        <h2 className="g-sec">{t(label)} <span className="g-num">{cards.length}</span></h2>
        {cards.length ? <ul>{cards.map(card)}</ul> : <p className="g-muted">{t("ov.stage.none")}</p>}
      </section>)}
    </div>
  </div>;
}
