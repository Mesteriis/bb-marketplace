import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { Run } from "../../core/ci/model.ts";
import type { GitResult } from "../../core/git.ts";
import { ago } from "../../core/i18n/time.ts";
import { branchRun } from "../../core/panel/summary.ts";
import type { InboxPr } from "../../core/pulls/model.ts";
import type { Copy, Operation } from "../../core/workspace.ts";
import type { CiApi } from "../ci/ci-api.ts";
import { CiPanel, type CiView } from "../ci/ci-panel.tsx";
import type { CodeReviewApi } from "../code-review/review-api.ts";
import { ReviewPanel } from "../code-review/review-panel.tsx";
import type { HistoryApi } from "../history/history-api.ts";
import { HistoryPanel } from "../history/history-panel.tsx";
import { useLanguage, useT } from "../i18n/use-t.tsx";
import { Icon } from "../system/icon.tsx";
import { Worktree, type RunGit } from "../worktree.tsx";
import { PanelHead } from "./panel-head.tsx";
import { ChangesBody, CiBody, PullBody, RunState, Section } from "./sections.tsx";
import "./panel.css";

export type PanelScreen = {kind: "summary"} | {kind: "changes"} | {kind: "ci"; view: CiView} | {kind: "review"} | {kind: "history"};
/** What the panel's summary reads besides Git: the branch's pull request, the forge's name, the open review comments. */
export type PanelApi = {
  /** The open pull request from this branch of this copy, from My PRs; null when there is none or it could not be read. */
  pull(copy: Copy, branch: string | null): Promise<InboxPr | null>;
  /** The forge the copy's origin is on, by name (GitHub, GitLab, …); null when it is not known. */
  forge(copyId: string): Promise<string | null>;
  /** The copy's open and all comment threads over its line reviews. */
  reviewCounts(copyId: string): Promise<{open: number; total: number}>;
};
type Part = "changes" | "pull" | "ci" | "review" | "history";
// Which parts are folded, for the browser tab's life: the panel opens as it was left.
const folded = new Set<Part>(["history"]);

/**
 * The Git panel of a working copy beside a thread: a head with Pull and Push, then a summary — changes with their
 * commit, the branch's pull request, its CI, the review, the history — each folding, and each opening its full screen
 * in the panel with a way back.
 */
export function GitPanel({copy, host, run, refresh, loadOperations, api, ci, history, review, threadId, reviewRevision, graph, screen, onScreen, onOpenPull, note, footer}: {
  copy: Copy; host: string; run: RunGit; refresh: number; loadOperations(): Promise<Operation[]>;
  api: PanelApi; ci: CiApi; history: HistoryApi; review: CodeReviewApi;
  /** The thread the panel stands beside; a pinned copy has none of its own. */
  threadId?: string; reviewRevision: number; graph: boolean;
  screen: PanelScreen; onScreen(screen: PanelScreen): void;
  onOpenPull(pull: InboxPr): void;
  note?: ReactNode; footer?: ReactNode;
}) {
  const t = useT();
  const {language} = useLanguage();
  const [revision, setRevision] = useState(0);
  const changed = useCallback(() => setRevision(value => value + 1), []);
  const [state, setState] = useState<GitResult | null>(null);
  const [error, setError] = useState("");
  const [forge, setForge] = useState<string | null>(null);
  const [pull, setPull] = useState<InboxPr | null | undefined>(undefined);
  const [latest, setLatest] = useState<Run | null | undefined>(undefined);
  const [ciNote, setCiNote] = useState("");
  const [counts, setCounts] = useState<{open: number; total: number} | null>(null);
  const [last, setLast] = useState<string | null>(null);
  const [open, setOpen] = useState(() => new Set<Part>((["changes", "pull", "ci", "review", "history"] as Part[]).filter(part => !folded.has(part))));
  const toggle = (part: Part) => setOpen(previous => {
    const next = new Set(previous);
    if (next.has(part)) { next.delete(part); folded.add(part); } else { next.add(part); folded.delete(part); }
    return next;
  });
  useEffect(() => {
    let active = true;
    run({kind: "status"}).then(value => { if (active) { setState(value); setError(""); } }, cause => { if (active) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { active = false; };
  }, [run, refresh, revision]);
  useEffect(() => {
    let active = true;
    api.forge(copy.id).then(value => { if (active) setForge(value); }, () => {});
    return () => { active = false; };
  }, [api, copy.id]);
  const branch = state?.branch ?? null;
  // The pull request, the CI and the history line follow the branch; each says by itself when it could not be read.
  useEffect(() => {
    if (!state) return;
    let active = true;
    api.pull(copy, branch).then(value => { if (active) setPull(value); }, () => { if (active) setPull(null); });
    ci.runs(copy.id, "all", 1).then(page => { if (active) { setLatest(branchRun(page.items, branch)); setCiNote(""); } },
      cause => { if (active) { setLatest(null); setCiNote(cause instanceof Error ? cause.message : String(cause)); } });
    history.page(copy.id, 0).then(page => { if (active) setLast(page.commits[0]?.authorDate ?? null); }, () => {});
    return () => { active = false; };
  }, [api, ci, history, copy, branch, refresh, revision, state !== null]);
  useEffect(() => {
    let active = true;
    api.reviewCounts(copy.id).then(value => { if (active) setCounts(value); }, () => {});
    return () => { active = false; };
  }, [api, copy.id, reviewRevision]);

  const head = <PanelHead copy={copy} state={state} forge={forge} base={pull?.baseRefName ?? null} run={run} onChanged={changed} note={note}/>;
  if (screen.kind !== "summary") {
    const title = screen.kind === "changes" ? t("gp.changes") : screen.kind === "ci" ? "CI" : screen.kind === "review" ? t("gp.review") : t("gp.history");
    return <div className="git-panel" data-screen={screen.kind}>
      {head}
      <div className="git-panel-bar"><button type="button" className="g-btn ghost sm" onClick={() => onScreen({kind: "summary"})} aria-label={t("gp.back")}>
        <Icon name="ChevronLeft" small/></button><h3>{title}</h3></div>
      <div className="git-panel-screen">
        {screen.kind === "changes" ? <Worktree copy={copy} host={host} run={run} refresh={refresh + revision} loadOperations={loadOperations} openReview={() => onScreen({kind: "review"})}/>
          : screen.kind === "ci" ? <CiPanel api={ci} copyId={copy.id} currentThreadId={threadId} repository={copy.repositoryName ?? ""} view={screen.view}
            onView={view => onScreen({kind: "ci", view})}/>
          : screen.kind === "review" ? <ReviewPanel api={review} copyId={copy.id} currentThreadId={threadId} revision={reviewRevision}/>
          : <HistoryPanel api={history} copyId={copy.id} graph={graph}/>}
      </div>
    </div>;
  }
  const files = state?.files ?? [];
  const lastAgo = last ? ago(language, Date.now(), last) : null;
  return <div className="git-panel" data-screen="summary">
    {head}
    {error && <div className="g-banner bad" role="alert">{error}</div>}
    <Section id="git-panel-changes" title={t("gp.changes")} open={open.has("changes")} onToggle={() => toggle("changes")}
      aside={state ? <span className="g-muted">{t("ct.files", {n: files.length})}</span> : undefined}>
      {state ? <ChangesBody state={state} run={run} onChanged={changed} onOpen={() => onScreen({kind: "changes"})}/> : <p className="g-muted" role="status">{t("pg.reading")}</p>}
      {files.length > 0 && <button type="button" className="g-btn ghost sm git-panel-more" onClick={() => onScreen({kind: "changes"})}>{t("gp.all-changes")}<Icon name="ChevronRight" small/></button>}
    </Section>
    <Section id="git-panel-pull" title={pull ? t("gp.pull-n", {n: pull.number}) : t("gp.pull")} open={open.has("pull")} onToggle={() => toggle("pull")}
      aside={pull ? <span className="g-chip good">{t(pull.isDraft ? "gp.pr.draft" : "gp.pr.open")}</span> : undefined}>
      {pull === undefined ? <p className="g-muted" role="status">{t("common.loading")}</p> : <PullBody pull={pull} branch={branch} onOpen={onOpenPull}/>}
    </Section>
    <Section id="git-panel-ci" title="CI" open={open.has("ci")} onToggle={() => toggle("ci")} aside={latest ? <RunState run={latest} t={t}/> : undefined}>
      {latest === undefined ? <p className="g-muted" role="status">{t("common.loading")}</p>
        : latest ? <CiBody api={ci} copyId={copy.id} run={latest} onLog={() => onScreen({kind: "ci", view: {kind: "run", runId: latest.id}})}/>
        : <p className="g-muted git-panel-empty">{ciNote || (branch ? t("gp.no-runs", {branch}) : t("gp.no-branch"))}
          <button type="button" className="g-btn ghost sm git-panel-more" onClick={() => onScreen({kind: "ci", view: {kind: "runs"}})}>{t("gp.all-runs")}<Icon name="ChevronRight" small/></button></p>}
    </Section>
    <Section id="git-panel-review" title={t("gp.review")} open={open.has("review")} onToggle={() => toggle("review")}
      aside={counts?.total ? <span className="g-muted">{t("gp.open-comments", {n: counts.open})}</span> : undefined}>
      <div className="git-panel-row"><span className="g-muted">{counts?.total ? t("gp.review-of", {open: counts.open, total: counts.total}) : t("gp.review-none")}</span>
        <button type="button" className="g-btn ghost sm git-panel-more" onClick={() => onScreen({kind: "review"})}>{t("gp.open-review")}<Icon name="ChevronRight" small/></button></div>
    </Section>
    <Section id="git-panel-history" title={t("gp.history")} open={open.has("history")} onToggle={() => toggle("history")}
      aside={<span className="g-muted">{[state?.ahead ? t("gp.unpushed", {n: state.ahead}) : null, lastAgo ? (lastAgo === t("time.now") ? t("gp.last-now") : t("gp.last", {when: lastAgo})) : null].filter(Boolean).join(" · ")}</span>}>
      <button type="button" className="g-btn sm" onClick={() => onScreen({kind: "history"})}><Icon name="Clock" small/>{t("gp.open-history")}</button>
    </Section>
    {footer}
  </div>;
}
