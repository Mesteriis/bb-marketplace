import { useCallback, useEffect, useState } from "react";
import type { GitAction, GitResult } from "../core/git.ts";
import type { Copy, Operation } from "../core/workspace.ts";
import { ConflictEditor } from "./merge/conflict-editor.tsx";
import { BranchList, RaceNotice, SequenceBar, type Sequence } from "./merge/merge-actions.tsx";
import type { MessageKey } from "../core/i18n/dictionary.ts";
import { useT } from "./i18n/use-t.tsx";
import { Icon } from "./system/icon.tsx";

export type RunGit = (action: GitAction) => Promise<GitResult>;
type View = "changes" | "branches" | "worktrees" | "activity";
const views: View[] = ["changes", "branches", "worktrees", "activity"];
type Selection = {path: string; staged: boolean};

/** A copy's Code: its changes (staged and not, the diff, the commit), branches, worktrees and the plugin's activity on it. */
export function Worktree({copy, host, run, refresh, loadOperations, attach, pin}: {
  copy: Copy;
  host: string;
  run: RunGit;
  refresh: number;
  loadOperations(): Promise<Operation[]>;
  attach?(root: string): Promise<void>;
  pin?(): void;
}) {
  const t = useT();
  const [view, setView] = useState<View>("changes");
  const [state, setState] = useState<GitResult>();
  const [detail, setDetail] = useState<GitResult>();
  const [outgoing, setOutgoing] = useState<GitResult | null>(null);
  const [outgoingOpen, setOutgoingOpen] = useState(false);
  const [from, setFrom] = useState("");
  const [against, setAgainst] = useState("");
  const [compared, setCompared] = useState<GitResult | null>(null);
  const [selected, setSelected] = useState<Selection>();
  const [diff, setDiff] = useState<GitResult>();
  const [activity, setActivity] = useState<Operation[]>();
  const [authorName,setAuthorName] = useState("");
  const [authorEmail,setAuthorEmail] = useState("");
  const [message, setMessage] = useState("");
  const [branch, setBranch] = useState("");
  const [base, setBase] = useState("");
  const [destination, setDestination] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [revision, setRevision] = useState(0);
  // A merge, rebase, cherry-pick or revert left in progress, and the conflicted file open in the editor.
  const [sequence, setSequence] = useState<Sequence | null>(null);
  const [resolving, setResolving] = useState<string | null>(null);
  // A commit taken in by a merge or rebase that arrived while it was being confirmed.
  const [raced, setRaced] = useState<{sha: string; made: string | null} | null>(null);

  const report = useCallback((cause: unknown) => setError(cause instanceof Error ? cause.message : "Request failed"), []);
  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const [result, progress] = await Promise.all([run({kind:"status"}), run({kind:"sequence"})]);
        if (active) { setState(result); setSequence(progress.sequence ?? null); }
      } catch (error) { if (active) report(error); }
    };
    void load();
    return () => { active = false; };
  }, [run, revision, refresh, report]);

  useEffect(() => {
    let active = true;
    setDetail(undefined);
    setActivity(undefined);
    const kind = view === "branches" ? "branches" : view === "worktrees" ? "worktrees" : null;
    const load = async () => {
      try {
        if (kind) {
          const result = await run({kind});
          if (active) setDetail(result);
        } else if (view === "activity") {
          const result = await loadOperations();
          if (active) setActivity(result);
        }
      } catch (error) { if (active) report(error); }
    };
    void load();
    return () => { active = false; };
  }, [view, run, loadOperations, revision, refresh, report]);

  useEffect(() => {
    let active = true;
    setDiff(undefined);
    if (selected && view === "changes") {
      run({kind:"diff", ...selected}).then(result => { if (active) setDiff(result); }, error => { if (active) report(error); });
    }
    return () => { active = false; };
  }, [selected, view, run, revision, refresh, report]);
  // The outgoing commits are read while they are unfolded, and again when the copy changes; a late answer is dropped.
  useEffect(() => {
    let active = true;
    setOutgoing(null);
    if (outgoingOpen && state?.upstream) run({kind:"outgoing"}).then(value => { if (active) setOutgoing(value); }, error => { if (active) report(error); });
    return () => { active = false; };
  }, [outgoingOpen, state?.upstream, run, revision, refresh, report]);

  async function act(action: GitAction) {
    setPending(true);
    setError("");
    try {
      const result = await run(action);
      if (result.text === "BRANCH_OCCUPIED") {
        setError(t("pg.branch-occupied", {path: result.worktrees?.[0]?.path ?? ""}));
        return;
      }
      if (action.kind === "commit") setMessage("");
      if (action.kind === "compare") setCompared(result);
      else setRevision(value => value + 1);
    } catch (error) { report(error); }
    finally { setPending(false); }
  }

  useEffect(() => {
    if (!state?.files || view !== "changes") return;
    const file = state.files.find(file => file.path === selected?.path) ?? state.files[0];
    const staged = file ? ![".","?"].includes(file.index) &&
      ([".","?"].includes(file.worktree) || (file.path === selected?.path && selected.staged)) : false;
    if (file && (file.path !== selected?.path || staged !== selected.staged)) setSelected({path:file.path,staged});
    if (!file && selected) setSelected(undefined);
  }, [selected, state, view]);

  const handle = (action: GitAction) => () => void act(action);
  const files = state?.files ?? [];
  const lists = [
    {title:t("pg.staged"), items:files.filter(file => ![".", "?"].includes(file.index)), staged:true},
    {title:t("pg.unstaged"), items:files.filter(file => ![".", "?"].includes(file.worktree)), staged:false},
    {title:t("pg.untracked"), items:files.filter(file => file.index === "?"), staged:false},
  ];
  const counts: Partial<Record<View, number>> = {changes: files.length};
  return <div className="git-section git-worktree-detail">
    <div className="git-code-bar">
      <div className="g-seg" role="tablist" aria-label={t("pg.views")}>
        {views.map(name => <button key={name} type="button" role="tab" aria-selected={view === name} tabIndex={view === name ? 0 : -1} data-view={name}
          onClick={() => setView(name)} onKeyDown={event => {
            const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
            if (!step) return;
            const next = views[(views.indexOf(name) + step + views.length) % views.length]!;
            setView(next);
            (event.currentTarget.parentElement?.querySelector("[data-view=\"" + next + "\"]") as HTMLElement | null)?.focus();
          }}>{t(("pg.view." + name) as MessageKey)}{counts[name] ? <span className="g-num g-muted">{counts[name]}</span> : null}</button>)}
      </div>
      <span className="g-muted git-code-place" title={copy.root}>{host} · {copy.root}</span>
      {pin && <button type="button" className="g-btn ghost" onClick={pin}>{t("pg.pin")}</button>}
      <button type="button" className="g-btn ghost" onClick={() => {setError(""); setRevision(value => value + 1);}}><Icon name="RotateCcw" small/>{t("pg.refresh")}</button>
    </div>
    {error && <p role="alert" className="git-error">{error}</p>}
    {pending && <p role="status">{t("pg.working")}</p>}
    {state && raced && <RaceNotice raced={raced.sha} made={raced.made} head={state.head ?? null} branch={state.branch ?? null} sequence={sequence} run={run} onError={report}
      onChanged={() => setRevision(value => value + 1)} onDismiss={() => setRaced(null)}/>}
    {state && sequence && <SequenceBar sequence={sequence} state={state} run={run} onError={report} onResolve={setResolving}
      onChanged={() => { setResolving(null); setRevision(value => value + 1); }}/>}
    {resolving && sequence && <ConflictEditor key={resolving} path={resolving} kind={sequence.kind} run={run} onError={report}
      onChanged={() => setRevision(value => value + 1)} onClose={() => setResolving(null)}/>}
    {view === "changes" && state && <div className="git-changes-grid"><div className="git-change-sidebar git-stack">
      {files.length === 0 && <p className="git-muted">{t("pg.clean")}</p>}
      {lists.filter(list => list.items.length > 0 || list.staged).map(list => <section className="git-stack" key={list.title} aria-label={list.title}>
        <h3 className="g-sec">{list.title} <span className="g-num">{list.items.length}</span></h3>
        <div className="git-list">{list.items.map(file => {
          const conflict = file.index === "U" || file.worktree === "U" || ["AA","DD"].includes(file.index + file.worktree);
          return <div key={file.path} className="git-file">
            {conflict && sequence ? <button type="button" className="g-btn sm" onClick={() => setResolving(file.path)}>{t("pg.resolve")}</button>
              : <input type="checkbox" checked={list.staged} disabled={pending || conflict} title={conflict ? t("pg.conflict-first") : undefined}
                aria-label={t(list.staged ? "pg.unstage" : "pg.stage", {path: file.path})} onChange={handle({kind:"stage", path:file.path, staged:list.staged})}/>}
            <button type="button" className="git-entry" title={file.path} aria-current={selected?.path === file.path && selected.staged === list.staged}
              onClick={() => setSelected({path:file.path, staged:list.staged})}><span className="git-file-mark">{(list.staged ? file.index : file.worktree).replace(".", "?")}</span>{file.path}</button>
          </div>;
        })}</div>
      </section>)}
      {state.upstream && <details className="git-outgoing" open={outgoingOpen} onToggle={event => setOutgoingOpen((event.currentTarget as HTMLDetailsElement).open)}>
        <summary className="g-sec">{t("pg.outgoing")} {state.ahead ? <span className="g-num">{state.ahead}</span> : null}</summary>
        {outgoing ? <pre className="git-code">{outgoing.text?.trim() || t("pg.no-outgoing")}</pre> : <p className="g-muted" role="status">{t("pg.reading")}</p>}
      </details>}
      <form className="git-stack git-commit-form" onSubmit={event => {
        event.preventDefault();
        if (state.snapshot && message.trim() && !pending) {
          const author = authorName.trim() && authorEmail.trim() ? {name:authorName.trim(),email:authorEmail.trim()} : undefined;
          void act({kind:"commit", expected:state.snapshot, message,...(author ? {author} : {})});
        }
      }}>
        {(!state.author || authorName || authorEmail) && <>
          <input aria-label={t("pg.author-name")} placeholder={t("pg.author-name")} value={authorName} onChange={event => setAuthorName(event.target.value)}/>
          <input aria-label={t("pg.author-email")} placeholder={t("pg.author-email")} value={authorEmail} onChange={event => setAuthorEmail(event.target.value)}/>
        </>}
        <textarea aria-label={t("pg.message")} placeholder={t("pg.message")} maxLength={8000} value={message} onChange={event => setMessage(event.target.value)} />
        <div className="git-row">
          {state.author && <span className="git-muted git-path" title={state.author.email}>{t("pg.author", {name: state.author.name})}</span>}
          <button type="submit" className="g-btn pri" disabled={pending || !message.trim() || !lists[0].items.length || (!state.author && !(authorName.trim() && authorEmail.trim()))}>{t("pg.commit")}</button>
        </div>
      </form>
      </div>
      {selected ? <section className="git-stack git-diff-pane" aria-label={t("pg.diff")}>
        <div className="git-diff-title git-row"><strong className="git-path">{selected.path}</strong>
          <span className="git-muted">{selected.staged ? t("pg.staged") : t("pg.unstaged")}</span></div>
        {!diff ? <p role="status">{t("pg.reading-diff")}</p> : diff.hunks?.length
          ? diff.hunks.map(hunk => <article className="git-hunk" key={hunk.token}>
            <div className="git-row"><code>{hunk.text.split("\n")[0]}</code>
              <button type="button" className="g-btn sm" disabled={pending} onClick={handle({kind:"hunk", ...selected, token:hunk.token})}>
                {selected.staged ? t("pg.hunk-unstage") : t("pg.hunk-stage")}
              </button>
            </div>
            <HunkLines patch={hunk.text}/>
          </article>)
          : <pre className="git-code">{diff.text || t("pg.no-diff")}</pre>}
      </section> : <div className="git-diff-pane git-panel-message git-muted">{t("pg.no-file")}</div>}
    </div>}
    {(view === "branches" || view === "worktrees") && <>
      <div className="git-row">
        <input aria-label={t("pg.branch-name")} placeholder={t("pg.branch-name")} value={branch} onChange={event => setBranch(event.target.value)} />
        <input aria-label={t("pg.base")} placeholder={state?.head?.slice(0, 12) ?? t("pg.base")} value={base} onChange={event => setBase(event.target.value)} />
        {view === "branches" ? <>
          <button type="button" className="g-btn" disabled={pending || !branch} onClick={handle({kind:"switch",branch})}>{t("pg.switch")}</button>
          <button type="button" className="g-btn" disabled={pending || !branch || !(base || state?.head)}
            onClick={handle({kind:"branch",branch,base:base || state?.head || ""})}>{t("pg.create-branch")}</button>
        </> : <>
          <input aria-label={t("pg.destination")} placeholder={t("pg.destination")} value={destination} onChange={event => setDestination(event.target.value)} />
          <button type="button" className="g-btn" disabled={pending || !branch || !destination} onClick={handle({kind:"worktree",branch,destination,...(base ? {base} : {})})}>{t("pg.create-worktree")}</button>
        </>}
      </div>
      {view === "branches" && <div className="git-row">
        <input aria-label={t("pg.compare-base")} placeholder={t("pg.compare-base")} value={from} onChange={event => setFrom(event.target.value)} />
        <input aria-label={t("pg.compare-head")} placeholder={t("pg.compare-head")} value={against} onChange={event => setAgainst(event.target.value)} />
        <button type="button" className="g-btn" disabled={pending || !from || !against} onClick={handle({kind:"compare", base: from, head:against})}>{t("pg.compare")}</button>
      </div>}
      {view === "branches" && compared && <pre className="git-code" aria-label={t("pg.compare")}>{compared.text || t("pg.no-diff")}</pre>}
      {view === "branches" && (detail?.text !== undefined && state ? <BranchList text={detail.text} state={state} sequence={sequence} run={run} onError={report}
        onChanged={result => { setRevision(value => value + 1); setRaced(result.raced ? {sha: result.raced, made: result.head ?? null} : null); if (result.sequence?.conflicts.length) setResolving(result.sequence.conflicts[0]!.path); }}/>
        : <p className="git-muted" role="status">{t("pg.reading-branches")}</p>)}
      {view === "worktrees" && (detail?.worktrees ?? []).map(tree => <div className="git-row git-path" key={tree.path}>
        <span>{tree.branch ?? t("pg.detached")} · {tree.path}</span>
        {tree.path !== copy.root && attach && <button type="button" className="g-btn sm" onClick={() => attach(tree.path).catch(report)}>{t("pg.open-worktree")}</button>}
      </div>)}
    </>}
    {view === "activity" && (activity?.length ? activity.map(operation => <div className="git-stack git-divider" key={operation.id}>
      <strong>{operation.kind} · {operation.state}</strong>
      <p className="git-muted git-path">{operation.at} · {operation.actor} · {operation.code ?? operation.after?.slice(0,12) ?? operation.id}</p>
    </div>) : <p className="git-muted">{activity ? t("pg.no-activity") : t("pg.reading-activity")}</p>)}
  </div>;
}

function HunkLines({patch}:{patch:string}) {
  const [header,...body] = patch.replace(/\n$/,"").split("\n");
  const numbers = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(header);
  let before = Number(numbers?.[1]);
  let after = Number(numbers?.[2]);
  const lines = body.map(line => {
    const type = line[0];
    return {line,type,before:numbers && (type === " " || type === "-") ? before++ : "",
      after:numbers && (type === " " || type === "+") ? after++ : ""};
  });
  return <pre className="git-code git-numbered-diff">{lines.map(({line,type,before,after},index) =>
    <span className="git-diff-line" data-type={type} key={index}>
      <span className="git-line-number" aria-hidden="true">{before}</span>
      <span className="git-line-number" aria-hidden="true">{after}</span>
      <span>{line}{"\n"}</span>
    </span>)}</pre>;
}
