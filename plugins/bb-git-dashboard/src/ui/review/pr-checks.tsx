import type { ComponentType, ReactNode } from "react";
import type { MessageKey } from "../../core/i18n/dictionary.ts";
import { useT } from "../i18n/use-t.tsx";
import { Icon } from "../system/icon.tsx";
import type { PrView } from "./review-api.ts";

type Check = PrView["detail"]["checks"][number];
const icons = {failing: ["CircleX", "g-bad"], pending: ["Clock", "g-warn"], passing: ["CircleCheck", "g-good"], skipped: ["MinusCircle", "g-muted"]} as const;

/**
 * Checks: how many ran on the head commit and how they went, Fix with agent for all; a table of the checks, a failed
 * one opened on its errors with the whole log and Ask an agent.
 */
export function PrChecks({view, ask, Link}: {view: PrView; ask(subject: {kind: "all"} | {kind: "check"; name: string}): void;
  Link: ComponentType<{href: string; children: ReactNode}>}) {
  const t = useT();
  const {detail} = view;
  const checks = detail.checks;
  const count = (status: Check["status"]) => checks.filter(check => check.status === status).length;
  const failing = count("failing");
  return <div className="git-pr-checks">
    <div className="git-pr-bar">
      <span>{t("pr.checks-summary", {n: checks.length, sha: (detail.headSha ?? "").slice(0, 7)})}</span>
      {count("passing") > 0 && <span className="g-chip good">{t("pr.passed", {n: count("passing")})}</span>}
      {failing > 0 && <span className="g-chip bad">{t("pr.failed", {n: failing})}</span>}
      {count("pending") > 0 && <span className="g-chip line">{t("pr.running", {n: count("pending")})}</span>}
      {failing > 0 && detail.state === "OPEN" && <button type="button" className="g-btn pri git-pr-bar-end" onClick={() => ask({kind: "all"})}><Icon name="Bot" small/>{t("pr.fix-agent")}</button>}
    </div>
    {checks.length === 0 ? <p className="g-state-page">{t("pr.no-checks")}</p> : <table className="g-table two">
      <thead><tr><th>{t("pr.col.check")}</th><th>{t("pr.col.status")}</th><th>{t("pr.col.result")}</th><th><span className="g-sr">{t("br.col.actions")}</span></th></tr></thead>
      <tbody>{checks.map(check => {
        const [icon, tone] = icons[check.status];
        const name = (check.workflow ? check.workflow + " / " : "") + check.name;
        return [<tr key={name} data-status={check.status}>
          <td><span className="git-pr-check"><span className={tone}><Icon name={icon} small/></span><strong>{name}</strong></span></td>
          <td className={check.status === "failing" ? "g-bad" : undefined}>{t(("pr.cs." + check.status) as MessageKey)}</td>
          <td className="g-muted git-pr-check-title">{check.title ?? "—"}</td>
          <td className="git-branches-actions">
            {check.url && <Link href={check.url}>{t(check.status === "failing" ? "pr.b.log" : "pr.details")}</Link>}
          </td>
        </tr>,
        check.status === "failing" ? <tr key={name + ":errors"} className="git-pr-check-errors"><td colSpan={4}>
          <section aria-label={t("pr.annotations", {name})}>
            {check.annotations.length > 0 ? <pre className="git-changes-plain git-pr-annotations">{check.annotations.slice(0, 20).map((note, index) =>
              <span key={index} className="git-pr-annotation">{note.path}{note.line ? ":" + note.line : ""}  {note.message}{"\n"}</span>)}</pre>
              : check.summary ? <pre className="git-changes-plain git-pr-annotations">{check.summary}</pre> : <p className="g-muted">{t("pr.no-errors")}</p>}
            <div className="git-pr-form-row">
              {check.url && <Link href={check.url}>{t("pr.open-log")}</Link>}
              {detail.state === "OPEN" && <button type="button" className="g-btn sm" onClick={() => ask({kind: "check", name: check.name})}><Icon name="Bot" small/>{t("pr.fix-agent")}</button>}
            </div>
          </section>
        </td></tr> : null];
      })}</tbody>
    </table>}
  </div>;
}
