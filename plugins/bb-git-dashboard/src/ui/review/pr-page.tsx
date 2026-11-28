import { useCallback, useEffect, useMemo, useState } from "react";
import type { MessageKey } from "../../core/i18n/dictionary.ts";
import type { PrAction } from "../../core/pulls/actions.ts";
import { threadFilter } from "../../core/pulls/detail.ts";
import type { ReviewEvent } from "../../core/pulls/review.ts";
import { ConfirmDialog } from "../ci/confirm-dialog.tsx";
import { useT } from "../i18n/use-t.tsx";
import { Icon } from "../system/icon.tsx";
import { useAutoRetry } from "./auto-retry.ts";
import type { DraftComment } from "./diff-view.tsx";
import { PrChecks } from "./pr-checks.tsx";
import { PrComments } from "./pr-comments.tsx";
import { PrCommits } from "./pr-commits.tsx";
import { PrFiles } from "./pr-files.tsx";
import { PrMenu } from "./pr-menu.tsx";
import { PrOverview } from "./pr-overview.tsx";
import { PrText, PrTitle } from "./pr-text.tsx";
import { RateLimited } from "./rate-limited.tsx";
import { message, type AgentDraft, type PrFileView, type PrRef, type PrView, type Preview, type ReviewApi } from "./review-api.ts";
import { afterWrite, emptyForms, type PrForms } from "./pr-forms.ts";
import "./review.css";

/** Side by side or unified, kept across pull requests and visits. */
const SPLIT_KEY = "bb-git-dashboard:pr-split";
const tabs = ["Overview", "Checks", "Files", "Commits", "Comments"] as const;
type Tab = typeof tabs[number];
const forgeNames = {github: "GitHub", gitlab: "GitLab", gitea: "Gitea", azure: "Azure DevOps"} as const;

/** A pull request: its head (path, place in the list, title and state, the branches), then Overview, Checks, Files, Commits and Comments. */
export function PrPage({api, accountId, repo, number, onStep, position, revision = 0, onList, onPin}: {api: ReviewApi; accountId: string; repo: string; number: number; onStep?(step: -1 | 1): void;
  /** Pins this pull request as its own tab beside the thread. */
  onPin?(): Promise<"opened" | "selected">;
  /** Where this pull request is in the My PRs list it was opened from (0-based); absent when opened from elsewhere. */
  position?: {index: number; total: number};
  /** Changes when an agent's answer may have arrived: the drafts are read again. */
  revision?: number;
  /** Goes back to My PRs (the path's first step). */
  onList?(): void}) {
  const t = useT();
  // Kept by value: a re-render of the app (an alert arriving) must not reload the page and drop a review in progress.
  const target = useMemo<PrRef>(() => ({accountId, repo, number}), [accountId, repo, number]);
  const [view, setView] = useState<PrView | null>(null);
  const [files, setFiles] = useState<PrFileView[] | null>(null);
  const [tab, setTab] = useState<Tab>("Overview");
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<(Preview & {title: string; kind: PrAction["kind"]; after?: () => Promise<void>}) | null>(null);
  // Agents' answers on review threads, kept for the owner to post (sent there with Fix with agent).
  const [agentDrafts, setAgentDrafts] = useState<AgentDraft[]>([]);
  const readDrafts = useCallback(() => { api.drafts(target).then(setAgentDrafts, () => {}); }, [api, target]);
  useEffect(readDrafts, [readDrafts, revision]);
  const [notice, setNotice] = useState("");
  const [drafts, setDrafts] = useState<DraftComment[]>([]);
  const [wrap, setWrap] = useState(false);
  const [split, setSplitState] = useState(() => { try { return localStorage.getItem(SPLIT_KEY) === "1"; } catch { return false; } });
  const setSplit = (value: boolean) => { setSplitState(value); try { localStorage.setItem(SPLIT_KEY, value ? "1" : "0"); } catch { /* the choice lasts for this visit */ } };
  const [title, setTitle] = useState<string | null>(null);
  // The forms' text lives here: a tab change keeps it, and a write starts again only the form that made it.
  const [forms, setForms] = useState<PrForms>(emptyForms);
  const form = useCallback((patch: Partial<PrForms>) => setForms(previous => ({...previous, ...patch})), []);

  const retry = useAutoRetry(() => void load());
  const load = useCallback(async () => {
    setError("");
    try { setView(await api.detail(target)); }
    catch (failure) { if (!retry.schedule(failure)) setError(message(failure)); }
  }, [api, target, retry.schedule]);
  // Another pull request starts the page over; a new reader of the same one (the app re-rendered) only reads it again.
  useEffect(() => { setView(null); setFiles(null); setDrafts([]); setForms(emptyForms); setTab("Overview"); }, [target]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (tab !== "Files" || files) return;
    api.files(target).then(setFiles, failure => setError(message(failure)));
  }, [api, target, tab, files]);
  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      const element = event.target as HTMLElement;
      if (event.metaKey || event.ctrlKey || event.altKey || element.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName)) return;
      if (document.querySelector("dialog[open]")) return;
      if (event.key === "[" && onStep) onStep(-1);
      if (event.key === "]" && onStep) onStep(1);
      // On Files: j / k step through the files, n / p through the open comment threads; on Comments n / p through the threads.
      const files = tab === "Files" && (event.key === "j" || event.key === "k");
      const threads = (tab === "Files" || tab === "Comments") && (event.key === "n" || event.key === "p");
      if (!files && !threads) return;
      const step = event.key === "j" || event.key === "n" ? 1 : -1;
      const selector = files ? ".git-pr-file-diffs > .git-review-file" : tab === "Files" ? ".git-pr-file-diffs .git-review-thread:not([data-resolved])" : ".git-pr-threads > .git-pr-thread";
      const targets = Array.from(document.querySelectorAll<HTMLElement>(selector));
      if (!targets.length) return;
      event.preventDefault();
      const at = targets.findIndex(item => item === document.activeElement || item.contains(document.activeElement));
      const next = targets[at === -1 ? (step > 0 ? 0 : targets.length - 1) : Math.min(targets.length - 1, Math.max(0, at + step))]!;
      next.scrollIntoView({block: "start"});
      next.focus({preventScroll: true});
    };
    window.addEventListener("keydown", keys);
    return () => window.removeEventListener("keydown", keys);
  }, [onStep, tab]);
  // To line: the Files tab opens, and once its files are read the thread is brought into view.
  const [shown, setShown] = useState<string | null>(null);
  useEffect(() => {
    if (!shown || tab !== "Files" || !files) return;
    const thread = Array.from(document.querySelectorAll<HTMLElement>(".git-pr-file-diffs .git-review-thread")).find(element => element.dataset.threadId === shown);
    setShown(null);
    thread?.scrollIntoView({block: "center"});
    thread?.focus({preventScroll: true});
  }, [shown, tab, files]);

  const act = async (action: PrAction, label: string, after?: () => Promise<void>) => {
    setNotice("");
    try { setPreview({...await api.prepare(target, action, view?.detail.headSha ?? null), title: label, kind: action.kind, after}); }
    catch (failure) { setNotice(message(failure)); }
  };
  const labelOf = (action: PrAction) => action.kind === "lineComment" ? t("pr.line-comment") : action.kind === "resolve" ? (action.resolved ? t("pr.resolve") : t("pr.unresolve"))
    : action.kind === "deleteComment" ? t("pr.delete") : t("pr.reply");
  const ask = async (subject: Parameters<ReviewApi["ask"]>[1]) => {
    setNotice("");
    try { const result = await api.ask(target, subject); setNotice(result.created ? t("pr.agent-started") : t("pr.agent-sent")); api.openThread(result.threadId); }
    catch (failure) { setNotice(message(failure)); }
  };
  if (!view) return <div className="g-page git-review">
    {retry.left !== null ? <RateLimited left={retry.left} onNow={() => { retry.cancel(); void load(); }}/>
      : error ? <div className="g-banner bad" role="alert">{error}</div> : <p className="g-state-page" role="status">{t("pr.loading")}</p>}</div>;
  const {detail, capabilities: can} = view;
  const open = detail.state === "OPEN";
  const lists = threadFilter(detail.threads, detail.viewer, detail.author);
  const published = lists.unresolved.length + lists.resolved.length;
  const state = detail.isDraft && open ? "DRAFT" : detail.state;
  const own = !!detail.viewer && detail.viewer === detail.author;
  const counts: Partial<Record<Tab, string>> = {Checks: detail.checks.length ? String(detail.checks.length) : undefined, Files: String(detail.changedFiles),
    Commits: String(detail.commitCount), Comments: published ? t("pr.of", {open: lists.unresolved.length, all: published}) : undefined};

  return <PrText api={api} pr={detail}><div className="g-page git-review" role="region" aria-label={t("pr.region", {repo: detail.repo, n: detail.number})}>
    <header className="git-pr-head">
      <div className="git-pr-crumbs">
        <nav aria-label={t("pr.crumbs")} className="git-pr-path">
          {onList ? <button type="button" className="g-btn ghost sm" onClick={onList}>{t("section.inbox")}</button> : <span>{t("section.inbox")}</span>}
          <Icon name="ChevronRight" small/><span className="g-muted">{detail.repo}</span>
        </nav>
        {position && onStep && <span className="git-pr-step" role="group" aria-label={t("pr.list")} title={t("pr.step-hint")}>
          <button type="button" className="g-btn ghost sm" aria-label={t("pr.prev")} disabled={position.index === 0} onClick={() => onStep(-1)}><Icon name="ChevronLeft" small/></button>
          <span className="g-muted g-num">{t("pr.position", {n: position.index + 1, total: position.total})}</span>
          <button type="button" className="g-btn ghost sm" aria-label={t("pr.next")} disabled={position.index >= position.total - 1} onClick={() => onStep(1)}><Icon name="ChevronRight" small/></button>
        </span>}
      </div>
      <div className="git-pr-title-row">
        {title === null ? <h1><PrTitle title={detail.title}/> <span className="g-muted">#{detail.number}</span></h1>
          : <form className="git-pr-form-row" onSubmit={submit => { submit.preventDefault(); if (title.trim()) void act({kind: "editTitle", title}, t("pr.edit-title")); }}>
            <input className="g-inp" aria-label={t("pr.title")} value={title} onChange={change => setTitle(change.target.value)}/>
            <button type="submit" className="g-btn pri">{t("pr.save")}</button><button type="button" className="g-btn" onClick={() => setTitle(null)}>{t("pr.cancel")}</button></form>}
        <span className={"g-chip " + (state === "OPEN" ? "good" : state === "MERGED" ? "vio" : "line")}>{t(("pr.state." + state) as MessageKey)}</span>
        {title === null && can.editTitle && detail.canEdit && <button type="button" className="g-btn ghost sm" aria-label={t("pr.edit-title")} onClick={() => setTitle(detail.title)}><Icon name="Edit" small/></button>}
        <span className="git-pr-head-actions">
          {detail.url && <span className="git-pr-forge"><api.Link href={detail.url}><Icon name="ExternalLink" small/>{t("pr.on-forge", {forge: forgeNames[detail.forge]})}</api.Link></span>}
          <PrMenu api={api} target={target} url={detail.url} onRefresh={() => { void load(); readDrafts(); }} onNotice={setNotice} onPin={onPin}/>
        </span>
      </div>
      <p className="git-pr-branches g-muted">
        {own ? t("pr.you-want") : t("pr.wants", {author: detail.author})}{" "}
        <button type="button" className="g-branch git-pr-branch" title={t("pr.copy-branch")} onClick={() => { api.copy(detail.headRefName); setNotice(t("pr.branch-copied")); }}>{detail.headRefName}</button>
        <Icon name="ArrowRight" small/><span className="g-branch">{detail.baseRefName}</span>
        {" · "}{t("pr.commits", {n: detail.commitCount})}
        {detail.additions + detail.deletions > 0 && <> · <span className="g-good">+{detail.additions}</span> <span className="g-bad">−{detail.deletions}</span></>}
        {detail.stackedOn && <> · {t("pr.stacked", {n: detail.stackedOn.number})}</>}
        {detail.labels.map(label => <span key={label.name} className="g-chip line">{label.name}</span>)}
      </p>
    </header>
    <div className="g-views" role="tablist" aria-label={t("pr.sections")}>
      {tabs.map(name => <button key={name} id={"git-pr-" + name} type="button" role="tab" aria-selected={name === tab} aria-controls="git-pr-panel"
        tabIndex={name === tab ? 0 : -1} data-tab={name} onClick={() => setTab(name)} onKeyDown={event => {
          const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
          const next = event.key === "Home" ? tabs[0]! : event.key === "End" ? tabs[tabs.length - 1]! : step ? tabs[(tabs.indexOf(name) + step + tabs.length) % tabs.length]! : null;
          if (!next) return;
          event.preventDefault();
          setTab(next);
          (event.currentTarget.parentElement?.querySelector("[data-tab=\"" + next + "\"]") as HTMLElement | null)?.focus();
        }}>{t(("pr.tab." + name.toLowerCase()) as MessageKey)}{counts[name] && <span className="g-num g-muted">{counts[name]}</span>}</button>)}
    </div>
    {notice && <div className="g-banner" role="status">{notice}</div>}
    {(detail.notices ?? []).length > 0 && <ul className="g-banner warn git-pr-notices" aria-label={t("pr.not-read")}>{detail.notices!.map(line => <li key={line}>{line}</li>)}</ul>}
    {error && <div className="g-banner bad" role="alert">{error}</div>}
    <div role="tabpanel" id="git-pr-panel" aria-labelledby={"git-pr-" + tab} className="git-pr-panel">
      {tab === "Overview" && <PrOverview view={view} forms={forms} form={form} act={(action, label) => void act(action, label)} ask={() => void ask({kind: "all"})} onTab={setTab}/>}
      {tab === "Checks" && <PrChecks view={view} ask={subject => void ask(subject)} Link={api.Link}/>}
      {tab === "Files" && <PrFiles view={view} files={files} split={split} wrap={wrap} drafts={drafts.length} onSplit={setSplit} onWrap={setWrap}
        act={action => void act(action, labelOf(action))} ask={thread => void ask({kind: "thread", threadId: thread.id})} onDraft={draft => setDrafts(previous => [...previous, draft])}
        onReview={() => setTab("Comments")}/>}
      {tab === "Commits" && <PrCommits view={view} onCopy={sha => { api.copy(sha); setNotice(t("pr.sha-copied")); }}/>}
      {tab === "Comments" && <PrComments view={view} forms={forms} form={form} drafts={agentDrafts} lineDrafts={drafts} act={action => void act(action, labelOf(action))}
        ask={thread => void ask({kind: "thread", threadId: thread.id})} onShow={thread => { setTab("Files"); setShown(thread.id); }}
        onPost={(thread, draft, resolve) => void act({kind: "reply", threadId: thread.id, body: draft.body}, resolve ? t("pr.send-resolve") : t("pr.send"), async () => {
          await api.dropDraft(draft.commentId);
          readDrafts();
          // Resolving is a step of its own, confirmed like any other.
          if (resolve && thread.canToggleResolved && !thread.isResolved) await act({kind: "resolve", threadId: thread.id, resolved: true}, t("pr.resolve"));
        })}
        onEdit={async (draft, body) => { await api.editDraft(draft.commentId, body); readDrafts(); }}
        onDiscard={async draft => { await api.dropDraft(draft.commentId); readDrafts(); }}
        onSubmit={(event: ReviewEvent, summary) => void act({kind: "review", event, body: summary, comments: drafts}, t(("pr.ev." + event) as MessageKey))}
        onDropLineDrafts={() => setDrafts([])}/>}
    </div>
    {preview && <ConfirmDialog title={preview.title} lines={preview.lines} onConfirm={async () => {
      const result = await api.confirm(preview.id);
      setNotice(result.outcome === "accepted" ? t("pr.accepted") : t("pr.done"));
    }} onClose={done => {
      const after = preview.after;
      setPreview(null);
      if (done && after) after().catch(failure => setNotice(message(failure)));
      if (done) { setTitle(null); setForms(previous => afterWrite(previous, preview.kind)); if (preview.kind === "review") setDrafts([]); setFiles(null); void load(); }
    }}/>}
  </div></PrText>;
}
