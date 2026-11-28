import type { MessageKey } from "../../core/i18n/dictionary.ts";
import { ago } from "../../core/i18n/time.ts";
import { useLanguage, useT } from "../i18n/use-t.tsx";
import { Icon } from "../system/icon.tsx";
import type { PrView } from "./review-api.ts";

const ciIcons = {failing: ["CircleX", "g-bad"], pending: ["Clock", "g-warn"], passing: ["CircleCheck", "g-good"], skipped: ["Circle", "g-muted"]} as const;

/** Commits: from the base to the head, newest first: hash (copied with its button), message, author, when, CI. */
export function PrCommits({view, onCopy}: {view: PrView; onCopy(sha: string): void}) {
  const t = useT();
  const {language} = useLanguage();
  const {detail} = view;
  const now = Date.now();
  return <div className="git-pr-commits">
    <div className="git-pr-bar"><span>{t("pr.commits-summary", {n: detail.commitCount, base: detail.baseRefName, head: detail.headRefName})}</span></div>
    <table className="g-table">
      <thead><tr><th>{t("pr.col.commit")}</th><th>{t("pr.col.message")}</th><th>{t("pr.col.author")}</th><th>{t("pr.col.when")}</th><th>{t("pr.col.ci")}</th></tr></thead>
      <tbody>{detail.commits.map(commit => <tr key={commit.oid}>
        <td className="g-mono"><span className="git-pr-sha">{commit.shortOid}
          <button type="button" className="g-btn ghost sm" aria-label={t("pr.copy-sha", {sha: commit.shortOid})} onClick={() => onCopy(commit.oid)}><Icon name="Copy" small/></button></span></td>
        <td><strong>{commit.headline}</strong>{detail.myReviewOid === commit.oid && <span className="g-chip vio git-branches-chip">{t("pr.my-review")}</span>}</td>
        <td>{commit.author}</td>
        <td className="g-muted" title={commit.committedDate}>{ago(language, now, commit.committedDate)}</td>
        <td>{commit.ci ? <span className={"git-pr-check " + ciIcons[commit.ci][1]}><Icon name={ciIcons[commit.ci][0]} small/>{t(("pr.ci." + commit.ci) as MessageKey)}</span> : <span className="g-muted">—</span>}</td>
      </tr>)}</tbody>
    </table>
  </div>;
}
