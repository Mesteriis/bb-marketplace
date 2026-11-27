import { useCallback, useEffect, useState } from "react";
import type { GitAction, GitResult } from "../core/git.ts";
import type { Copy, Operation } from "../core/workspace.ts";
import { ConflictEditor } from "./merge/conflict-editor.tsx";
import { BranchList, SequenceBar, type Sequence } from "./merge/merge-actions.tsx";

export type RunGit = (action: GitAction) => Promise<GitResult>;
type View = "Changes" | "History" | "Branches" | "Worktrees" | "Activity";
type Selection = {path: string; staged: boolean};

export function Worktree({copy, host, run, refresh, loadOperations, attach, pin}: {
  copy: Copy;
  host: string;
  run: RunGit;
  refresh: number;
  loadOperations(): Promise<Operation[]>;
  attach?(root: string): Promise<void>;
  pin?(): void;
}) {
  const [view, setView] = useState<View>("Changes");
  const [state, setState] = useState<GitResult>();
  const [detail, setDetail] = useState<GitResult>();
  const [selected, setSelected] = useState<Selection>();
  const [diff, setDiff] = useState<GitResult>();
  const [activity, setActivity] = useState<Operation[]>();
  const [authorName,setAuthorName] = useState("");
  const [authorEmail,setAuthorEmail] = useState("");
  const [message, setMessage] = useState("");
  const [branch, setBranch] = useState("");
  const [base, setBase] = useState("");
  const [destination, setDestination] = useState("");
  const [against, setAgainst] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [revision, setRevision] = useState(0);
  // A merge, rebase, cherry-pick or revert left in progress, and the conflicted file open in the editor.
  const [sequence, setSequence] = useState<Sequence | null>(null);
  const [resolving, setResolving] = useState<string | null>(null);

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
    const kind = view === "History" ? "history" : view === "Branches" ? "branches" : view === "Worktrees" ? "worktrees" : null;
    const load = async () => {
      try {
        if (kind) {
          const result = await run({kind});
          if (active) setDetail(result);
        } else if (view === "Activity") {
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
    if (selected && view === "Changes") {
      run({kind:"diff", ...selected}).then(result => { if (active) setDiff(result); }, error => { if (active) report(error); });
    }
    return () => { active = false; };
  }, [selected, view, run, revision, refresh, report]);

  async function act(action: GitAction) {
    setPending(true);
    setError("");
    try {
      const result = await run(action);
      if (result.text === "BRANCH_OCCUPIED") {
        setError("Branch is in use at " + result.worktrees?.[0]?.path);
        return;
      }
      if (action.kind === "commit") setMessage("");
      if (action.kind === "compare" || action.kind === "outgoing") setDetail(result);
      else setRevision(value => value + 1);
    } catch (error) { report(error); }
    finally { setPending(false); }
  }

  useEffect(() => {
    if (!state?.files || view !== "Changes") return;
    const file = state.files.find(file => file.path === selected?.path) ?? state.files[0];
    const staged = file ? ![".","?"].includes(file.index) &&
      ([".","?"].includes(file.worktree) || (file.path === selected?.path && selected.staged)) : false;
    if (file && (file.path !== selected?.path || staged !== selected.staged)) setSelected({path:file.path,staged});
    if (!file && selected) setSelected(undefined);
  }, [selected, state, view]);

  const handle = (action: GitAction) => () => void act(action);
  const files = state?.files ?? [];
  const lists = [
    {title:"Staged", items:files.filter(file => ![".", "?"].includes(file.index)), staged:true},
    {title:"Unstaged", items:files.filter(file => ![".", "?"].includes(file.worktree)), staged:false},
    {title:"Untracked", items:files.filter(file => file.index === "?"), staged:false},
  ];
  return <div className="git-section git-worktree-detail">
    <header className="git-worktree-header">
      <div className="git-row git-worktree-identity" title={copy.root}>
        <h2>{copy.repositoryName ?? copy.root.split(/[\\/]/).pop()}</h2>
        <span aria-hidden="true" className="git-muted">/</span>
        <strong>{state ? state.branch ?? "Detached HEAD" : "Reading branch…"}</strong>
        <span className="git-muted">· {host}</span>
      </div>
      <div className="git-row">
        {pin && <button type="button" onClick={pin}>Pin worktree</button>}
        <button type="button" onClick={() => {setError(""); setRevision(value => value + 1);}}>Refresh</button>
      </div>
      {state && <p className="git-muted git-path git-worktree-revision" title={copy.root}>{state.head?.slice(0,12) ?? "Unborn HEAD"} · {state.upstream ?
        state.upstream + (state.ahead !== undefined ? " · ↑" + state.ahead + " ↓" + state.behind : " · divergence unavailable") : "No upstream"}</p>}
    </header>
    <nav aria-label="Worktree views" className="git-row git-divider">
      {(["Changes","History","Branches","Worktrees","Activity"] as const).map(name =>
        <button key={name} type="button" aria-current={view === name} onClick={() => setView(name)}>{name}</button>)}
    </nav>
    {error && <p role="alert" className="git-error">{error}</p>}
    {pending && <p role="status">Git operation in progress…</p>}
    {state && sequence && <SequenceBar sequence={sequence} state={state} run={run} onError={report} onResolve={setResolving}
      onChanged={() => { setResolving(null); setRevision(value => value + 1); }}/>}
    {resolving && sequence && <ConflictEditor key={resolving} path={resolving} kind={sequence.kind} run={run} onError={report}
      onChanged={() => setRevision(value => value + 1)} onClose={() => setResolving(null)}/>}
    {view === "Changes" && state && <>
      <div className="git-changes-grid"><div className="git-change-sidebar git-stack">
      {files.length === 0 && <p className="git-muted">Working tree is clean.</p>}
      {lists.filter(list => list.items.length > 0 || list.staged).map(list => <section className="git-stack" key={list.title}>
        <strong>{list.title} · {list.items.length}</strong>
        <div className="git-list">{list.items.map(file => {
          const conflict = file.index === "U" || file.worktree === "U" || ["AA","DD"].includes(file.index + file.worktree);
          return <div key={file.path} className="git-file">
            <button type="button" className="git-entry" title={file.path} aria-current={selected?.path === file.path && selected.staged === list.staged}
              onClick={() => setSelected({path:file.path, staged:list.staged})}><span className="git-file-mark">{(list.staged ? file.index : file.worktree).replace(".", "?")}</span>{file.path}</button>
            {conflict && sequence ? <button type="button" onClick={() => setResolving(file.path)}>Resolve…</button>
              : <button type="button" disabled={pending || conflict} title={conflict ? "Resolve this conflict in the worktree first" : undefined}
                onClick={handle({kind:"stage", path:file.path, staged:list.staged})}>{conflict ? "Conflict" : list.staged ? "Unstage" : "Stage"}</button>}
          </div>;
        })}</div>
      </section>)}
      <form className="git-stack git-commit-form" onSubmit={event => {
        event.preventDefault();
        if (state.snapshot && message.trim() && !pending) {
          const author = authorName.trim() && authorEmail.trim() ? {name:authorName.trim(),email:authorEmail.trim()} : undefined;
          void act({kind:"commit", expected:state.snapshot, message,...(author ? {author} : {})});
        }
      }}>
        {state.author && <span className="git-muted git-path" title={state.author.email}>Git author · {state.author.name}</span>}
        {(!state.author || authorName || authorEmail) && <>
          <input aria-label="Git author name" placeholder="Git author name" value={authorName} onChange={event => setAuthorName(event.target.value)}/>
          <input aria-label="Git author email" placeholder="Git author email" value={authorEmail} onChange={event => setAuthorEmail(event.target.value)}/>
        </>}
        <textarea aria-label="Commit message" placeholder="Commit message" maxLength={8000} value={message} onChange={event => setMessage(event.target.value)} />
        <button type="submit" className="git-primary" disabled={pending || !message.trim() || !lists[0].items.length || (!state.author && !(authorName.trim() && authorEmail.trim()))}>Commit staged changes</button>
      </form>
      </div>
      {selected ? <section className="git-stack git-diff-pane" aria-label="File diff">
        <div className="git-diff-title git-row"><strong className="git-path">{selected.path}</strong>
          <span className="git-muted">{selected.staged ? "Staged" : "Unstaged"}</span></div>
        {!diff ? <p role="status">Reading diff…</p> : diff.hunks?.length
          ? diff.hunks.map(hunk => <article className="git-hunk" key={hunk.token}>
            <div className="git-row"><code>{hunk.text.split("\n")[0]}</code>
              <button type="button" disabled={pending} onClick={handle({kind:"hunk", ...selected, token:hunk.token})}>
                {selected.staged ? "Unstage hunk" : "Stage hunk"}
              </button>
            </div>
            <HunkLines patch={hunk.text}/>
          </article>)
          : <pre className="git-code">{diff.text || "No textual diff for this selection."}</pre>}
      </section> : <div className="git-diff-pane git-panel-message git-muted">No file changes to display.</div>}
      </div>
      <div className="git-row">
        <button type="button" disabled={pending} onClick={handle({kind:"fetch"})}>Fetch local origin</button>
        <button type="button" disabled={pending || !state.upstream} onClick={handle({kind:"fastForward"})}>Fast-forward</button>
        <button type="button" disabled={pending || !state.head || !state.branch} onClick={() => {
          if (!state.head || !state.branch) return;
          const {head, branch} = state;
          run({kind:"localOrigin"}).then(origin => {
            if (origin.text && window.confirm("Push " + head.slice(0, 12) + " to " + origin.text + " → " + branch + "?"))
              void act({kind:"push", expected:head, branch, destination:origin.text});
          }, report);
        }}>Push to local origin</button>
      </div>
    </>}
    {view === "History" && <>
      <div className="git-row">
        <input aria-label="Base revision" placeholder="Base commit SHA" value={base} onChange={event => setBase(event.target.value)} />
        <input aria-label="Head revision" placeholder="Head commit SHA" value={against} onChange={event => setAgainst(event.target.value)} />
        <button type="button" disabled={pending || !base || !against} onClick={handle({kind:"compare", base, head:against})}>Compare</button>
        <button type="button" disabled={pending || !state?.upstream} onClick={handle({kind:"outgoing"})}>Outgoing commits</button>
      </div>
      <pre className="git-code">{detail?.text ?? "Reading history…"}</pre>
    </>}
    {(view === "Branches" || view === "Worktrees") && <>
      <div className="git-row">
        <input aria-label="Branch name" placeholder="Branch name" value={branch} onChange={event => setBranch(event.target.value)} />
        <input aria-label="Base commit" placeholder={state?.head?.slice(0, 12) ?? "Base commit SHA"} value={base} onChange={event => setBase(event.target.value)} />
        {view === "Branches" ? <>
          <button type="button" disabled={pending || !branch} onClick={handle({kind:"switch",branch})}>Switch</button>
          <button type="button" disabled={pending || !branch || !(base || state?.head)}
            onClick={handle({kind:"branch",branch,base:base || state?.head || ""})}>Create branch</button>
        </> : <>
          <input aria-label="Worktree destination" placeholder="Absolute destination" value={destination} onChange={event => setDestination(event.target.value)} />
          <button type="button" disabled={pending || !branch || !destination} onClick={handle({kind:"worktree",branch,destination,...(base ? {base} : {})})}>Create worktree</button>
        </>}
      </div>
      {view === "Branches" && (detail?.text !== undefined && state ? <BranchList text={detail.text} state={state} sequence={sequence} run={run} onError={report}
        onChanged={result => { setRevision(value => value + 1); if (result.sequence?.conflicts.length) setResolving(result.sequence.conflicts[0]!.path); }}/>
        : <p className="git-muted" role="status">Reading branches…</p>)}
      {view === "Worktrees" && (detail?.worktrees ?? []).map(tree => <div className="git-row git-path" key={tree.path}>
        <span>{tree.branch ?? "Detached"} · {tree.path}</span>
        {tree.path !== copy.root && attach && <button type="button" onClick={() => attach(tree.path).catch(report)}>Open worktree</button>}
      </div>)}
    </>}
    {view === "Activity" && (activity?.length ? activity.map(operation => <div className="git-stack git-divider" key={operation.id}>
      <strong>{operation.kind} · {operation.state}</strong>
      <p className="git-muted git-path">{operation.at} · {operation.actor} · {operation.code ?? operation.after?.slice(0,12) ?? operation.id}</p>
    </div>) : <p className="git-muted">{activity ? "No recorded operations." : "Reading activity…"}</p>)}
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
