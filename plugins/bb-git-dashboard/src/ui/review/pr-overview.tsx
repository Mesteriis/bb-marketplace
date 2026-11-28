import type { PrForms } from "./pr-forms.ts";
import { en, type MessageKey } from "../../core/i18n/dictionary.ts";
import { ago } from "../../core/i18n/time.ts";
import type { PrAction } from "../../core/pulls/actions.ts";
import { splitTimeline } from "../../core/pulls/detail.ts";
import { mergeLines, type MergeLine, type Sense } from "../../core/pulls/merge-blockers.ts";
import { useLanguage, useT } from "../i18n/use-t.tsx";
import { Icon } from "../system/icon.tsx";
import { PrBody } from "./pr-text.tsx";
import type { PrView } from "./review-api.ts";

type T = ReturnType<typeof useT>;
type Act = (action: PrAction, label: string) => void;
type Tab = "Overview" | "Checks" | "Files" | "Commits" | "Comments";
const senses: Record<Sense, {icon: string; tone: string}> = {failed: {icon: "CircleX", tone: "g-bad"}, waiting: {icon: "Clock", tone: "g-warn"},
  todo: {icon: "AlertCircle", tone: "g-warn"}, ok: {icon: "CircleCheck", tone: "g-good"}};
const methods = {merge: "pr.m.merge", squash: "pr.m.squash", rebase: "pr.m.rebase"} as const;
const reviewerTone: Record<string, string> = {APPROVED: "good", CHANGES_REQUESTED: "warn", REQUESTED: "line"};

/** Two letters of a login or name, for its round mark. */
export const initials = (name: string) => name.split(/[\s._-]+/).filter(Boolean).slice(0, 2).map(part => part[0]!.toUpperCase()).join("") || "?";

function lineText(t: T, line: MergeLine): {title: string; sub: string | null} {
  switch (line.key) {
    case "ci": return {title: line.sense === "failed" ? t("pr.b.ci.failed", {name: line.failing ?? ""}) : t(line.sense === "ok" ? "pr.b.ci.ok" : "pr.b.ci.waiting"),
      sub: t("pr.b.ci.sub", {passed: line.passed, total: line.total})};
    case "review": return {title: t(("pr.b.review." + line.sense) as MessageKey), sub: t("pr.b.review.sub", {approvals: line.approvals, unanswered: line.unanswered})};
    case "conflicts": return {title: t(line.sense === "ok" ? "pr.b.conflicts.ok" : "pr.b.conflicts.failed", {base: line.base}), sub: null};
    case "draft": return {title: t("pr.b.draft"), sub: null};
    case "stacked": return {title: t("pr.b.stacked", {n: line.n}), sub: null};
  }
}

/**
 * Overview: the description and the discussion with a comment box; beside them what keeps it from merging (each line
 * leads to where it is dealt with), the reviewers, the merge, Fix all with agent, then draft and close.
 */
export function PrOverview({view, forms, form, act, ask, onTab}: {view: PrView; forms: PrForms; form(patch: Partial<PrForms>): void; act: Act; ask(): void; onTab(tab: Tab): void}) {
  const t = useT();
  const {language} = useLanguage();
  const {detail, capabilities: can, limitations} = view;
  const now = Date.now();
  const {comment, description, reviewer} = forms;
  // The forge's methods may change on a reload: the chosen one stays while the forge still offers it.
  const method = view.mergeMethods.includes(forms.method) ? forms.method : view.mergeMethods[0] ?? "merge";
  const open = detail.state === "OPEN";
  const {description: body, discussion} = splitTimeline(detail);
  const lines = mergeLines(detail);
  const waiting = lines.filter(line => line.sense !== "ok");
  const failing = detail.checks.some(check => check.status === "failing");
  const unresolved = detail.threads.some(thread => !thread.isResolved && !thread.isPending);
  return <div className="git-pr-overview">
    <div className="git-pr-main">
      <section aria-labelledby="git-pr-description">
        <h3 className="g-sec" id="git-pr-description">{t("pr.description")}</h3>
        {description === null ? <>
          {body ? <PrBody content={body.body}/> : <p className="g-muted">{t("pr.no-description")}</p>}
          {can.editBody && detail.canEdit && <button type="button" className="g-btn ghost sm" onClick={() => form({description: detail.body})}>{t("pr.edit-description")}</button>}
        </> : <form className="git-pr-form" onSubmit={event => { event.preventDefault(); act({kind: "editBody", body: description}, t("pr.edit-description")); }}>
          <textarea aria-label={t("pr.description-label")} value={description} rows={8} maxLength={60_000} onChange={event => form({description: event.target.value})}/>
          <div className="git-pr-form-row"><button type="submit" className="g-btn pri">{t("pr.save-description")}</button>
            <button type="button" className="g-btn" onClick={() => form({description: null})}>{t("pr.cancel")}</button></div>
        </form>}
      </section>
      <section aria-labelledby="git-pr-discussion">
        <h3 className="g-sec" id="git-pr-discussion">{t("pr.discussion")}</h3>
        {discussion.length === 0 && <p className="g-muted">{t("pr.no-discussion")}</p>}
        <ol className="git-pr-timeline">{discussion.map((entry, index) => <li key={entry.id || index}>
          <span className="git-pr-avatar" aria-hidden="true">{initials(entry.author)}</span>
          <div className="git-pr-entry">
            <div className="git-pr-entry-head"><span><strong>{entry.author}</strong> {("pr.did." + entry.reviewState) in en ? t(("pr.did." + entry.reviewState) as MessageKey) : entry.reviewState ? entry.reviewState.toLowerCase().replaceAll("_", " ") : t("pr.did.comment")}</span>
              <span className="g-muted" title={entry.createdAt}>{ago(language, now, entry.createdAt)}</span>
              {entry.canDelete && can.deleteComment && <button type="button" className="g-btn ghost sm" aria-label={t("pr.delete-comment", {author: entry.author})}
                onClick={() => act({kind: "deleteComment", commentId: entry.id, threadId: null, body: entry.body.slice(0, 8000)}, t("pr.delete"))}>{t("pr.delete")}</button>}</div>
            {entry.body && <PrBody content={entry.body}/>}
          </div>
        </li>)}</ol>
        {can.comment && <form className="git-pr-form" onSubmit={event => { event.preventDefault(); if (comment.trim()) act({kind: "comment", body: comment}, t("pr.comment-button")); }}>
          <textarea aria-label={t("pr.comment")} value={comment} onChange={event => form({comment: event.target.value})} rows={3} placeholder={t("pr.comment-placeholder")}/>
          <div className="git-pr-form-row"><button type="submit" className="g-btn" disabled={!comment.trim()}>{t("pr.comment-button")}</button></div>
        </form>}
      </section>
    </div>
    <aside className="git-pr-side" aria-label={t("pr.blockers")}>
      <section>
        <h3 className="g-sec">{t("pr.blockers")}</h3>
        <ul className="git-pr-blockers">{lines.map(line => {
          const sense = senses[line.sense];
          const text = lineText(t, line);
          const go: Tab | null = line.key === "ci" && line.sense !== "ok" ? "Checks" : line.key === "review" && line.sense !== "ok" ? "Comments" : null;
          return <li key={line.key}>
            <span className={sense.tone}><Icon name={sense.icon} small/></span>
            <div><strong>{text.title}</strong>{text.sub && <div className="g-muted">{text.sub}</div>}</div>
            {go && <button type="button" className="g-btn sm" onClick={() => onTab(go)}>{t(go === "Checks" ? "pr.b.log" : "pr.b.open")}</button>}
          </li>;
        })}</ul>
      </section>
      <section>
        <h3 className="g-sec">{t("pr.reviewers")}</h3>
        {detail.reviewers.length ? <ul className="git-pr-people">{detail.reviewers.map(item => <li key={item.name}>
          <span className="git-pr-avatar" aria-hidden="true">{initials(item.name)}</span><span>{item.name}</span>
          <span className={"g-chip " + (reviewerTone[item.state] ?? "line")}>{("pr.rs." + item.state) in en ? t(("pr.rs." + item.state) as MessageKey) : item.state.toLowerCase().replaceAll("_", " ")}</span>
        </li>)}</ul> : <p className="g-muted">{t("pr.no-reviewers")}</p>}
        {open && can.requestReviewer && <form className="git-pr-form-row" onSubmit={event => { event.preventDefault(); if (reviewer.trim()) act({kind: "requestReviewer", reviewer: reviewer.trim()}, t("pr.request")); }}>
          <input className="g-inp" aria-label={t("pr.reviewer")} placeholder={detail.forge === "azure" ? t("pr.reviewer-uuid") : t("pr.reviewer-login")} value={reviewer}
            onChange={event => form({reviewer: event.target.value})}/>
          <button type="submit" className="g-btn" disabled={!reviewer.trim()}>{t("pr.request")}</button></form>}
      </section>
      {open && <section>
        <h3 className="g-sec">{t("pr.merge")}</h3>
        {can.merge ? <>
          <div className="git-pr-form-row">
            <select className="g-inp" aria-label={t("pr.method")} value={method} onChange={event => form({method: event.target.value as typeof method})}>
              {view.mergeMethods.map(name => <option key={name} value={name}>{t(methods[name])}</option>)}</select>
            <button type="button" className="g-btn" onClick={() => act({kind: "merge", method}, t(methods[method]))}>{t("pr.merge-button")}</button>
          </div>
          {waiting.length > 0 && <p className="g-muted">{t("pr.merge-when", {what: waiting.map(line => t(("pr.w." + line.key) as MessageKey)).join(t("pr.and"))})}</p>}
        </> : <p className="g-muted">{t("pr.merge-no")}</p>}
        {(failing || unresolved) && <button type="button" className="g-btn pri git-pr-fix" onClick={ask}><Icon name="Bot" small/>{t("pr.fix-all")}</button>}
      </section>}
      <div className="git-pr-side-foot">
        {open && (can.draft ? <button type="button" className="g-btn" onClick={() => act({kind: "draft", draft: !detail.isDraft}, detail.isDraft ? t("pr.ready") : t("pr.to-draft"))}>
          {detail.isDraft ? t("pr.ready") : t("pr.to-draft")}</button> : limitations.draft && <span className="g-muted" title={limitations.draft}>{t("pr.draft-unsupported")}</span>)}
        {open ? <button type="button" className="g-btn ghost" onClick={() => act({kind: "state", open: false}, t("pr.close"))}>{t("pr.close")}</button>
          : detail.state === "CLOSED" && <button type="button" className="g-btn" onClick={() => act({kind: "state", open: true}, t("pr.reopen"))}>{t("pr.reopen")}</button>}
      </div>
    </aside>
  </div>;
}
