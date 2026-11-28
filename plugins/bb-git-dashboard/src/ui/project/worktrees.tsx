import { useState } from "react";
import type { GitAction, GitResult } from "../../core/git.ts";
import { homeRelative } from "../../core/short-path.ts";
import type { Copy } from "../../core/workspace.ts";
import { useT } from "../i18n/use-t.tsx";
import { Dialog } from "../system/dialog.tsx";

type Tree = NonNullable<GitResult["worktrees"]>[number];

/** The repository's worktrees as a table: which is the main copy, its branch, state, machine and path, and Open. */
export function Worktrees({copy, host, trees, state, pending, act, attach, onError, creating, onCreating}: {copy: Copy; host: string; trees: Tree[];
  state: GitResult; pending: boolean; act(action: GitAction): Promise<boolean>; attach?(root: string): Promise<void>; onError(cause: unknown): void;
  creating: boolean; onCreating(open: boolean): void}) {
  const t = useT();
  const files = state.files?.length ?? 0;
  return <div className="git-worktrees">
    <table className="g-table two" aria-label={t("pg.view.worktrees")}>
      <thead><tr><th>{t("wt.col.tree")}</th><th>{t("wt.col.branch")}</th><th>{t("wt.col.state")}</th><th>{t("wt.col.place")}</th><th><span className="g-sr">{t("br.col.actions")}</span></th></tr></thead>
      <tbody>{trees.map((tree, index) => {
        const here = tree.path === copy.root;
        return <tr key={tree.path} aria-current={here || undefined}>
          <td><strong>{tree.path.split(/[\\/]/).pop()}</strong><div className="g-muted">{index === 0 ? t("wt.main") : t("wt.linked")}{here ? " · " + t("wt.this") : ""}</div></td>
          <td>{tree.branch ? <span className="g-branch">{tree.branch}</span> : <span className="g-muted">{t("pg.detached")}</span>}</td>
          <td>{here ? [files ? t("wt.files", {n: files}) : t("wt.clean"), state.ahead ? "↑" + state.ahead : "", state.behind ? "↓" + state.behind : ""].filter(Boolean).join(" · ") : "—"}</td>
          <td><div>{host}</div><div className="g-mono g-muted" title={tree.path}>{homeRelative(tree.path)}</div></td>
          <td className="git-branches-actions">{here ? <span className="g-chip line">{t("wt.opened")}</span>
            : attach && <button type="button" className="g-btn sm" disabled={pending} onClick={() => attach(tree.path).catch(onError)}>{t("wt.open")}</button>}</td>
        </tr>;
      })}</tbody>
    </table>
    <p className="g-muted git-branches-note">{t("wt.note")}</p>
    {creating && <CreateWorktree copy={copy} base={state.head ?? null} act={act} onClose={() => onCreating(false)}/>}
  </div>;
}

/** A worktree on a new branch from the copy's current commit (`base`), in a folder that does not exist yet. */
function CreateWorktree({copy, base, act, onClose}: {copy: Copy; base: string | null; act(action: GitAction): Promise<boolean>; onClose(): void}) {
  const t = useT();
  const [branch, setBranch] = useState("");
  const [destination, setDestination] = useState("");
  const [busy, setBusy] = useState(false);
  // A sibling of the copy named after the branch, until a folder is typed.
  const parent = copy.root.replace(/[\\/][^\\/]+$/, "");
  const suggested = branch.trim() ? parent + "/" + (copy.root.split(/[\\/]/).pop() ?? "copy") + "-" + branch.trim().replace(/[^A-Za-z0-9._-]+/g, "-") : "";
  const target = destination.trim() || suggested;
  const create = async () => {
    setBusy(true);
    const made = await act({kind: "worktree", branch: branch.trim(), destination: target, ...(base ? {base} : {})});
    setBusy(false);
    if (made) onClose();
  };
  return <Dialog title={t("wt.create-title")} busy={busy} onClose={onClose} actions={<>
    <button type="button" className="g-btn" disabled={busy} onClick={onClose}>{t("common.cancel")}</button>
    <button type="button" className="g-btn pri" disabled={busy || !branch.trim() || !target} onClick={() => void create()}>{t("wt.create")}</button>
  </>}>
    <label>{t("wt.branch")}<input className="g-inp" value={branch} autoFocus onChange={event => setBranch(event.target.value)}/></label>
    <label>{t("wt.destination")}<input className="g-inp g-mono" value={destination} placeholder={suggested} onChange={event => setDestination(event.target.value)}/></label>
  </Dialog>;
}
