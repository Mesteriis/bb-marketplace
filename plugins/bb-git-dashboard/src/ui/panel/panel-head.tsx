import { useCallback, useState, type ReactNode } from "react";
import type { GitAction, GitResult } from "../../core/git.ts";
import type { Copy } from "../../core/workspace.ts";
import { useT } from "../i18n/use-t.tsx";
import { PushDialog } from "../project/project-head.tsx";
import { Icon } from "../system/icon.tsx";

type RunGit = (action: GitAction) => Promise<GitResult>;
const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);

/**
 * The head of the Git panel: the copy's name and forge, Pull and Push (Push asks first, in the same dialog as the copy's
 * page), and under them the branch, where it goes (the pull request's base, else its upstream) and how far apart.
 */
export function PanelHead({copy, state, forge, base, run, onChanged, note}: {copy: Copy; state: GitResult | null; forge: string | null;
  /** The pull request's base branch, when the branch has one. */
  base: string | null;
  run: RunGit; onChanged(): void;
  /** A line over the head (a pinned copy says it is not this thread's). */
  note?: ReactNode}) {
  const t = useT();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [push, setPush] = useState<{head: string; branch: string; origin: string} | null>(null);
  const act = useCallback(async (action: GitAction, quiet = false) => {
    setPending(true); setError("");
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
      if (origin.text) setPush({head, branch, origin: origin.text}); else setError("NO_ORIGIN");
    } catch (cause) { setError(message(cause)); }
  };
  const name = copy.repositoryName ?? copy.root.split(/[\\/]/).pop() ?? copy.root;
  const ahead = state?.ahead ?? 0, behind = state?.behind ?? 0;
  const target = base ?? state?.upstream ?? null;
  return <header className="git-panel-head">
    {note}
    <div className="git-panel-title">
      <h2 title={copy.root}>{name}</h2>
      {forge && <span className="g-chip line">{forge}</span>}
      <span className="git-panel-actions">
        <button type="button" className="g-btn sm" disabled={pending || !state?.upstream} title={state?.upstream ? t("pg.pull-hint", {upstream: state.upstream}) : t("pg.no-pull")}
          onClick={() => void act({kind: "fastForward"}).catch(() => {})}><Icon name="ArrowDown" small/>{t("pg.pull")}</button>
        <button type="button" className="g-btn pri sm" disabled={pending || !state?.head || !state.branch} onClick={() => void askPush()}>
          <Icon name="ArrowUp" small/>{t("pg.push")}{ahead ? " " + ahead : ""}</button>
      </span>
    </div>
    <div className="git-panel-branch">
      <Icon name="GitBranch" small/>
      {state ? <>
        <span className="g-branch" title={state.branch ?? undefined}>{state.branch ?? t("pg.detached")}</span>
        {target && <><Icon name="ArrowRight" small/><span className="g-branch" title={target}>{target}</span></>}
        <span className="g-num g-muted git-panel-sync">{state.upstream && state.ahead !== undefined ? <>↑{ahead} <span className={behind ? "g-warn" : undefined}>↓{behind}</span></>
          : t("pg.no-upstream")}</span>
      </> : <span className="g-muted" role="status">{t("pg.reading")}</span>}
    </div>
    {error && <p className="g-bad git-panel-error" role="alert">{error}</p>}
    {push && <PushDialog {...push} ahead={ahead} onConfirm={() => act({kind: "push", expected: push.head, branch: push.branch, destination: push.origin}, true)}
      onClose={() => setPush(null)}/>}
  </header>;
}
