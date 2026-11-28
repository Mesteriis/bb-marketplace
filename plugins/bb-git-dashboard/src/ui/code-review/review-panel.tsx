import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { PATCH_BATCH, withPatches, type ReviewDiffFile } from "../../core/code-review/diff.ts";
import { keepView, readView, viewScope, type ViewStorage } from "../../core/code-review/view-memory.ts";
import { parseRange, rangeText } from "../../core/code-review/git-spec.ts";
import { GENERAL_PATH, type ReviewRun, type TargetRequest } from "../../core/code-review/model.ts";
import { changeRevision } from "../../core/code-review/diff.ts";
import type { MessageKey } from "../../core/i18n/dictionary.ts";
import { targetWords } from "../../core/code-review/target-words.ts";
import { useT } from "../i18n/use-t.tsx";
import { Dialog } from "../system/dialog.tsx";
import { Icon } from "../system/icon.tsx";
import { MenuButton } from "../system/menu.tsx";
import type { ExplainPlace } from "../../core/code-review/run-prompts.ts";
import { AiReviewForm, RunList } from "./ai-runs.tsx";
import { KeptContext, useKeptState } from "./kept-state.tsx";
import { orphanDrafts } from "../../core/code-review/view-state.ts";
import { useReviewCommands, type ReviewCommand } from "./commands.ts";
import { FindBar, GoToDialog } from "./navigate-bar.tsx";
import { FileSearch } from "./file-search.tsx";
import { commentOrder, findMatches, goToItems, step, type GoToItem } from "./navigation.ts";
import { FileDiff } from "./file-diff.tsx";
import { message, type CodeReviewApi, type NewThread, type ReviewView } from "./review-api.ts";
import { SendForm } from "./send-form.tsx";
import { Composer, ThreadCard } from "./thread-card.tsx";
import "./code-review.css";

type Kind = TargetRequest["kind"];
const kindKeys: {kind: Kind; key: MessageKey}[] = [
  {kind: "uncommitted", key: "cr.k.uncommitted"}, {kind: "staged", key: "cr.k.staged"}, {kind: "unstaged", key: "cr.k.unstaged"},
  {kind: "branch", key: "cr.k.branch"}, {kind: "all", key: "cr.k.all"}, {kind: "commit", key: "cr.k.commit"}, {kind: "range", key: "cr.k.range"},
  {kind: "files", key: "cr.k.files"},
];
const workingViews = new Set<Kind>(["uncommitted", "unstaged", "all", "files"]);

/** The view the picker's fields describe, or an error to show instead of reading it. */
function request(kind: Kind, base: string, sha: string, range: string, t: (key: MessageKey) => string): TargetRequest | string {
  if (kind === "branch" || kind === "all") return base.trim() ? {kind, base: base.trim()} : {kind};
  if (kind === "commit") return /^[0-9a-f]{7,64}$/i.test(sha.trim()) ? {kind, sha: sha.trim()} : t("cr.need-sha");
  if (kind === "range") return parseRange(range) ?? t("cr.need-range");
  return {kind};
}

/**
 * The line review of a working copy: pick a view, comment on lines, files or the whole diff, and send the open
 * threads to the agent working on the copy. `revision` changes when the review changed elsewhere.
 */
export function ReviewPanel({api, copyId, currentThreadId, revision, initialFile}: {api: CodeReviewApi; copyId: string; currentThreadId?: string; revision: number;
  /** A file to go to once the view shows (`bb git-dashboard review open`). */
  initialFile?: string}) {
  const t = useT();
  const kinds = kindKeys.map(item => ({kind: item.kind, label: t(item.key)}));
  const scope = viewScope(copyId, currentThreadId);
  // What this tab or copy kept from the last visit; read once, as the starting state.
  const [kept] = useState(() => readView(browserStorage(), scope));
  const start = kept.target;
  const [kind, setKind] = useState<Kind>(start?.kind ?? "uncommitted");
  const [base, setBase] = useState(start && (start.kind === "branch" || start.kind === "all") ? start.base ?? "" : "");
  const [sha, setSha] = useState(start?.kind === "commit" ? start.sha : "");
  const [range, setRange] = useState(start?.kind === "range" ? rangeText(start) : "main...HEAD");
  const [applied, setApplied] = useState<TargetRequest>(start ?? {kind: "uncommitted"});
  // Until a view is picked, the first look may show the branch's commits instead of an empty uncommitted view.
  const [auto, setAuto] = useState(start === null);
  const [ignoreWhitespace, setIgnoreWhitespace] = useState(kept.ignoreWhitespace);
  const [onlyCommented, setOnlyCommented] = useState(kept.onlyCommented);
  const [wrap, setWrap] = useState(kept.wrap);
  const [split, setSplit] = useState(kept.split);
  const [clearing, setClearing] = useState(false);
  // HEAD's latest commits, read when the commit view is picked.
  const [commits, setCommits] = useState<{sha: string; subject: string}[]>([]);
  useEffect(() => {
    if (kind !== "commit") return;
    let active = true;
    api.commits(copyId).then(list => { if (active) setCommits(list); }, () => { if (active) setCommits([]); });
    return () => { active = false; };
  }, [api, copyId, kind]);
  const [finding, setFinding] = useState(false);
  const [query, setQuery] = useState("");
  const [matchCase, setMatchCase] = useState(false);
  const [matchIndex, setMatchIndex] = useState(-1);
  const [goingTo, setGoingTo] = useState(false);
  const [goToQuery, setGoToQuery] = useState("");
  const [commentAt, setCommentAt] = useState("");
  const [reveal, setReveal] = useState<{path: string; token: number} | null>(null);
  // Files opened in the Any file view besides those with threads, by session.
  const [opened, setOpened] = useState<{sessionId: string; files: ReviewDiffFile[]}>({sessionId: "", files: []});
  const root = useRef<HTMLElement>(null);
  useEffect(() => keepView(browserStorage(), scope, {target: auto ? null : applied, ignoreWhitespace, onlyCommented, wrap, split}),
    [scope, auto, applied, ignoreWhitespace, onlyCommented, wrap, split]);
  const [view, setView] = useState<ReviewView>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [general, setGeneral] = useState(false);
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState("");
  const [reload, setReload] = useState(0);
  const [reviewing, setReviewing] = useState(false);
  const [runs, setRuns] = useState<ReviewRun[]>([]);
  const viewer = currentThreadId ?? null;
  const [notes, setNotes] = useState<Record<string, string | null>>({});
  const note = (threadId: string, text: string | null) => setNotes(current => ({...current, [threadId]: text}));
  useEffect(() => {
    let active = true;
    setLoading(true);
    // A view that fails to load leaves none on screen, so nothing is commented or sent to the previous one.
    api.view(copyId, applied, ignoreWhitespace, auto).then(next => {
      if (!active) return;
      setView(next); setError(""); setLoaded(value => value + 1);
      // The first look chose the branch's commits: the picker says so, and the choice is not kept.
      if (auto && next.target.kind === "branch") { setKind("branch"); setBase(next.target.base); }
    },
      cause => { if (active) { setView(undefined); setError(message(cause)); } }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [api, copyId, applied, ignoreWhitespace, auto, revision, reload]);
  const refresh = useCallback(() => setReload(value => value + 1), []);
  // The patches the view left deferred, read in batches after it shows; a failed batch waits for Retry.
  const [loaded, setLoaded] = useState(0);
  const loadedRef = useRef(0);
  loadedRef.current = loaded;
  const [patchError, setPatchError] = useState("");
  const [patchRetry, setPatchRetry] = useState(0);
  const viewRef = useRef(view);
  viewRef.current = view;
  useEffect(() => {
    const shown = viewRef.current;
    if (!shown) return;
    // A batch read for an earlier load of this same view (whitespace switched, the copy changed) is not merged.
    const load = loaded;
    let active = true;
    setPatchError("");
    (async () => {
      for (;;) {
        const current = viewRef.current;
        const batch = current?.sessionId === shown.sessionId ? current.files.filter(file => file.deferred).slice(0, PATCH_BATCH) : [];
        if (!active || !batch.length) return;
        const files = await api.patches(copyId, shown.target, ignoreWhitespace, batch);
        if (!active || loadedRef.current !== load) return;
        // A file the host no longer lists keeps no patch rather than asking again forever.
        const answered = new Set(files.map(file => file.path));
        setView(view => view && view.sessionId === shown.sessionId ? {...view, files: withPatches(view.files, files)
          .map(file => file.deferred && batch.some(asked => asked.path === file.path) && !answered.has(file.path) ? {...file, deferred: false} : file)} : view);
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    })().catch(cause => { if (active) setPatchError(message(cause)); });
    return () => { active = false; };
    // A new load or a Retry starts over; patches arriving do not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, copyId, loaded, patchRetry]);
  // While the Review is on screen its copy stays watched: an edit, a stage or a commit reloads it by itself.
  useEffect(() => {
    let active = true;
    const renew = () => { if (active && !document.hidden) api.watch(copyId).catch(() => { /* the button still reloads */ }); };
    // Back on screen: the lease may have ended meanwhile, so the diff is read again too.
    const shown = () => { if (!document.hidden) { renew(); refresh(); } };
    renew();
    const timer = setInterval(renew, 30_000);
    document.addEventListener("visibilitychange", shown);
    return () => { active = false; clearInterval(timer); document.removeEventListener("visibilitychange", shown); };
  }, [api, copyId, refresh]);
  const sessionId = view?.sessionId;
  const keptState = useKeptState(api, scope, sessionId, root);
  // An unsent comment on the whole diff opens again with its text.
  useEffect(() => { if (keptState.ready && keptState.kept.draft("general")) setGeneral(true); }, [keptState.ready, keptState.kept]);
  useEffect(() => {
    if (!sessionId) { setRuns([]); return; }
    let active = true;
    // The runs are a side list: one that fails to read leaves the review usable.
    api.runs(sessionId).then(next => { if (active) setRuns(next); }, () => { if (active) setRuns([]); });
    return () => { active = false; };
  }, [api, sessionId, revision, reload]);
  const choose = (next: Kind) => {
    setKind(next);
    const asked = request(next, base, sha, range, t);
    if (typeof asked !== "string") { setAuto(false); setApplied(asked); }
  };
  const show = () => {
    const asked = request(kind, base, sha, range, t);
    if (typeof asked === "string") setError(asked); else { setError(""); setAuto(false); setApplied(asked); }
  };
  // A mark on its way keeps its box still, so quick clicks do not race each other to the server.
  const [marking, setMarking] = useState<ReadonlySet<string>>(new Set());
  const markViewed = async (path: string, revision: string, on: boolean) => {
    if (!view || marking.has(path)) return;
    setMarking(current => new Set(current).add(path));
    const mark = (viewed: boolean) => setView(current => current && {...current, files: current.files.map(file => file.path === path ? {...file, viewed} : file)});
    // The box turns at once; a mark the server refuses turns back.
    mark(on);
    try { await api.setViewed(view.sessionId, path, revision, on); }
    catch (cause) { mark(!on); setStatus(t("cr.not-marked", {path, error: message(cause)})); }
    finally { setMarking(current => { const next = new Set(current); next.delete(path); return next; }); }
  };
  const [clearingNow, setClearingNow] = useState(false);
  const clear = async () => {
    if (!view || clearingNow) return;
    setClearingNow(true);
    try {
      const {deletedThreads, closedRuns} = await api.clear(view.sessionId);
      setStatus(t("cr.cleared", {n: deletedThreads}) + (closedRuns ? " " + t("cr.closed-runs", {n: closedRuns}) : ""));
    } catch (cause) { setStatus(t("cr.not-cleared", {error: message(cause)})); }
    setClearing(false); setClearingNow(false);
    refresh();
  };
  const create = async (thread: NewThread) => {
    if (!view) return;
    const made = await api.createThread(view.sessionId, thread, viewer);
    note(made.threadId, made.reviewer);
    refresh();
  };
  const [explaining, setExplaining] = useState(false);
  // The outcome goes to the status line: `error` is cleared by the reload that follows.
  const explain = async (place: ExplainPlace) => {
    if (!view || explaining) return;
    setStatus(""); setExplaining(true);
    try {
      const run = await api.startExplain(view.sessionId, place, viewer);
      setStatus(run.status === "running" ? t("cr.explaining") : run.summary ?? t("cr.not-explained"));
    } catch (cause) { setStatus(t("cr.explain-failed", {error: message(cause)})); }
    finally { setExplaining(false); }
    refresh();
  };
  const live = <T,>(work: Promise<T>) => work.then(result => { refresh(); return result; });
  const liveApi: CodeReviewApi = {...api,
    addComment: (threadId, body) => live(api.addComment(threadId, body, viewer).then(result => { note(threadId, result.reviewer); return result; })),
    reviewerNote: threadId => notes[threadId] ?? null, editComment: (...args) => live(api.editComment(...args)),
    deleteComment: (...args) => live(api.deleteComment(...args)), setStatus: (...args) => live(api.setStatus(...args)),
    apply: (...args) => live(api.apply(...args))};

  const threads = view?.threads ?? [];
  const placed = (id: string) => view?.placements[id];
  const generalThreads = threads.filter(thread => thread.filePath === GENERAL_PATH);
  const outdated = threads.filter(thread => thread.filePath !== GENERAL_PATH && placed(thread.id)?.state === "outdated");
  const extra = view && opened.sessionId === view.sessionId ? opened.files.filter(file => !view.files.some(shown => shown.path === file.path)) : [];
  const files = useMemo(() => [...view?.files ?? [], ...extra].filter(file => !onlyCommented || threads.some(thread => thread.filePath === file.path)),
    // `extra` and `threads` follow `view` and `opened`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [view, opened, onlyCommented]);
  const openFile = async (path: string) => {
    if (!view) return;
    const sessionId = view.sessionId;
    const file = await api.fileEntry(copyId, path);
    setOpened(current => ({sessionId, files: [...current.sessionId === sessionId ? current.files.filter(item => item.path !== path) : [], file]}));
    reach(path, `section[data-path="${CSS.escape(path)}"]`);
  };
  const search = useCallback((query: string) => api.searchFiles(copyId, query), [api, copyId]);
  const matches = useMemo(() => finding ? findMatches(files, query, matchCase) : [], [finding, files, query, matchCase]);
  const at = matches[matchIndex] ?? null;
  const foundIn = useMemo(() => {
    const byPath = new Map<string, Set<number>>();
    for (const match of matches) byPath.set(match.path, (byPath.get(match.path) ?? new Set()).add(match.row));
    return byPath;
  }, [matches]);
  /** Unfolds `path` (when given), then scrolls `selector` into view inside this Review and focuses it. */
  const reach = (path: string | null, selector: string) => {
    if (path) setReveal(current => ({path, token: (current?.token ?? 0) + 1}));
    setTimeout(() => {
      const found = root.current?.querySelector<HTMLElement>(selector);
      found?.scrollIntoView({block: "center"});
      found?.focus({preventScroll: true});
    }, 60);
  };
  const stepMatch = (delta: 1 | -1) => {
    const next = step(matches.length, matchIndex, delta);
    setMatchIndex(next);
    const match = matches[next];
    if (match) reach(match.path, `section[data-path="${CSS.escape(match.path)}"] [data-row="${match.row}"]`);
  };
  const order = commentOrder(files, threads);
  const stepComment = (delta: 1 | -1) => {
    const next = step(order.length, order.indexOf(commentAt), delta);
    const id = order[next];
    if (!id) return;
    setCommentAt(id);
    const thread = threads.find(item => item.id === id);
    reach(thread && thread.filePath !== GENERAL_PATH ? thread.filePath : null, `[data-thread-id="${CSS.escape(id)}"]`);
  };
  const goTo = (item: GoToItem) => {
    setGoingTo(false);
    if (item.kind === "view") { choose(item.view as Kind); return; }
    if (item.kind === "file") { reach(item.path, `section[data-path="${CSS.escape(item.path)}"]`); return; }
    const thread = threads.find(row => row.id === item.id);
    setCommentAt(item.id);
    reach(thread && thread.filePath !== GENERAL_PATH ? thread.filePath : null, `[data-thread-id="${CSS.escape(item.id)}"]`);
  };
  // `review open` named a file: the view goes to it once, when it first shows; one not in this view is opened in Any file.
  const wentTo = useRef(false);
  useEffect(() => {
    if (!initialFile || wentTo.current || !view || !keptState.ready) return;
    wentTo.current = true;
    if (view.target.kind === "files" && !view.files.some(file => file.path === initialFile)) void openFile(initialFile).catch(cause => setStatus(message(cause)));
    else if (view.files.some(file => file.path === initialFile)) reach(initialFile, `section[data-path="${CSS.escape(initialFile)}"]`);
    else setStatus(t("cr.not-in-view", {path: initialFile}));
  });
  useReviewCommands(currentThreadId ?? "copy:" + copyId, (command: ReviewCommand) => {
    const actions: Record<ReviewCommand, () => void> = {
      reload: refresh, send: () => setSending(true), "ai-review": () => setReviewing(true), "comment-diff": () => setGeneral(true),
      find: () => setFinding(true), "go-to": () => setGoingTo(true), "next-comment": () => stepComment(1), "previous-comment": () => stepComment(-1),
      "toggle-style": () => setSplit(value => !value), "toggle-only-commented": () => setOnlyCommented(value => !value),
      "toggle-whitespace": () => setIgnoreWhitespace(value => !value), clear: () => setClearing(true),
    };
    actions[command]();
  });
  const open = threads.filter(thread => thread.status === "open").length;
  const orphans = view && keptState.ready ? orphanDrafts(keptState.state, new Set(view.files.map(file => file.path))) : [];
  const working = view ? workingViews.has(view.target.kind) : false;
  // ⌘/Ctrl+F finds and ⌘/Ctrl+P goes to, while focus is inside this Review.
  const keys = (event: KeyboardEvent) => {
    if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
    if (event.key === "f") { event.preventDefault(); setFinding(true); }
    if (event.key === "p") { event.preventDefault(); setGoingTo(true); }
  };
  const additions = view?.files.reduce((sum, file) => sum + file.additions, 0) ?? 0;
  const deletions = view?.files.reduce((sum, file) => sum + file.deletions, 0) ?? 0;
  const openIn = (path: string) => threads.filter(thread => thread.filePath === path && thread.status === "open").length;
  const goToFile = (path: string) => reach(path, `section[data-path="${CSS.escape(path)}"]`);
  return <KeptContext.Provider value={keptState.kept}><section ref={root} onKeyDown={keys} className="git-code-review" aria-label={t("pg.tab.review")} data-palette={view?.colorBlind ? "color-blind" : undefined}>
    <div className="git-cr-bar">
      <select className="g-inp" aria-label={t("cr.what")} value={kind} onChange={event => choose(event.target.value as Kind)}>
        {kinds.map(item => <option key={item.kind} value={item.kind}>{item.label}</option>)}</select>
      {(kind === "branch" || kind === "all") && <input className="g-inp" aria-label={t("cr.base")} placeholder={t("cr.base-hint")} value={base}
        onChange={event => setBase(event.target.value)} onKeyDown={event => { if (event.key === "Enter") show(); }}/>}
      {kind === "commit" && commits.length > 0 && <select className="g-inp" aria-label={t("cr.commit")} value={commits.some(commit => commit.sha === sha) ? sha : ""}
        onChange={event => { setSha(event.target.value); setError(""); setAuto(false); if (event.target.value) setApplied({kind: "commit", sha: event.target.value}); }}>
        <option value="">{t("cr.recent")}</option>
        {commits.map(commit => <option key={commit.sha} value={commit.sha}>{commit.sha.slice(0, 7)} {commit.subject}</option>)}</select>}
      {kind === "commit" && <input className="g-inp" aria-label={t("cr.sha")} placeholder={t("cr.sha-hint")} value={sha}
        onChange={event => setSha(event.target.value)} onKeyDown={event => { if (event.key === "Enter") show(); }}/>}
      {kind === "range" && <input className="g-inp" aria-label={t("cr.range")} placeholder="main...HEAD" value={range}
        onChange={event => setRange(event.target.value)} onKeyDown={event => { if (event.key === "Enter") show(); }}/>}
      {(kind === "branch" || kind === "all" || kind === "commit" || kind === "range") && <button type="button" className="g-btn" onClick={show}>{t("cr.show")}</button>}
      {view && <span className="g-muted git-cr-sum" title={(() => { const words = targetWords(view.target); return t(words.key, words.values); })()}>
        {view.target.kind !== "uncommitted" && view.target.kind !== "staged" && view.target.kind !== "unstaged" && view.target.kind !== "files"
          ? (() => { const words = targetWords(view.target); return t(words.key, words.values) + " · "; })() : ""}{t("hs.files", {n: view.files.length})} · <span className="g-good">+{additions}</span> <span className="g-bad">−{deletions}</span>
        {view.ignored ? " · " + t("cr.ignored", {n: view.ignored}) : ""}{view.truncated ? " · " + t("cr.cut") : ""}</span>}
      <div className="g-seg" role="group" aria-label={t("cr.style")}>
        <button type="button" aria-pressed={!split} onClick={() => setSplit(false)}>{t("cr.unified")}</button>
        <button type="button" aria-pressed={split} onClick={() => setSplit(true)}>{t("cr.split")}</button>
      </div>
      <MenuButton label={t("cr.view")} className="g-btn ghost" entries={[
        {kind: "check", label: t("cr.whitespace"), checked: ignoreWhitespace, onChange: setIgnoreWhitespace},
        {kind: "check", label: t("cr.only-commented"), checked: onlyCommented, onChange: setOnlyCommented},
        {kind: "check", label: t("pr.wrap"), checked: wrap, onChange: setWrap},
        {kind: "separator"},
        {kind: "item", label: t("cr.prev-comment"), disabled: !order.length, onSelect: () => stepComment(-1)},
        {kind: "item", label: t("cr.next-comment"), disabled: !order.length, onSelect: () => stepComment(1)},
        {kind: "item", label: t("cr.go-to"), disabled: !view, onSelect: () => setGoingTo(true)},
        {kind: "item", label: t("cr.comment-diff"), disabled: !view, onSelect: () => setGeneral(true)},
        {kind: "separator"},
        {kind: "item", label: loading ? t("common.loading") : t("cr.reload"), disabled: loading, onSelect: refresh},
        {kind: "item", label: t("cr.clear"), disabled: !threads.length && !runs.length, onSelect: () => setClearing(true)},
      ]}/>
      <button type="button" className="g-btn ghost" aria-expanded={finding} onClick={() => setFinding(value => !value)}><Icon name="Search" small/>{t("cr.find")}</button>
      <span className="git-cr-end">
        <button type="button" className="g-btn" aria-haspopup="dialog" disabled={!view?.files.length} onClick={() => setReviewing(true)}><Icon name="AiBrain01" small/>{t("cr.ai")}</button>
        <button type="button" className="g-btn pri" aria-expanded={sending} disabled={!open} aria-label={t("cr.send-n", {n: open})}
          onClick={() => setSending(value => !value)}><Icon name="Sent" small/>{t("cr.send")} <span className="g-num">{open}</span></button>
      </span>
    </div>
    {view && finding && <FindBar query={query} matchCase={matchCase} count={matches.length} current={matchIndex}
      onQuery={value => { setQuery(value); setMatchIndex(-1); }} onMatchCase={value => { setMatchCase(value); setMatchIndex(-1); }} onStep={stepMatch}
      onClose={() => { setFinding(false); setMatchIndex(-1); }}/>}
    {view && goingTo && <GoToDialog items={goToItems(view.files, threads, kinds, goToQuery)} onQuery={setGoToQuery} onPick={goTo}
      onClose={() => setGoingTo(false)}/>}
    {status && <p className="git-ci-status g-muted" role="status">{status}</p>}
    {error && <div className="g-banner bad" role="alert">{error}</div>}
    {!view && !error && <p className="g-state-page" role="status">{t("cr.reading")}</p>}
    {view && clearing && <Dialog title={t("cr.clear-title")} busy={clearingNow} onClose={() => setClearing(false)} actions={<>
      <button type="button" className="g-btn" autoFocus disabled={clearingNow} onClick={() => setClearing(false)}>{t("common.cancel")}</button>
      <button type="button" className="g-btn pri git-danger" disabled={clearingNow} onClick={() => void clear()}>{t("cr.clear-do")}</button>
    </>}><p>{t("cr.clear-text", {n: threads.length}) + (runs.length ? " " + t("cr.clear-runs", {n: runs.length}) : "")}</p></Dialog>}
    {view && <RunList api={api} runs={runs} onClosed={refresh}/>}
    {view && reviewing && <AiReviewForm api={api} copyId={copyId} sessionId={view.sessionId} viewer={viewer} onClose={() => setReviewing(false)}
      onStarted={(_run, text) => { setReviewing(false); setStatus(text); refresh(); }}/>}
    {view && sending && <SendForm api={api} copyId={copyId} sessionId={view.sessionId} threads={threads} currentThreadId={currentThreadId}
      onClose={() => setSending(false)} onSent={text => { setSending(false); setStatus(text); refresh(); }}/>}
    {view && <div className="git-cr-body">
      <nav className="git-cr-files" aria-label={t("cr.files")}>
        <div className="git-cr-files-head"><span className="g-sec">{t("cr.files")}</span><span className="g-muted">{t("cr.viewed-hint")}</span></div>
        <ul>{files.map(file => {
          const slash = file.path.lastIndexOf("/");
          const count = openIn(file.path);
          return <li key={file.path}>
            {!file.deferred && !file.whole && <input type="checkbox" aria-label={t("cr.viewed-file", {path: file.path})} checked={file.viewed === true} disabled={marking.has(file.path)}
              onChange={event => void markViewed(file.path, changeRevision(file), event.target.checked)}/>}
            <button type="button" title={file.path} onClick={() => goToFile(file.path)}>
              <span className="git-cr-path"><span className="g-muted">{file.path.slice(0, slash + 1)}</span>{file.path.slice(slash + 1)}</span>
              {count > 0 && <span className="g-chip warn" aria-label={t("pr.open-threads", {n: count})}>{count}</span>}
              {file.binary ? <span className="g-muted">{t("hs.binary")}</span> : <span className="g-num">
                {file.additions > 0 && <span className="g-good">+{file.additions}</span>} {file.deletions > 0 && <span className="g-bad">−{file.deletions}</span>}</span>}
            </button>
          </li>;
        })}</ul>
        {outdated.length > 0 && <>
          <div className="git-cr-files-head"><span className="g-sec">{t("cr.outdated")} <span className="g-num">{outdated.length}</span></span></div>
          <ul>{outdated.map(thread => <li key={thread.id} className="git-cr-outdated">
            <span className="git-cr-path">{thread.filePath}{thread.startLine ? ":" + thread.startLine : ""}</span>
            <span className="g-chip warn">{t("cr.outdated-chip")}</span>
            <button type="button" className="g-btn ghost sm" onClick={() => { setCommentAt(thread.id); reach(null, `[data-thread-id="${CSS.escape(thread.id)}"]`); }}>{t("cr.show")}</button>
          </li>)}</ul>
        </>}
      </nav>
      <div className="git-cr-main">
        {(general || generalThreads.length > 0) && <section className="git-cr-block" aria-label={t("cr.whole")}>
          <h3 className="g-sec">{t("cr.whole")}</h3>
          {general && <Composer label={t("cr.comment-whole")} withSeverity submitLabel={t("cr.comment")} onCancel={() => setGeneral(false)} draftKey="general"
            onSubmit={async (body, severity) => { await create({filePath: GENERAL_PATH, side: null, startLine: 0, endLine: 0, anchorContent: null, severity, body}); setGeneral(false); }}/>}
          {generalThreads.map(thread => <ThreadCard key={thread.id} thread={thread} api={liveApi} current={undefined} canApply={false}/>)}
        </section>}
        {outdated.length > 0 && <section className="git-cr-block" aria-label={t("cr.outdated")}>
          <h3 className="g-sec">{t("cr.outdated")}</h3>
          <p className="g-muted">{t("cr.outdated-why")}</p>
          {outdated.map(thread => <ThreadCard key={thread.id} thread={thread} api={liveApi} current={undefined} canApply={false} showPath outdated/>)}
        </section>}
        {keptState.ready && orphans.length > 0 && <section className="git-cr-block" aria-label={t("cr.orphans")}>
          <h3 className="g-sec">{t("cr.orphans")}</h3>
          <p className="g-muted">{t("cr.orphans-why")}</p>
          <ul className="git-cr-orphans">{orphans.map(orphan => <li key={orphan.key}>
            <span className="git-path">{orphan.path}</span><span className="g-muted">{orphan.draft.body.split("\n")[0]!.slice(0, 100)}</span>
            <button type="button" className="g-btn ghost sm" onClick={() => keptState.kept.setDraft(orphan.key, null)}>{t("pr.discard")}</button>
          </li>)}</ul>
        </section>}
        {view.target.kind === "files" && <FileSearch search={search} onPick={openFile}/>}
        {!files.length && <p className="g-state-page">{t(view.target.kind === "files" ? "cr.empty-files" : view.target.kind === "uncommitted" ? "cr.empty-uncommitted" : "cr.empty")}</p>}
        {keptState.ready && files.map(file => <FileDiff key={view.sessionId + file.path} file={file} wrap={wrap} split={split}
          patchError={file.deferred ? patchError : ""} onRetryPatch={() => setPatchRetry(value => value + 1)}
          hunksPickable={!ignoreWhitespace}
          onRevert={view.target.kind === "uncommitted" && !ignoreWhitespace ? async (revision, hunks) => { await api.revert(view.sessionId, file.path, revision, hunks); refresh(); } : undefined}
          onOpen={file.changeKind === "deleted" ? undefined : line => api.openFile(view.copy.hostId, joinPath(view.copy.root, file.path), line)} workingCopy={working} api={liveApi} onCreate={create} onExplain={explain} explaining={explaining}
          found={foundIn.get(file.path)} current={at?.path === file.path ? at.row : null} reveal={reveal?.path === file.path ? reveal.token : undefined}
          threads={threads.filter(thread => thread.filePath === file.path && placed(thread.id)?.state !== "outdated")} placements={view.placements}/>)}
      </div>
    </div>}
  </section></KeptContext.Provider>;
}

/** This browser's storage for what a Review keeps; none where the page may not use it. */
function browserStorage(): ViewStorage | undefined {
  try { return typeof window === "undefined" ? undefined : window.localStorage; } catch { return undefined; }
}

/** A path of the copy on its host; the host's own separator when its root shows one. */
function joinPath(root: string, path: string) {
  const separator = root.includes("\\") && !root.includes("/") ? "\\" : "/";
  return root.replace(/[\\/]+$/, "") + separator + (separator === "/" ? path : path.replaceAll("/", "\\"));
}
