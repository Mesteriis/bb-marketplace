import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { MessageKey } from "../../core/i18n/dictionary.ts";
import { ago } from "../../core/i18n/time.ts";
import { blockerList, overviewItems, type Blocker, type OverviewGroup, type OverviewItem, type OverviewKind } from "../../core/overview/items.ts";
import { overviewStages, type BoardCard } from "../../core/overview/stages.ts";
import type { InboxPr } from "../../core/pulls/model.ts";
import { useLanguage, useT } from "../i18n/use-t.tsx";
import { PageHead } from "../shell/page-head.tsx";
import { Icon } from "../system/icon.tsx";
import type { OverviewApi, OverviewData, OverviewSource, OverviewTarget } from "./overview-api.ts";
import "./overview.css";

type View = "list" | "board";
type T = ReturnType<typeof useT>;
const groups: OverviewGroup[] = ["action", "finish", "waiting"];
const icons: Record<OverviewKind, string> = {
  "ci-failed": "CircleX", review: "Eye", conflict: "AlertTriangle", changes: "AlertCircle", threads: "MessageSquare",
  ready: "CircleCheck", unpushed: "ArrowUp", "ci-running": "Clock", behind: "ArrowDown",
};
const tones: Record<OverviewKind, "bad" | "good" | "warn" | "vio" | ""> = {
  "ci-failed": "bad", review: "vio", conflict: "warn", changes: "warn", threads: "", ready: "good", unpushed: "", "ci-running": "", behind: "",
};
// One action per item, and where it leads: the overview itself writes nothing.
const actions: Record<OverviewKind, MessageKey> = {
  "ci-failed": "ov.do.checks", review: "ov.do.review", conflict: "ov.do.open-pr", changes: "ov.do.open-pr", threads: "ov.do.reply",
  ready: "ov.do.open-pr", unpushed: "ov.do.copy", "ci-running": "ov.do.ci", behind: "ov.do.copy",
};
const actionOf = (item: OverviewItem): MessageKey => item.kind === "ci-running" && item.pr ? "ov.do.open-pr" : actions[item.kind];
function targetOf(item: Pick<OverviewItem, "pr" | "copyId" | "run">): OverviewTarget | null {
  if (item.pr) return {kind: "pr", accountId: item.pr.accountId, repo: item.pr.repo, number: item.pr.number};
  if (item.copyId) return {kind: "copy", copyId: item.copyId, section: item.run ? "actions" : "code"};
  return null;
}
function blockerText(t: T, blocker: Blocker): string {
  if (blocker.key === "note") return blocker.text;
  if (blocker.key === "ci-failing") return blocker.n ? t("ov.b.ci-failing-n", {n: blocker.n}) : t("ov.b.ci-failing");
  return t(("ov.b." + blocker.key) as MessageKey, blocker.n === undefined ? {} : {n: blocker.n});
}

/** The overview: what needs you, what you can finish and what goes on without you, as a list or a board by stage. */
export function OverviewPage({api, initialView, ready}: {api: OverviewApi; initialView: View;
  /** The copies are known: reading before that would read without them and again after. */
  ready: boolean}) {
  const t = useT();
  const {language} = useLanguage();
  const [view, setView] = useState<View>(initialView);
  const [data, setData] = useState<OverviewData | null>(null);
  const [merged, setMerged] = useState<InboxPr[] | null | undefined>(undefined);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const request = useRef(0);
  const read = useCallback((refresh: boolean) => {
    const call = ++request.current;
    setLoading(true);
    setError("");
    // Only the latest read shows: an earlier one answering late changes nothing.
    api.load(refresh).then(value => { if (call === request.current) { setData(value); setNow(Date.now()); } },
      (failure: unknown) => { if (call === request.current) setError(failure instanceof Error ? failure.message : String(failure)); })
      .finally(() => { if (call === request.current) setLoading(false); });
    if (refresh) setMerged(undefined);
  }, [api]);
  useEffect(() => { if (ready) read(false); }, [ready, read]);
  useEffect(() => { setView(initialView); }, [initialView]);
  // The board's last stage reads merged pull requests, only when the board is shown.
  useEffect(() => {
    if (view !== "board" || merged !== undefined || !ready) return;
    let active = true;
    api.merged(false).then(value => { if (active) setMerged(value); }, () => { if (active) setMerged(null); });
    return () => { active = false; };
  }, [api, view, merged, ready]);
  const items = useMemo(() => data ? overviewItems({...data.input, merged: []}) : [], [data]);
  const current = items.find(item => item.key === selected) ?? items[0] ?? null;
  const choose = (next: View) => {
    setView(next);
    setNotice("");
    api.saveView(next).catch(() => setNotice(t("ov.view-unsaved")));
  };
  const failed: OverviewSource[] = [...(data?.failed ?? []), ...(view === "board" && merged === null ? ["merged" as const] : [])];
  const sources = failed.map(source => source === "copies" ? t("ov.src.copies", {n: data?.copiesFailed ?? 0}) : t(("ov.src." + source) as MessageKey)).join(", ");

  return <div className="g-page git-overview">
    <PageHead title={t("section.overview")} sub={data ? t("ov.sub", {copies: data.copies, when: ago(language, now, new Date(data.at).toISOString())}) : undefined}
      actions={<>
        <div className="g-seg" role="group" aria-label={t("ov.view")}>
          {(["list", "board"] as const).map(option => <button key={option} type="button" aria-pressed={view === option} onClick={() => choose(option)}>
            <Icon name={option === "list" ? "ListView" : "GridView"} small/>{t(option === "list" ? "ov.list" : "ov.board")}
          </button>)}
        </div>
        <button type="button" className="g-btn" disabled={loading || !ready} onClick={() => read(true)}><Icon name="RotateCcw" small/>{t("ov.refresh")}</button>
      </>}/>
    {error && <div className="g-banner bad" role="alert">{error}</div>}
    {failed.length > 0 && <div className="g-banner warn" role="status">{t("ov.partial", {sources})}</div>}
    {data?.limited && <div className="g-banner" role="status">{t("ov.limited", {n: data.limited})}</div>}
    {notice && <div className="g-banner" role="status">{notice}</div>}
    {!data && !error && <p className="g-state-page" role="status">{t("common.loading")}</p>}
    {data && view === "list" && (items.length === 0
      ? <div className="g-state-page" role="status"><strong>{t("ov.empty")}</strong></div>
      : <div className="git-overview-split">
        <List items={items} current={current} now={now} onSelect={setSelected} onOpen={item => { const target = targetOf(item); if (target) api.open(target); }}/>
        {current && <Details item={current} api={api}/>}
      </div>)}
    {data && view === "board" && <Board data={data} merged={merged ?? []} now={now} api={api}/>}
  </div>;
}

function List({items, current, now, onSelect, onOpen}: {items: OverviewItem[]; current: OverviewItem | null; now: number;
  onSelect(key: string): void; onOpen(item: OverviewItem): void}) {
  const t = useT();
  const {language} = useLanguage();
  const list = useRef<HTMLDivElement>(null);
  const focus = (item: OverviewItem | undefined) => {
    if (!item) return;
    onSelect(item.key);
    list.current?.querySelector<HTMLElement>("[data-key=\"" + CSS.escape(item.key) + "\"]")?.focus();
  };
  // j/k and the arrows move through the items, Home/End to the ends; Enter on an item takes its action.
  const keys = (event: KeyboardEvent) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const index = items.findIndex(item => item.key === current?.key);
    const target = event.key === "j" || event.key === "ArrowDown" ? items[Math.min(items.length - 1, index + 1)]
      : event.key === "k" || event.key === "ArrowUp" ? items[Math.max(0, index - 1)]
      : event.key === "Home" ? items[0] : event.key === "End" ? items[items.length - 1] : undefined;
    if (target) { event.preventDefault(); focus(target); }
  };
  return <div className="git-overview-list" ref={list} onKeyDown={keys}>
    {groups.map(group => {
      const rows = items.filter(item => item.group === group);
      if (!rows.length) return null;
      return <section key={group} aria-labelledby={"git-ov-" + group}>
        <h2 className="g-sec git-overview-group" id={"git-ov-" + group}>{t(("ov.group." + group) as MessageKey)} <span className="g-num">{rows.length}</span></h2>
        <ul aria-labelledby={"git-ov-" + group}>
          {rows.map(item => {
            const here = item.key === current?.key;
            const tone = tones[item.kind] && "g-" + tones[item.kind];
            return <li key={item.key} className={"g-it" + (here ? " sel" : "")}>
              <button type="button" className="git-overview-row" data-key={item.key} aria-current={here ? "true" : undefined} tabIndex={here ? 0 : -1}
                onClick={() => onSelect(item.key)} onFocus={() => onSelect(item.key)} onDoubleClick={() => onOpen(item)}
                onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); onOpen(item); } }}>
                <span className={tone}><Icon name={icons[item.kind]}/></span>
                <span className="git-overview-text">
                  <span className="git-overview-title"><span className={"git-overview-kind " + tone}>{t(("ov.kind." + item.kind) as MessageKey)}</span>
                    <span className="g-ell">{titleOf(item)}</span></span>
                  <span className="g-muted git-overview-meta g-ell">{metaOf(t, item)}</span>
                </span>
                <span className="g-muted g-num git-overview-when">{ago(language, now, item.at)}</span>
              </button>
              <button type="button" className="g-btn sm" tabIndex={here ? 0 : -1} onClick={() => onOpen(item)}>{t(actionOf(item))}</button>
            </li>;
          })}
        </ul>
      </section>;
    })}
  </div>;
}

const titleOf = (item: Pick<OverviewItem, "pr" | "copy" | "run" | "repository">) =>
  item.pr?.title ?? (item.copy ? item.copy.name : item.run ? item.run.title : item.repository ?? "");
function metaOf(t: T, item: Pick<OverviewItem, "pr" | "copy" | "run" | "repository"> & {kind?: OverviewKind}): string {
  const pr = item.pr;
  if (pr && item.kind === "review") return t("ov.meta.review", {repo: pr.repo, number: pr.number, author: pr.author});
  if (pr && item.kind === "threads") return t("ov.meta.threads", {repo: pr.repo, number: pr.number, n: pr.unresolvedThreads});
  if (pr) return pr.headRefName ? t("ov.meta.pr", {repo: pr.repo, number: pr.number, branch: pr.headRefName}) : pr.repo + " #" + pr.number;
  if (item.copy && item.kind === "behind") return t("ov.meta.behind", {branch: item.copy.branch ?? "HEAD", n: item.copy.behind});
  if (item.copy) return item.copy.upstream === null ? t("ov.meta.unpublished", {branch: item.copy.branch ?? "HEAD"})
    : t("ov.meta.unpushed", {branch: item.copy.branch ?? "HEAD", n: item.copy.ahead});
  if (item.run) return t("ov.meta.run", {repository: item.repository ?? "", workflow: item.run.workflow, branch: item.run.branch ?? ""});
  return "";
}

function Details({item, api}: {item: OverviewItem; api: OverviewApi}) {
  const t = useT();
  const target = targetOf(item);
  const pr = item.pr;
  const blockers = pr ? blockerList(pr) : [];
  const tone = tones[item.kind];
  return <aside className="git-overview-details" aria-label={t("ov.details")}>
    <div className="g-muted git-overview-meta">{metaOf(t, item)}</div>
    <h2>{titleOf(item)}{pr ? <span className="g-muted"> #{pr.number}</span> : null}</h2>
    <div className="git-overview-chips">
      <span className={"g-chip " + (tone || "line")}>{t(("ov.kind." + item.kind) as MessageKey)}</span>
      {pr && pr.additions !== null && <span className="g-num"><span className="g-good">+{pr.additions}</span> <span className="g-bad">−{pr.deletions ?? 0}</span></span>}
    </div>
    {pr && item.kind !== "review" && <section>
      <h3 className="g-sec">{t("ov.blockers")}</h3>
      {blockers.length ? <ul className="git-overview-blockers">{blockers.map((blocker, index) => <li key={index}><Icon name="AlertCircle" small/>{blockerText(t, blocker)}</li>)}</ul>
        : <p className="g-muted">{t("ov.no-blockers")}</p>}
      {pr.failingChecks.length > 0 && <div className="git-overview-chips">{pr.failingChecks.map(check => <span key={check.name} className="g-chip bad">{check.name}</span>)}</div>}
    </section>}
    <div className="git-overview-actions">
      {target && <button type="button" className="g-btn pri" onClick={() => api.open(target)}>{t(actionOf(item))}</button>}
      {pr && <api.Link href={pr.url}>{t("ov.on-forge")}</api.Link>}
    </div>
  </aside>;
}

function Board({data, merged, now, api}: {data: OverviewData; merged: InboxPr[]; now: number; api: OverviewApi}) {
  const t = useT();
  const {language} = useLanguage();
  const stages = useMemo(() => overviewStages({...data.input, merged}), [data, merged]);
  const card = (item: BoardCard) => {
    const target = targetOf(item);
    const blockers = item.pr ? blockerList(item.pr).map(blocker => blockerText(t, blocker)).join(" · ") : "";
    return <li key={item.key}>
      <button type="button" className="git-overview-card" disabled={!target} onClick={() => { if (target) api.open(target); }}>
        <span className="g-muted git-overview-meta g-ell">{item.pr ? item.pr.repo + " #" + item.pr.number : item.copy ? item.copy.branch ?? "" : item.repository ?? ""}</span>
        <span className="git-overview-card-title">{titleOf(item)}</span>
        <span className="g-muted git-overview-meta">{item.pr ? blockers || ago(language, now, item.at)
          : item.copy ? metaOf(t, item) : ago(language, now, item.at)}</span>
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
