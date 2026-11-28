import type { PrAction } from "../../core/pulls/actions.ts";
import { useT } from "../i18n/use-t.tsx";
import { Icon } from "../system/icon.tsx";
import { FileDiff, type DraftComment } from "./diff-view.tsx";
import type { PrDetailView, PrFileView, PrView } from "./review-api.ts";

type Thread = PrDetailView["threads"][number];

/**
 * Files: how many and how much changed, unified or split, wrapped or not; the files beside their diffs, each with its
 * open comment threads, a line's comments written into your review.
 */
export function PrFiles({view, files, split, wrap, drafts, onSplit, onWrap, act, ask, onDraft, onReview}: {view: PrView; files: PrFileView[] | null;
  split: boolean; wrap: boolean; drafts: number; onSplit(split: boolean): void; onWrap(wrap: boolean): void; act(action: PrAction): void;
  ask(thread: Thread): void; onDraft(draft: DraftComment): void;
  /** Goes to Comments, where your review with its line comments is submitted. */
  onReview(): void}) {
  const t = useT();
  const {detail, capabilities: can, limitations} = view;
  const open = detail.state === "OPEN";
  const threadCan = {reply: can.reply, resolve: can.resolve, delete: can.deleteComment};
  const threadsOf = (file: PrFileView) => detail.threads.filter(thread => thread.path === file.path || (file.previousPath !== null && thread.path === file.previousPath));
  /** Scrolls a file into view and focuses it. */
  const showFile = (path: string) => {
    const section = Array.from(document.querySelectorAll<HTMLElement>(".git-pr-file-diffs > .git-review-file")).find(element => element.dataset.path === path);
    section?.scrollIntoView({block: "start"});
    section?.focus({preventScroll: true});
  };
  return <div className="git-pr-files-tab">
    <div className="git-pr-bar">
      <span>{t("pr.files-summary", {n: files?.length ?? detail.changedFiles})} · <span className="g-good">+{detail.additions}</span> <span className="g-bad">−{detail.deletions}</span></span>
      <div className="g-seg" role="group" aria-label={t("pr.diff-view")}>
        <button type="button" aria-pressed={!split} onClick={() => onSplit(false)}>{t("pr.unified")}</button>
        <button type="button" aria-pressed={split} onClick={() => onSplit(true)}>{t("pr.split")}</button>
      </div>
      <button type="button" className="g-btn ghost sm" aria-pressed={wrap} onClick={() => onWrap(!wrap)}><Icon name="TextWrap" small/>{t("pr.wrap")}</button>
      {!can.lineComment && <span className="g-muted">{limitations.lineComment}</span>}
      {drafts > 0 && <><span className="g-chip vio">{t("pr.in-review", {n: drafts})}</span>
        <button type="button" className="g-btn sm" onClick={onReview}>{t("pr.to-review")}</button></>}
      <span className="g-muted git-pr-bar-end git-inbox-keys"><kbd className="g-kbd">j</kbd> <kbd className="g-kbd">k</kbd> {t("pr.files-keys")} · <kbd className="g-kbd">n</kbd> <kbd className="g-kbd">p</kbd> {t("pr.threads-keys")}</span>
    </div>
    {!files ? <p className="g-state-page" role="status">{t("pr.loading-files")}</p> : files.length === 0 ? <p className="g-state-page">{t("pr.no-files")}</p> :
      <div className="git-pr-files">
        <nav className="git-pr-file-list" aria-label={t("pr.changed-files")}>
          {files.map(file => {
            const waiting = threadsOf(file).filter(thread => !thread.isResolved).length;
            const slash = file.path.lastIndexOf("/");
            return <button key={file.path} type="button" title={file.path} onClick={() => showFile(file.path)}>
              <span className="git-changes-path">{slash >= 0 && <span className="g-muted">{file.path.slice(0, slash + 1)}</span>}{file.path.slice(slash + 1)}</span>
              {waiting > 0 && <span className="g-chip warn" aria-label={t("pr.open-threads", {n: waiting})}>{waiting}</span>}
              <span className="g-num"><span className="g-good">+{file.additions}</span> <span className="g-bad">−{file.deletions}</span></span>
            </button>;
          })}
        </nav>
        <div className="git-pr-file-diffs">{files.map(file => <FileDiff key={file.path} file={file} wrap={wrap} split={split} canComment={open && can.lineComment} can={threadCan}
          threads={threadsOf(file)} act={act} ask={ask} onDraft={onDraft} people={{viewer: detail.viewer, author: detail.author}}/>)}</div>
      </div>}
  </div>;
}
