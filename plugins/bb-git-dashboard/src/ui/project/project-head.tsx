import { useCallback, useEffect, useRef, useState } from "react";
import type { GitAction, GitResult } from "../../core/git.ts";
import type { Copy } from "../../core/workspace.ts";
import { useT } from "../i18n/use-t.tsx";
import { useModal } from "../system/dialog.tsx";
import { Icon } from "../system/icon.tsx";
import "./project.css";

type RunGit = (action: GitAction) => Promise<GitResult>;
const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);

/** The head of a copy's page: its name, branch and sync, and Fetch, Pull and Push — Push asks first, in a dialog. */
export function ProjectHead({copy, run, refresh, onChanged}: {copy: Copy; run: RunGit; refresh: number;
  /** A head action changed the copy: the page reads it again. */
  onChanged(): void}) {
  const t = useT();
  const [state, setState] = useState<GitResult | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [push, setPush] = useState<{head: string; branch: string; origin: string} | null>(null);
  useEffect(() => {
    let active = true;
    run({kind: "status"}).then(value => { if (active) setState(value); }, cause => { if (active) setError(message(cause)); });
    return () => { active = false; };
  }, [run, refresh]);
  // `quiet`: the caller shows the failure itself (the push dialog), so the head does not say it twice.
  const act = useCallback(async (action: GitAction, quiet = false) => {
    setPending(true);
    setError("");
    try { await run(action); onChanged(); }
    catch (cause) { if (!quiet) setError(message(cause)); throw cause; }
    finally { setPending(false); }
  }, [run, onChanged]);
  const askPush = async () => {
    if (!state?.head || !state.branch) return;
    const {head, branch} = state;
    setError("");
    try {
      const origin = await run({kind: "localOrigin"});
      if (origin.text) setPush({head, branch, origin: origin.text});
      else setError("NO_ORIGIN");
    } catch (cause) { setError(message(cause)); }
  };
  const name = copy.repositoryName ?? copy.root.split(/[\\/]/).pop() ?? copy.root;
  const ahead = state?.ahead ?? 0, behind = state?.behind ?? 0;
  return <header className="g-head git-project-head">
    <h1>{name}</h1>
    {state ? <>
      <span className="g-branch" title={state.upstream ?? undefined}>{state.branch ?? t("pg.detached")}</span>
      <span className="g-num g-muted" title={state.upstream ? t("pg.sync", {ahead, behind}) : undefined}>
        {!state.upstream ? t("pg.no-upstream") : state.ahead === undefined ? t("pg.no-sync")
          : <>↑{ahead} <span className={behind ? "g-warn" : undefined}>↓{behind}</span></>}</span>
    </> : <span className="g-muted" role="status">{t("pg.reading")}</span>}
    <div className="g-actions">
      <button type="button" className="g-btn" disabled={pending || !state} onClick={() => void act({kind: "fetch"}).catch(() => {})}>
        <Icon name="RotateCcw" small/>{t("pg.fetch")}</button>
      <button type="button" className="g-btn" disabled={pending || !state?.upstream} title={state?.upstream ? t("pg.pull-hint", {upstream: state.upstream}) : t("pg.no-pull")}
        onClick={() => void act({kind: "fastForward"}).catch(() => {})}><Icon name="ArrowDown" small/>{t("pg.pull")}</button>
      <button type="button" className="g-btn pri" disabled={pending || !state?.head || !state.branch} onClick={() => void askPush()}>
        <Icon name="ArrowUp" small/>{t("pg.push")}{ahead ? " " + ahead : ""}</button>
    </div>
    {error && <p className="git-project-head-error g-bad" role="alert">{error}</p>}
    {push && <PushDialog {...push} onConfirm={() => act({kind: "push", expected: push.head, branch: push.branch, destination: push.origin}, true)}
      onClose={() => setPush(null)}/>}
  </header>;
}

function PushDialog({head, branch, origin, onConfirm, onClose}: {head: string; branch: string; origin: string; onConfirm(): Promise<void>; onClose(): void}) {
  const t = useT();
  const dialog = useRef<HTMLDialogElement>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  useModal(dialog);
  const confirm = async () => {
    setPending(true);
    setError("");
    try { await onConfirm(); onClose(); }
    catch (cause) { setError(message(cause)); setPending(false); }
  };
  return <dialog ref={dialog} className="git-ci-dialog" aria-labelledby="git-push-title" onCancel={event => { event.preventDefault(); if (!pending) onClose(); }}>
    <div className="git-stack">
      <h2 id="git-push-title">{t("pg.push-title")}</h2>
      <p className="g-mono">{t("pg.push-line", {sha: head.slice(0, 12), origin, branch})}</p>
      {error && <p className="git-error" role="alert">{error}</p>}
      <div className="git-row git-ci-dialog-actions">
        <button type="button" className="g-btn" disabled={pending} onClick={onClose}>{t("common.cancel")}</button>
        <button type="button" className="g-btn pri" disabled={pending} onClick={() => void confirm()}>{pending ? t("pg.push-working") : t("pg.push")}</button>
      </div>
    </div>
  </dialog>;
}
