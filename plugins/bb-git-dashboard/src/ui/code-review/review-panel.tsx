import { useCallback, useEffect, useRef, useState } from "react";
import { PATCH_BATCH, withPatches } from "../../core/code-review/diff.ts";
import { keepView, readView, viewScope, type ViewStorage } from "../../core/code-review/view-memory.ts";
import { parseRange, rangeText } from "../../core/code-review/git-spec.ts";
import { describeTarget, GENERAL_PATH, type ReviewRun, type TargetRequest } from "../../core/code-review/model.ts";
import type { ExplainPlace } from "../../core/code-review/run-prompts.ts";
import { AiReviewForm, RunList } from "./ai-runs.tsx";
import { FileDiff } from "./file-diff.tsx";
import { message, type CodeReviewApi, type NewThread, type ReviewView } from "./review-api.ts";
import { SendForm } from "./send-form.tsx";
import { Composer, ThreadCard } from "./thread-card.tsx";
import "./code-review.css";

type Kind = TargetRequest["kind"];
const kinds: {kind: Kind; label: string}[] = [
  {kind: "uncommitted", label: "Uncommitted changes"}, {kind: "staged", label: "Staged"}, {kind: "unstaged", label: "Unstaged"},
  {kind: "branch", label: "Branch commits since base"}, {kind: "all", label: "All changes since base"}, {kind: "commit", label: "A commit"}, {kind: "range", label: "A range"},
];
const workingViews = new Set<Kind>(["uncommitted", "unstaged", "all"]);

/** The view the picker's fields describe, or an error to show instead of reading it. */
function request(kind: Kind, base: string, sha: string, range: string): TargetRequest | string {
  if (kind === "branch" || kind === "all") return base.trim() ? {kind, base: base.trim()} : {kind};
  if (kind === "commit") return /^[0-9a-f]{7,64}$/i.test(sha.trim()) ? {kind, sha: sha.trim()} : "Enter a commit hash of 7 to 64 hex characters.";
  if (kind === "range") return parseRange(range) ?? "Enter a range as a..b or a...b.";
  return {kind};
}

/**
 * The line review of a working copy: pick a view, comment on lines, files or the whole diff, and send the open
 * threads to the agent working on the copy. `revision` changes when the review changed elsewhere.
 */
export function ReviewPanel({api, copyId, currentThreadId, revision}: {api: CodeReviewApi; copyId: string; currentThreadId?: string; revision: number}) {
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
  const [patchError, setPatchError] = useState("");
  const [patchRetry, setPatchRetry] = useState(0);
  const viewRef = useRef(view);
  viewRef.current = view;
  useEffect(() => {
    const shown = viewRef.current;
    if (!shown) return;
    let active = true;
    setPatchError("");
    (async () => {
      for (;;) {
        const current = viewRef.current;
        const batch = current?.sessionId === shown.sessionId ? current.files.filter(file => file.deferred).slice(0, PATCH_BATCH) : [];
        if (!active || !batch.length) return;
        const files = await api.patches(copyId, shown.target, ignoreWhitespace, batch);
        if (!active) return;
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
    renew();
    const timer = setInterval(renew, 30_000);
    document.addEventListener("visibilitychange", renew);
    return () => { active = false; clearInterval(timer); document.removeEventListener("visibilitychange", renew); };
  }, [api, copyId]);
  const sessionId = view?.sessionId;
  useEffect(() => {
    if (!sessionId) { setRuns([]); return; }
    let active = true;
    // The runs are a side list: one that fails to read leaves the review usable.
    api.runs(sessionId).then(next => { if (active) setRuns(next); }, () => { if (active) setRuns([]); });
    return () => { active = false; };
  }, [api, sessionId, revision, reload]);
  const choose = (next: Kind) => {
    setKind(next);
    const asked = request(next, base, sha, range);
    if (typeof asked !== "string") { setAuto(false); setApplied(asked); }
  };
  const show = () => {
    const asked = request(kind, base, sha, range);
    if (typeof asked === "string") setError(asked); else { setError(""); setAuto(false); setApplied(asked); }
  };
  const clear = async () => {
    if (!view) return;
    try {
      const {deletedThreads, closedRuns} = await api.clear(view.sessionId);
      setStatus("Cleared " + deletedThreads + " comment thread" + (deletedThreads === 1 ? "" : "s") + (closedRuns ? " and closed " + closedRuns + " AI run" + (closedRuns === 1 ? "" : "s") : "") + ".");
    } catch (cause) { setStatus("Could not clear the review: " + message(cause)); }
    setClearing(false);
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
      setStatus(run.status === "running" ? "Explanation started; it appears here as a comment."
        : run.summary ?? "The explanation was not started.");
    } catch (cause) { setStatus("Could not start the explanation: " + message(cause)); }
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
  const files = (view?.files ?? []).filter(file => !onlyCommented || threads.some(thread => thread.filePath === file.path));
  const open = threads.filter(thread => thread.status === "open").length;
  const working = view ? workingViews.has(view.target.kind) : false;
  return <section className="git-project-code git-stack git-code-review" aria-label="Review">
    <div className="git-row git-code-review-bar">
      <select aria-label="What to review" value={kind} onChange={event => choose(event.target.value as Kind)}>
        {kinds.map(item => <option key={item.kind} value={item.kind}>{item.label}</option>)}</select>
      {(kind === "branch" || kind === "all") && <input aria-label="Base branch" placeholder="default branch" value={base}
        onChange={event => setBase(event.target.value)} onKeyDown={event => { if (event.key === "Enter") show(); }}/>}
      {kind === "commit" && <input aria-label="Commit hash" placeholder="commit hash" value={sha}
        onChange={event => setSha(event.target.value)} onKeyDown={event => { if (event.key === "Enter") show(); }}/>}
      {kind === "range" && <input aria-label="Range" placeholder="main...HEAD" value={range}
        onChange={event => setRange(event.target.value)} onKeyDown={event => { if (event.key === "Enter") show(); }}/>}
      {(kind === "branch" || kind === "all" || kind === "commit" || kind === "range") && <button type="button" onClick={show}>Show</button>}
      <span className="git-ci-spacer"/>
      <label><input type="checkbox" checked={ignoreWhitespace} onChange={event => setIgnoreWhitespace(event.target.checked)}/> Hide whitespace</label>
      <label><input type="checkbox" checked={onlyCommented} onChange={event => setOnlyCommented(event.target.checked)}/> Only files with comments</label>
      <label><input type="checkbox" checked={wrap} onChange={event => setWrap(event.target.checked)}/> Wrap lines</label>
      <label><input type="checkbox" checked={split} onChange={event => setSplit(event.target.checked)}/> Side by side</label>
      <button type="button" onClick={refresh} disabled={loading}>{loading ? "Loading…" : "Reload"}</button>
    </div>
    {view && <div className="git-row git-code-review-bar">
      <span className="git-muted">{describeTarget(view.target)}{view.target.kind === "range" ? " (" + rangeText(view.target) + ")" : ""} · {view.files.length} file{view.files.length === 1 ? "" : "s"}
        {" "}· +{view.files.reduce((sum, file) => sum + file.additions, 0)} −{view.files.reduce((sum, file) => sum + file.deletions, 0)}
        {view.truncated ? " · the diff was cut short" : ""}</span>
      <span className="git-ci-spacer"/>
      <button type="button" aria-expanded={general} onClick={() => setGeneral(value => !value)}>Comment on the diff</button>
      <button type="button" aria-expanded={reviewing} disabled={!view.files.length} onClick={() => setReviewing(value => !value)}>AI review</button>
      <button type="button" aria-expanded={clearing} disabled={!threads.length && !runs.length} onClick={() => setClearing(value => !value)}>Clear review</button>
      <button type="button" className="git-primary" aria-expanded={sending} disabled={!open} onClick={() => setSending(value => !value)}>Send to agent ({open})</button>
    </div>}
    {status && <p className="git-muted" role="status">{status}</p>}
    {error && <p className="git-error" role="alert">{error}</p>}
    {!view && !error && <p className="git-muted" role="status">Reading the diff…</p>}
    {view && clearing && <div className="git-ci-threads git-stack" role="alertdialog" aria-label="Clear review">
      <p>Delete all {threads.length} comment thread{threads.length === 1 ? "" : "s"} of this view{runs.length ? " and close its " + runs.length + " AI run" + (runs.length === 1 ? "" : "s") + ", archiving their threads" : ""}? This cannot be undone.</p>
      <div className="git-row">
        <button type="button" className="git-danger" onClick={() => void clear()}>Clear review</button>
        <button type="button" autoFocus onClick={() => setClearing(false)}>Cancel</button>
      </div>
    </div>}
    {view && <RunList api={api} runs={runs} onClosed={refresh}/>}
    {view && reviewing && <AiReviewForm api={api} copyId={copyId} sessionId={view.sessionId} viewer={viewer} onClose={() => setReviewing(false)}
      onStarted={(_run, text) => { setReviewing(false); setStatus(text); refresh(); }}/>}
    {view && sending && <SendForm api={api} copyId={copyId} sessionId={view.sessionId} threads={threads} currentThreadId={currentThreadId}
      onClose={() => setSending(false)} onSent={text => { setSending(false); setStatus(text); refresh(); }}/>}
    {view && (general || generalThreads.length > 0) && <section className="git-stack" aria-label="About the whole diff">
      <h3>About the whole diff</h3>
      {general && <Composer label="Comment on the whole diff" withSeverity submitLabel="Comment" onCancel={() => setGeneral(false)}
        onSubmit={async (body, severity) => { await create({filePath: GENERAL_PATH, side: null, startLine: 0, endLine: 0, anchorContent: null, severity, body}); setGeneral(false); }}/>}
      {generalThreads.map(thread => <ThreadCard key={thread.id} thread={thread} api={liveApi} current={undefined} canApply={false}/>)}
    </section>}
    {view && outdated.length > 0 && <section className="git-stack" aria-label="Not on the current diff">
      <h3>Not on the current diff</h3>
      <p className="git-muted">The lines these threads were made on changed or left this view.</p>
      {outdated.map(thread => <ThreadCard key={thread.id} thread={thread} api={liveApi} current={undefined} canApply={false} showPath outdated/>)}
    </section>}
    {view && !view.files.length && <p className="git-muted">{view.target.kind === "uncommitted" ? "No uncommitted changes." : "Nothing changed in this view."}</p>}
    {view && files.map(file => <FileDiff key={view.sessionId + file.path} file={file} wrap={wrap} split={split}
      patchError={file.deferred ? patchError : ""} onRetryPatch={() => setPatchRetry(value => value + 1)} workingCopy={working} api={liveApi} onCreate={create} onExplain={explain} explaining={explaining}
      threads={threads.filter(thread => thread.filePath === file.path && placed(thread.id)?.state !== "outdated")} placements={view.placements}/>)}
  </section>;
}

/** This browser's storage for what a Review keeps; none where the page may not use it. */
function browserStorage(): ViewStorage | undefined {
  try { return typeof window === "undefined" ? undefined : window.localStorage; } catch { return undefined; }
}
