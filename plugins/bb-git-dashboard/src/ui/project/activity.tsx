import { en, type MessageKey } from "../../core/i18n/dictionary.ts";
import { ago } from "../../core/i18n/time.ts";
import type { Operation } from "../../core/workspace.ts";
import { useLanguage, useT } from "../i18n/use-t.tsx";
import { Icon } from "../system/icon.tsx";

const icons: Record<string, string> = {fetch: "RotateCcw", fastForward: "ArrowDown", push: "ArrowUp", commit: "GitMerge", merge: "GitMerge", rebase: "GitMerge",
  switch: "ArrowRight", branch: "GitPullRequestDraft", worktree: "FolderGit"};
const states = {succeeded: {icon: "CircleCheck", tone: "good"}, failed: {icon: "CircleX", tone: "bad"}, pending: {icon: "Clock", tone: ""},
  unknown: {icon: "AlertCircle", tone: "warn"}} as const;

/** What Makosh Git did on this copy: the action in words, its result as a chip, who and when (exact time in the tooltip), the commit. */
export function Activity({operations, now}: {operations: Operation[] | undefined; now: number}) {
  const t = useT();
  const {language} = useLanguage();
  if (!operations) return <p className="g-muted" role="status">{t("pg.reading-activity")}</p>;
  return <div className="git-activity">
    {operations.length ? <ol className="git-activity-list">{operations.map(operation => {
      const known = ("act.kind." + operation.kind) as MessageKey;
      const word = known in en ? t(known) : operation.kind;
      const state = states[operation.state];
      const sha = operation.after ?? operation.before;
      return <li key={operation.id}>
        <span className="git-activity-icon"><Icon name={icons[operation.kind] ?? "Workflow"} small/></span>
        <div className="git-activity-what">
          <span>{word}{sha ? <> <span className="g-mono g-muted">{sha.slice(0, 7)}</span></> : null}</span>
          <span className={"g-chip " + state.tone}><Icon name={state.icon} small/>{t(("act.state." + operation.state) as MessageKey)}</span>
          {operation.code && <span className="g-mono g-muted">{operation.code}</span>}
        </div>
        <span className="g-muted git-activity-when" title={new Date(operation.at).toLocaleString(language)}>
          {(operation.actor === "human" ? t("act.you") : t("act.agent")) + " · " + ago(language, now, operation.at)}</span>
      </li>;
    })}</ol> : <p className="g-muted">{t("pg.no-activity")}</p>}
    <p className="g-muted git-branches-note">{t("act.note")}</p>
  </div>;
}
