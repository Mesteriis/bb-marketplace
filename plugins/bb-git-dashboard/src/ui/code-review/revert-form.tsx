import { useMemo, useState } from "react";
import { parseHunks } from "../../core/code-review/revert.ts";
import { message } from "./review-api.ts";
import { useT } from "../i18n/use-t.tsx";

/**
 * Reverting an uncommitted file to HEAD, or some of its hunks, after confirming: the change is lost. Follows
 * diff-review app/revert-dialog.tsx (MIT, gpambrozio); see THIRD_PARTY_NOTICES.md. `patch` is null when hunks cannot
 * be picked (whitespace hidden, or no line diff).
 */
export function RevertForm({path, changeKind, patch, onRevert, onClose}: {
  path: string; changeKind: string; patch: string | null; onRevert(hunks: number[] | null): Promise<void>; onClose(): void;
}) {
  const t = useT();
  const hunks = useMemo(() => patch ? parseHunks(patch).filter(hunk => hunk.complete) : [], [patch]);
  const [whole, setWhole] = useState(true);
  const [chosen, setChosen] = useState<number[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const what = t(changeKind === "added" ? "cr.rv.delete-new" : changeKind === "deleted" ? "cr.rv.restore" : "cr.rv.all", {path});
  const go = async () => {
    setPending(true); setError("");
    try { await onRevert(whole ? null : chosen); onClose(); }
    catch (cause) { setError(message(cause)); }
    finally { setPending(false); }
  };
  return <div className="git-ci-threads git-cr-revert" role="alertdialog" aria-label={t("cr.rv.label", {path})}>
    {hunks.length > 1 && changeKind === "modified" ? <div className="git-cr-revert-pick" role="radiogroup" aria-label={t("cr.rv.what")}>
      <label><input type="radio" checked={whole} onChange={() => setWhole(true)}/> {t("cr.rv.whole")}</label>
      <label><input type="radio" checked={!whole} onChange={() => setWhole(false)}/> {t("cr.rv.some")}</label>
      {!whole && hunks.map((hunk, index) => <label key={index} className="git-path"><input type="checkbox" checked={chosen.includes(index)}
        onChange={() => setChosen(value => value.includes(index) ? value.filter(item => item !== index) : [...value, index])}/> {hunk.header}</label>)}
    </div> : null}
    <p>{whole ? what : t("cr.rv.some-text", {n: chosen.length, path})} {t("cr.rv.final")}</p>
    <div className="git-cr-send-actions">
      <button type="button" className="g-btn pri git-danger" disabled={pending || (!whole && !chosen.length)} onClick={() => void go()}>{pending ? t("cr.rv.doing") : t("cr.rv.do")}</button>
      <button type="button" className="g-btn ghost" autoFocus onClick={onClose}>{t("common.cancel")}</button>
    </div>
    {error && <p className="git-error" role="alert">{error}</p>}
  </div>;
}
