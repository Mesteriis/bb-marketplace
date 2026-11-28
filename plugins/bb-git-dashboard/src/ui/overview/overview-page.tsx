import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { MessageKey } from "../../core/i18n/dictionary.ts";
import { ago } from "../../core/i18n/time.ts";
import { blockerList, blockerSense, overviewItems, type Blocker, type OverviewGroup, type OverviewItem, type OverviewKind } from "../../core/overview/items.ts";
import { overviewStages, type BoardCard } from "../../core/overview/stages.ts";
import { inCategory } from "../../core/overview/category.ts";
import { copyRepositories } from "../../core/projects/table.ts";
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
// A blocker's icon and colour say what it is: failed, waiting, or for someone to do; nothing in the way is a check.
const senses = {failed: {icon: "CircleX", tone: "g-bad"}, waiting: {icon: "Clock", tone: "g-muted"}, todo: {icon: "AlertCircle", tone: "g-warn"}} as const;
function blockerText(t: T, blocker: Blocker): string {
  if (blocker.key === "note") return blocker.text;
  if (blocker.key === "ci-failing") return blocker.n ? t("ov.b.ci-failing-n", {n: blocker.n}) : t("ov.b.ci-failing");
  return t(("ov.b." + blocker.key) as MessageKey, blocker.n === undefined ? {} : {n: blocker.n});
}

/** The overview: what needs you, what you can finish and what goes on without you, as a list or a board by stage. */
export function OverviewPage({api, initialView, ready, categories = new Map(), groups = new Map()}: {api: OverviewApi; initialView: View;
  /** Each copy's Git directory (copy id → key): worktrees of one repository share its pull requests and runs. */
  groups?: Map<string, string>;
  /** Each copy's category (copy id → the top folder of its project), for the filter in the head. */
  categories?: Map<string, string>;
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
  const [category, setCategory] = useState<string | null>(null);
  const names = useMemo(() => [...new Set(categories.values())].filter(Boolean).sort((a, b) => a.localeCompare(b)), [categories]);
  const chosen = category !== null && names.includes(category) ? category : null;
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
  // The chosen category narrows what was read; reading again is not needed.
  const shown = useMemo(() => {
    if (!data) return null;
    const narrowed = inCategory({...data.input, merged: merged ?? []}, chosen, categories, copyRepositories(data.input.runs, groups));
    return {data: {...data, input: {...narrowed, merged: undefined}}, merged: narrowed.merged};
  }, [data, merged, chosen, categories, groups]);
  const items = useMemo(() => shown ? overviewItems({...shown.data.input, merged: []}) : [], [shown]);
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
        {names.length > 1 && <div className="g-seg" role="group" aria-label={t("ov.category")}>
          {[null, ...names].map(name => <button key={name ?? ""} type="button" aria-pressed={chosen === name} onClick={() => setCategory(name)}>
            {name ?? t("ov.category.all")}</button>)}
        </div>}
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
    {data && view === "board" && <Board data={shown!.data} merged={shown!.merged} mergedLoading={merged === undefined} now={now} api={api}/>}
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
      {blockers.length ? <ul className="git-overview-blockers">{blockers.map((blocker, index) => {
        const sense = senses[blockerSense(blocker)];
        return <li key={index} className={sense.tone}><Icon name={sense.icon} small/><span>{blockerText(t, blocker)}</span></li>;
      })}</ul>
        : <p className="git-overview-clear g-good"><Icon name="CircleCheck" small/><span>{t("ov.no-blockers")}</span></p>}
      {pr.failingChecks.length > 0 && <div className="git-overview-chips">{pr.failingChecks.map(check => <span key={check.name} className="g-chip bad">{check.name}</span>)}</div>}
    </section>}
    <div className="git-overview-actions">
      {target && <button type="button" className="g-btn pri" onClick={() => api.open(target)}>{t(actionOf(item))}</button>}
      {pr && <api.Link href={pr.url}>{t("ov.on-forge")}</api.Link>}
    </div>
  </aside>;
}

function Board({data, merged, mergedLoading, now, api}: {data: OverviewData; merged: InboxPr[];
  /** Merged pull requests are still being read: their column says so rather than "nothing here". */
  mergedLoading: boolean; now: number; api: OverviewApi}) {
  const t = useT();
  const {language} = useLanguage();
  const stages = useMemo(() => overviewStages({...data.input, merged}), [data, merged]);
  const columns: [MessageKey, BoardCard[], boolean][] = [["ov.stage.local", stages.local, false], ["ov.stage.open", stages.open, false],
    ["ov.stage.review", stages.review, false], ["ov.stage.ready", stages.ready, false], ["ov.stage.merged", stages.merged, true]];
  return <div className="git-overview-board">
    <section className="git-overview-now" aria-label={t("ov.stage.ci")}>
      <h2 className="git-overview-now-title"><Icon name="Workflow" small/>{t("ov.stage.ci")}</h2>
      {stages.ciNow.length ? <ul>{stages.ciNow.map(item => {
        const target = targetOf(item);
        const failedRun = item.kind === "ci-failed";
        const label = (item.pr ? item.pr.repo + " #" + item.pr.number : (item.repository ?? "") + " · " + (item.run?.workflow ?? ""))
          + " · " + (failedRun ? t("ov.ci.failed", {when: ago(language, now, item.at)}) : t("ov.ci.running", {when: ago(language, now, item.at)}));
        return <li key={"now-" + item.key}>
          <button type="button" className={"git-overview-now-item" + (failedRun ? " g-bad" : "")} disabled={!target} onClick={() => { if (target) api.open(target); }}>
            <Icon name={failedRun ? "CircleX" : "Clock"} small/>{label}
          </button>
        </li>;
      })}</ul> : <p className="g-muted">{t("ov.stage.none")}</p>}
      <button type="button" className="g-btn ghost sm git-overview-all-runs" onClick={() => api.open({kind: "ci"})}>{t("ov.all-runs")}<Icon name="ArrowRight" small/></button>
    </section>
    <div className="git-overview-columns g-scroll">
      {columns.map(([label, cards, old]) => <section key={label} className="git-overview-column" aria-label={t(label)}>
        <h2 className="git-overview-column-head">{t(label)} <span className="g-num g-muted">{cards.length}</span></h2>
        {cards.length ? <ul>{cards.map(card => <Card key={card.key} card={card} old={old} now={now} api={api}/>)}</ul>
          : <p className="g-muted" role={old && mergedLoading ? "status" : undefined}>{t(old && mergedLoading ? "common.loading" : "ov.stage.none")}</p>}
      </section>)}
    </div>
  </div>;
}

/**
 * A card of the board: where it is from, its title, its state as a word with an icon (and a coloured edge), and the
 * same one action as the list's row. A click anywhere on the card takes the action too; the keyboard reaches the button.
 */
function Card({card, old, now, api}: {card: BoardCard; old: boolean; now: number; api: OverviewApi}) {
  const t = useT();
  const {language} = useLanguage();
  const target = targetOf(card);
  const pr = card.pr;
  const tone = card.kind ? tones[card.kind] : "";
  const action: MessageKey = card.kind ? actionOf({...card, kind: card.kind, group: "action"}) : pr ? "ov.do.open-pr" : "ov.do.copy";
  const state = (() => {
    if (old && pr) return t("ov.card.merged", {when: ago(language, now, card.at)});
    if (card.kind === "review" && pr) return t("ov.card.waiting-you", {author: pr.author});
    if (card.copy) {
      const parts = [card.copy.upstream === null && card.copy.branch !== null ? t("ov.card.unpublished") : card.copy.ahead ? t("ov.card.ahead", {n: card.copy.ahead}) : "",
        card.copy.behind ? t("ov.card.behind", {n: card.copy.behind}) : ""].filter(Boolean);
      return parts.join(" · ");
    }
    // The card's state first, then what else blocks it; a blocker that is the state itself is not said twice.
    const same: Partial<Record<OverviewKind, Blocker["key"]>> = {"ci-failed": "ci-failing", conflict: "conflicts", changes: "changes", "ci-running": "ci-running", threads: "threads"};
    if (pr) return [card.kind ? t(("ov.kind." + card.kind) as MessageKey) : "",
      ...blockerList(pr).filter(blocker => !card.kind || blocker.key !== same[card.kind]).map(blocker => blockerText(t, blocker))].filter(Boolean).join(" · ");
    return "";
  })();
  const open = () => { if (target) api.open(target); };
  return <li className={"git-overview-card" + (old ? " old" : "") + (tone ? " " + tone : "")} onClick={open}>
    <span className="g-muted git-overview-meta g-ell">{pr ? pr.repo + " #" + pr.number : card.copy ? card.copy.name : card.repository ?? ""}</span>
    <span className="git-overview-card-title">{pr ? pr.title : card.copy?.branch ?? "HEAD"}</span>
    {pr && pr.headRefName && !old ? <span className="g-branch">{pr.headRefName}</span> : null}
    {state && <span className={"git-overview-card-state " + (tone ? "g-" + tone : "g-muted")}>
      <Icon name={old ? "GitMerge" : card.kind ? icons[card.kind] : "GitPullRequestDraft"} small/>{state}</span>}
    {!old && <span className="g-muted git-overview-meta">{ago(language, now, card.at)}</span>}
    {target && <span><button type="button" className={"g-btn sm" + (old ? " ghost" : "")} onClick={event => { event.stopPropagation(); open(); }}
      onKeyDown={event => { if (event.key === "Enter") event.stopPropagation(); }}>{t(action)}</button></span>}
  </li>;
}
