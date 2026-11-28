import { useEffect, useState } from "react";
import type { GitAction, GitResult } from "../../core/git.ts";
import { useT } from "../i18n/use-t.tsx";
import { Icon } from "../system/icon.tsx";
import type { Sequence } from "../merge/merge-actions.tsx";

type RunGit = (action: GitAction) => Promise<GitResult>;
type File = NonNullable<GitResult["files"]>[number];
type Selection = {path: string; staged: boolean};
const tones: Record<string, string> = {M: "g-warn", A: "g-good", D: "g-bad", R: "g-vio", U: "g-bad", "?": "g-good"};

/**
 * Changes: the staged and not staged files (a check box stages one, the group's action all of them), the outgoing
 * commits and the commit at the bottom of the column; the chosen file's diff beside them, each hunk's action under it.
 */
export function Changes({state, sequence, run, pending, revision, act, actAll, onResolve, onError, openReview, canPush, onCommitted}: {
  state: GitResult; sequence: Sequence | null; run: RunGit; pending: boolean; revision: number;
  /** Runs one write; resolves true when it went through. */
  act(action: GitAction): Promise<boolean>;
  /** Runs writes one after another, then reads the copy once. */
  actAll(actions: GitAction[]): Promise<void>;
  onResolve(path: string): void; onError(cause: unknown): void;
  openReview?(path: string): void;
  /** Whether a push can go where it should (a local origin): asked before Commit and push commits anything. */
  canPush(): Promise<boolean>;
  /** A commit went through and should be pushed (Commit and push). */
  onCommitted(push: boolean): void;
}) {
  const t = useT();
  const [selected, setSelected] = useState<Selection>();
  const [diff, setDiff] = useState<GitResult>();
  const [outgoing, setOutgoing] = useState<GitResult | null>(null);
  const [outgoingOpen, setOutgoingOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [editAuthor, setEditAuthor] = useState(false);
  const [authorName, setAuthorName] = useState("");
  const [authorEmail, setAuthorEmail] = useState("");
  const files = state.files ?? [];
  const staged = files.filter(file => ![".", "?"].includes(file.index));
  const unstaged = files.filter(file => ![".", "?"].includes(file.worktree) || file.index === "?");

  // The chosen file stays chosen while it is listed; otherwise the first one is shown.
  useEffect(() => {
    const file = files.find(item => item.path === selected?.path) ?? files[0];
    if (!file) { if (selected) setSelected(undefined); return; }
    const inIndex = ![".", "?"].includes(file.index) && ([".", "?"].includes(file.worktree) || (file.path === selected?.path && selected.staged));
    if (file.path !== selected?.path || inIndex !== selected.staged) setSelected({path: file.path, staged: inIndex});
  }, [state, selected]);
  useEffect(() => {
    let active = true;
    setDiff(undefined);
    if (selected) run({kind: "diff", ...selected}).then(value => { if (active) setDiff(value); }, cause => { if (active) onError(cause); });
    return () => { active = false; };
  }, [selected, run, revision, onError]);
  // The outgoing commits are read while they are unfolded, and again when the copy changes; a late answer is dropped.
  useEffect(() => {
    let active = true;
    setOutgoing(null);
    if (outgoingOpen && state.upstream) run({kind: "outgoing"}).then(value => { if (active) setOutgoing(value); }, cause => { if (active) onError(cause); });
    return () => { active = false; };
  }, [outgoingOpen, state.upstream, run, revision, onError]);

  const typed = authorName.trim() && authorEmail.trim() ? {name: authorName.trim(), email: authorEmail.trim()} : null;
  const canCommit = !pending && !!message.trim() && staged.length > 0 && !!state.snapshot && (!!state.author || !!typed);
  const commit = async (push: boolean) => {
    if (!canCommit || (push && !await canPush())) return;
    if (await act({kind: "commit", expected: state.snapshot!, message, ...(typed ? {author: typed} : {})})) {
      setMessage("");
      setEditAuthor(false);
      onCommitted(push);
    }
  };
  const conflictOf = (file: File) => file.index === "U" || file.worktree === "U" || ["AA", "DD"].includes(file.index + file.worktree);
  const group = (title: string, items: File[], inIndex: boolean) => <section className="git-changes-group" aria-label={title}>
    <header><h3 className="g-sec">{title} <span className="g-num">{items.length}</span></h3>
      {items.length > 0 && <button type="button" className="g-btn ghost sm" disabled={pending || items.some(conflictOf)}
        onClick={() => void actAll(items.map(file => ({kind: "stage", path: file.path, staged: inIndex})))}>{t(inIndex ? "pg.unstage-all" : "pg.stage-all")}</button>}
    </header>
    {items.map(file => {
      const mark = (inIndex ? file.index : file.worktree === "." ? file.index : file.worktree).replace(".", "?");
      const letter = file.index === "?" ? "U" : mark;
      const slash = file.path.lastIndexOf("/");
      const conflict = conflictOf(file);
      const here = selected?.path === file.path && selected.staged === inIndex;
      return <div key={file.path} className={"git-changes-file" + (here ? " sel" : "")}>
        {conflict && sequence ? <button type="button" className="g-btn sm" onClick={() => onResolve(file.path)}>{t("pg.resolve")}</button>
          : <input type="checkbox" checked={inIndex} disabled={pending || conflict} title={conflict ? t("pg.conflict-first") : undefined}
            aria-label={t(inIndex ? "pg.unstage" : "pg.stage", {path: file.path})} onChange={() => void act({kind: "stage", path: file.path, staged: inIndex})}/>}
        <button type="button" className="git-changes-name" title={file.path} aria-current={here || undefined} onClick={() => setSelected({path: file.path, staged: inIndex})}>
          <span className={"git-changes-mark " + (tones[letter === "U" && file.index === "?" ? "?" : letter] ?? "")}>{letter}</span>
          <span className="git-changes-path">{slash >= 0 && <span className="g-muted">{file.path.slice(0, slash + 1)}</span>}{file.path.slice(slash + 1)}</span>
        </button>
      </div>;
    })}
  </section>;

  return <div className="git-changes">
    <div className="git-changes-side">
      <div className="git-changes-lists">
        {files.length === 0 && <p className="g-muted git-changes-clean">{t("pg.clean")}</p>}
        {files.length > 0 && group(t("pg.staged"), staged, true)}
        {unstaged.length > 0 && group(t("pg.unstaged"), unstaged, false)}
        {state.upstream && <details className="git-changes-outgoing" open={outgoingOpen} onToggle={event => setOutgoingOpen((event.currentTarget as HTMLDetailsElement).open)}>
          <summary className="g-sec">{t("pg.outgoing")} <span className="g-num">{state.ahead ?? 0}</span></summary>
          {outgoing ? <ul className="git-changes-commits">{(outgoing.text ?? "").split("\n").filter(Boolean).map(line => {
            const [sha = "", date = "", ...subject] = line.split(" ");
            return <li key={sha}><span className="g-mono g-muted">{sha.slice(0, 7)}</span> {subject.join(" ")} <span className="g-muted">{date}</span></li>;
          })}{!(outgoing.text ?? "").trim() && <li className="g-muted">{t("pg.no-outgoing")}</li>}</ul>
            : <p className="g-muted" role="status">{t("pg.reading")}</p>}
        </details>}
      </div>
      <form className="git-changes-commit" onSubmit={event => { event.preventDefault(); void commit(false); }}>
        <textarea aria-label={t("pg.message")} placeholder={t("pg.message")} maxLength={8000} value={message} onChange={event => setMessage(event.target.value)}/>
        {(editAuthor || !state.author) && <details className="git-changes-author" open={editAuthor || undefined}>
          {!editAuthor && <summary className="g-muted">{t("pg.author-missing")}</summary>}
          <input aria-label={t("pg.author-name")} placeholder={t("pg.author-name")} value={authorName} onChange={event => setAuthorName(event.target.value)}/>
          <input aria-label={t("pg.author-email")} placeholder={t("pg.author-email")} value={authorEmail} onChange={event => setAuthorEmail(event.target.value)}/>
        </details>}
        <div className="git-changes-commit-row">
          {state.author && !editAuthor ? <button type="button" className="git-changes-who" title={t("pg.author-edit") + " · " + state.author.email}
            onClick={() => { setAuthorName(state.author!.name); setAuthorEmail(state.author!.email); setEditAuthor(true); }}>
            {t("pg.author", {name: state.author.name})}</button> : <span/>}
          <button type="submit" className="g-btn" disabled={!canCommit}>{t("pg.commit")}</button>
          <button type="button" className="g-btn pri" disabled={!canCommit || !state.branch} onClick={() => void commit(true)}>{t("pg.commit-push")}</button>
        </div>
      </form>
    </div>
    {selected ? <section className="git-changes-diff" aria-label={t("pg.diff")}>
      <header><Icon name="FileDiff" small/><strong className="g-mono">{selected.path}</strong>
        <span className="g-muted">{selected.staged ? t("pg.staged") : t("pg.unstaged")}</span></header>
      {!diff ? <p className="g-muted" role="status">{t("pg.reading-diff")}</p> : diff.hunks?.length ? <>
        {diff.hunks.map(hunk => <article className="git-changes-hunk" key={hunk.token}>
          <HunkLines patch={hunk.text}/>
          <div className="git-changes-hunk-actions">
            <button type="button" className="g-btn sm" disabled={pending} onClick={() => void act({kind: "hunk", ...selected, token: hunk.token})}>
              {selected.staged ? t("pg.hunk-unstage") : t("pg.hunk-stage")}</button>
          </div>
        </article>)}
        {openReview && <div className="git-changes-hunk-actions"><button type="button" className="g-btn ghost sm" onClick={() => openReview(selected.path)}>
          <Icon name="MessageSquare" small/>{t("pg.open-review")}</button></div>}
      </> : <pre className="git-changes-plain">{diff.text || t("pg.no-diff")}</pre>}
    </section> : <div className="git-changes-diff g-muted git-changes-clean">{t("pg.no-file")}</div>}
  </div>;
}

/** A hunk as numbered lines: old and new line numbers, then the line; added and removed lines tinted. */
export function HunkLines({patch}: {patch: string}) {
  const [header, ...body] = patch.replace(/\n$/, "").split("\n");
  const numbers = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(header ?? "");
  let before = Number(numbers?.[1]);
  let after = Number(numbers?.[2]);
  return <pre className="git-changes-lines"><span className="git-changes-line" data-type="@"><span/><span/><span>{header}</span></span>{body.map((line, index) => {
    const type = line[0];
    const left = numbers && (type === " " || type === "-") ? before++ : "";
    const right = numbers && (type === " " || type === "+") ? after++ : "";
    return <span className="git-changes-line" data-type={type} key={index}>
      <span aria-hidden="true">{left}</span><span aria-hidden="true">{right}</span><span>{line}{"\n"}</span>
    </span>;
  })}</pre>;
}
