import { useCallback, useEffect, useState } from "react";
import { targetFromKey } from "../../core/code-review/model.ts";
import { targetWords } from "../../core/code-review/target-words.ts";
import { ago } from "../../core/i18n/time.ts";
import { useLanguage, useT } from "../i18n/use-t.tsx";
import { PageHead } from "../shell/page-head.tsx";
import { Dialog } from "../system/dialog.tsx";
import { Icon } from "../system/icon.tsx";
import { message } from "./review-api.ts";

export type ReviewSummary = {sessionId: string; copyId: string; copyName: string | null; orphan: boolean; targetKey: string; view: string;
  open: number; total: number; updatedAt: number;
  /** When comments last went to an agent; open ones it answered (waiting for you) and open ones not answered yet. */
  agent: {sentAt: number | null; answered: number; waiting: number};
  /** The latest AI review: its state, model, start and the threads it opened. */
  ai: {status: "running" | "done" | "failed" | "closed"; model: string | null; startedAt: number; findings: number} | null};
export type ReviewsApi = {
  summaries(): Promise<ReviewSummary[]>;
  deleteOrphans(sessionIds: string[]): Promise<{deleted: number; deletedThreads: number}>;
};
type T = ReturnType<typeof useT>;

/**
 * Every line review that has comment threads, newest first, as a table: the working copy, what it looks at, its
 * comments, where the agent stands and the last AI review. A review whose working copy is gone can be deleted after
 * confirming. Follows diff-review app/reviews-page.tsx and app/orphans.tsx (MIT, gpambrozio); see THIRD_PARTY_NOTICES.md.
 */
export function ReviewsPage({api, revision, onOpen}: {api: ReviewsApi; revision: number; onOpen(copyId: string, targetKey: string): void}) {
  const t = useT();
  const {language} = useLanguage();
  const [reviews, setReviews] = useState<ReviewSummary[]>();
  const [error, setError] = useState("");
  // One review, or every review of a copy that is gone, asked about before it is deleted.
  const [asked, setAsked] = useState<ReviewSummary[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [again, setAgain] = useState(0);
  const load = useCallback(() => api.summaries().then(rows => { setReviews(rows); setError(""); }, cause => setError(message(cause))), [api]);
  useEffect(() => { void load(); }, [load, revision, again]);
  const now = Date.now();
  const when = (at: number) => { const text = ago(language, now, new Date(at).toISOString()); return text === t("time.now") ? text : t("ci.ago", {when: text}); };
  const view = (key: string) => { const words = targetWords(targetFromKey(key)); return t(words.key, words.values); };
  const orphans = reviews?.filter(row => row.orphan) ?? [];
  const live = reviews?.filter(row => !row.orphan) ?? [];
  const remove = async (rows: ReviewSummary[]) => {
    setBusy(true);
    try {
      const {deletedThreads} = await api.deleteOrphans(rows.map(row => row.sessionId));
      setStatus(t("rv.deleted", {n: deletedThreads}));
      setAsked(null);
    } catch (cause) { setStatus(t("rv.not-deleted", {error: message(cause)})); setAsked(null); }
    finally { setBusy(false); }
    await load();
  };
  return <div className="g-page git-reviews-page" role="region" aria-label={t("section.reviews")}>
    <PageHead title={t("section.reviews")} sub={t("rv.sub")}
      actions={<button type="button" className="g-btn" onClick={() => setAgain(value => value + 1)}><Icon name="RotateCcw" small/>{t("ci.refresh")}</button>}/>
    {error && <div className="g-banner bad" role="alert">{error}</div>}
    {!reviews && !error && <p className="g-state-page" role="status">{t("rv.loading")}</p>}
    {status && <p className="git-ci-status g-muted" role="status">{status}</p>}
    {reviews && !reviews.length && <p className="g-state-page">{t("rv.none")}</p>}
    {live.length > 0 && <div className="g-scroll"><table className="g-table two git-reviews-table" aria-label={t("rv.list")}>
      <thead><tr><th scope="col">{t("rv.col.copy")}</th><th scope="col">{t("rv.col.view")}</th><th scope="col">{t("rv.col.comments")}</th>
        <th scope="col">{t("rv.col.agent")}</th><th scope="col">{t("rv.col.ai")}</th><th scope="col">{t("rv.col.updated")}</th></tr></thead>
      <tbody>{live.map(row => <tr key={row.sessionId} className="git-reviews-row" onClick={() => onOpen(row.copyId, row.targetKey)}>
        <th scope="row"><button type="button" className="git-ci-entry" onClick={event => { event.stopPropagation(); onOpen(row.copyId, row.targetKey); }}
          aria-label={t("rv.open", {name: row.copyName ?? row.copyId, view: view(row.targetKey)})}>{row.copyName}</button></th>
        <td>{view(row.targetKey)}</td>
        <td className="git-reviews-comments">{row.open > 0 ? <><span className="g-chip warn">{t("rv.open-n", {n: row.open})}</span> <span className="g-muted">{t("rv.of", {n: row.total})}</span></>
          : <span className="g-muted">{t("rv.open-none", {n: row.total})}</span>}</td>
        <td>{agentWords(t, row, when)}</td>
        <td><AiWords t={t} ai={row.ai}/></td>
        <td className="g-muted">{when(row.updatedAt)}</td>
      </tr>)}</tbody>
    </table></div>}
    {orphans.length > 0 && <section className="git-reviews-gone" aria-labelledby="git-reviews-gone">
      <h2 id="git-reviews-gone" className="g-sec">{t("rv.gone")} <span className="g-num">{orphans.length}</span></h2>
      <p className="g-muted">{t("rv.gone-why")}{orphans.length > 1 && <> <button type="button" className="g-btn ghost sm" onClick={() => setAsked(orphans)}>
        <Icon name="Trash2" small/>{t("rv.delete-all", {n: orphans.length})}</button></>}</p>
      <ul>{orphans.map(row => <li key={row.sessionId}>
        <span className="git-reviews-gone-name">{view(row.targetKey)}</span>
        <span className="g-muted">{t("rv.gone-line", {when: when(row.updatedAt), n: row.total})}</span>
        <button type="button" className="g-btn ghost sm" onClick={() => setAsked([row])}><Icon name="Trash2" small/>{t("rv.delete")}</button>
      </li>)}</ul>
    </section>}
    {asked && <Dialog title={t("rv.delete-title")} busy={busy} onClose={() => setAsked(null)} actions={<>
      <button type="button" className="g-btn" disabled={busy} autoFocus onClick={() => setAsked(null)}>{t("common.cancel")}</button>
      <button type="button" className="g-btn pri git-danger" disabled={busy} onClick={() => void remove(asked)}>{t("rv.delete")}</button>
    </>}><p>{asked.length === 1 ? t("rv.delete-text", {view: view(asked[0]!.targetKey), n: asked[0]!.total})
      : t("rv.delete-all-text", {n: asked.length})}</p></Dialog>}
  </div>;
}

/** Where the agent stands: answers waiting for you, else when the comments were sent, else nothing. */
function agentWords(t: T, row: ReviewSummary, when: (at: number) => string) {
  if (row.agent.answered > 0) return <span className="git-reviews-yours">{t("rv.answers", {n: row.agent.answered})}</span>;
  if (row.agent.sentAt !== null) return <span>{t("rv.sent", {when: when(row.agent.sentAt)})}{row.agent.waiting > 0 ? " · " + t("rv.no-answer", {n: row.agent.waiting}) : ""}</span>;
  return <span className="g-muted"><span aria-hidden="true">—</span><span className="g-sr">{t("rv.not-sent")}</span></span>;
}

function AiWords({t, ai}: {t: T; ai: ReviewSummary["ai"]}) {
  if (!ai) return <span className="g-muted">{t("rv.ai.none")}</span>;
  // A run closed before it finished is no success: it shows plain, with what it found by then.
  const state = ai.status === "running" ? "running" : ai.status === "failed" ? "failure" : ai.status === "closed" ? "cancelled" : "success";
  const mark = {running: "Loading", failure: "CircleX", cancelled: "Circle", success: "CircleCheck"}[state];
  const extra = ai.status === "running" ? (ai.model ? " · " + ai.model : "") : ai.status === "failed" ? "" : " · " + t("rv.findings", {n: ai.findings});
  return <span className="git-ci-st" data-state={state}><Icon name={mark} small/>{t(("rv.ai." + ai.status) as "rv.ai.done") + extra}</span>;
}
