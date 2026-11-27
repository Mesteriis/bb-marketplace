import { useMemo, useState } from "react";
import { parseHunks } from "../../core/code-review/revert.ts";
import { message } from "./review-api.ts";

/**
 * Reverting an uncommitted file to HEAD, or some of its hunks, after confirming: the change is lost. Follows
 * diff-review app/revert-dialog.tsx (MIT, gpambrozio); see THIRD_PARTY_NOTICES.md. `patch` is null when hunks cannot
 * be picked (whitespace hidden, or no line diff).
 */
export function RevertForm({path, changeKind, patch, onRevert, onClose}: {
  path: string; changeKind: string; patch: string | null; onRevert(hunks: number[] | null): Promise<void>; onClose(): void;
}) {
  const hunks = useMemo(() => patch ? parseHunks(patch).filter(hunk => hunk.complete) : [], [patch]);
  const [whole, setWhole] = useState(true);
  const [chosen, setChosen] = useState<number[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const what = changeKind === "added" ? "Delete the new file " + path : changeKind === "deleted" ? "Restore the deleted file " + path : "Revert all changes to " + path;
  const go = async () => {
    setPending(true); setError("");
    try { await onRevert(whole ? null : chosen); onClose(); }
    catch (cause) { setError(message(cause)); }
    finally { setPending(false); }
  };
  return <div className="git-ci-threads git-stack" role="alertdialog" aria-label={"Revert " + path}>
    {hunks.length > 1 && changeKind === "modified" ? <div className="git-stack" role="radiogroup" aria-label="What to revert">
      <label><input type="radio" checked={whole} onChange={() => setWhole(true)}/> The whole file</label>
      <label><input type="radio" checked={!whole} onChange={() => setWhole(false)}/> Some changes</label>
      {!whole && hunks.map((hunk, index) => <label key={index} className="git-path"><input type="checkbox" checked={chosen.includes(index)}
        onChange={() => setChosen(value => value.includes(index) ? value.filter(item => item !== index) : [...value, index])}/> {hunk.header}</label>)}
    </div> : null}
    <p>{whole ? what + " to the last commit?" : "Revert " + chosen.length + " change" + (chosen.length === 1 ? "" : "s") + " in " + path + " to the last commit?"} This cannot be undone.</p>
    <div className="git-row">
      <button type="button" className="git-danger" disabled={pending || (!whole && !chosen.length)} onClick={() => void go()}>{pending ? "Reverting…" : "Revert"}</button>
      <button type="button" autoFocus onClick={onClose}>Cancel</button>
    </div>
    {error && <p className="git-error" role="alert">{error}</p>}
  </div>;
}
