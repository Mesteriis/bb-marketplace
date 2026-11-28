import { useState } from "react";
import type { Preview, RemoteOutcome } from "../../core/publication.ts";
import { prepareThroughAccount, type AccountSync } from "./account-write.ts";

export { prepareThroughAccount, type AccountSync };
const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
import { useT } from "../i18n/use-t.tsx";
import { Dialog } from "../system/dialog.tsx";

/**
 * What the server will do through the account, line by line; Confirm runs it once and says how it ended. The server
 * spends the preview on that one try: after a failure only Close is left, and a new try asks for a new preview.
 * An outcome the server could not learn ("unknown") is passed on as done-or-not, never as not done.
 */
export function AccountConfirm({title, preview, sync, onDone, onClose}: {title: string; preview: Preview; sync: AccountSync;
  onDone(outcome: RemoteOutcome): void; onClose(): void}) {
  const t = useT();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [spent, setSpent] = useState(false);
  const confirm = async () => {
    if (spent) return;
    setSpent(true);
    setPending(true);
    setError("");
    try {
      const outcome = await sync.publish(preview.id);
      if (outcome.status === "failed") setError(t("pg.account-failed", {code: outcome.code ?? outcome.status}));
      else onDone(outcome);
    } catch (cause) { setError(message(cause)); }
    finally { setPending(false); }
  };
  return <Dialog title={title} busy={pending} wide onClose={onClose} actions={<>
    <button type="button" className="g-btn" disabled={pending} onClick={onClose}>{spent ? t("pg.account-close") : t("common.cancel")}</button>
    {!spent || pending ? <button type="button" className="g-btn pri" disabled={pending} onClick={() => void confirm()}>{pending ? t("pg.account-working") : t("pg.account-confirm")}</button> : null}
  </>}>
    <p className="g-muted">{t("pg.account-what")}</p>
    <ul className="git-account-lines">{preview.lines.map((line, index) => <li key={index} className="g-mono">{line}</li>)}</ul>
    {error && <p className="g-banner bad git-account-error" role="alert">{error}{spent ? " " + t("pg.account-again") : ""}</p>}
  </Dialog>;
}

/** A pull request from the copy's branch: base, title and description, then the server's preview before anything is sent. */
export function CreatePullDialog({branch, head, base: initialBase, sync, onPrepared, onClose}: {branch: string; head: string; sync: AccountSync;
  /** The base to start from: the branch the upstream tracks on origin, else main. */
  base: string;
  onPrepared(preview: Preview): void; onClose(): void}) {
  const t = useT();
  const [base, setBase] = useState(initialBase);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const ready = base.trim() && title.trim() && base.trim() !== branch;
  const submit = async () => {
    if (!ready) return;
    setPending(true);
    setError("");
    try { onPrepared(await prepareThroughAccount(sync, {kind: "pull", action: {kind: "create", head: branch, expected: head, base: base.trim(), title: title.trim(), body}})); }
    catch (cause) { setError(explain(message(cause), t)); }
    finally { setPending(false); }
  };
  return <Dialog title={t("pg.create-pr")} busy={pending} wide onClose={onClose} actions={<>
    <button type="button" className="g-btn" disabled={pending} onClick={onClose}>{t("common.cancel")}</button>
    <button type="button" className="g-btn pri" disabled={pending || !ready} onClick={() => void submit()}>{t("pg.create-pr-next")}</button>
  </>}>
    <form className="git-account-form" onSubmit={event => { event.preventDefault(); void submit(); }}>
      <p className="git-push-where"><span className="g-branch">{branch}</span> → <span className="g-branch">{base || "…"}</span></p>
      <label>{t("pg.pr-base")}<input className="g-inp" value={base} onChange={event => setBase(event.target.value)} maxLength={250}/></label>
      <label>{t("pg.pr-title")}<input className="g-inp" value={title} onChange={event => setTitle(event.target.value)} maxLength={220} autoFocus/></label>
      <label>{t("pg.pr-body")}<textarea className="g-inp" value={body} onChange={event => setBody(event.target.value)} maxLength={8000} rows={5}/></label>
    </form>
    {error && <p className="g-banner bad" role="alert">{error}</p>}
  </Dialog>;
}

/** A copy without a linked account repository is told where to link one; other codes are shown as the server gave them. */
export function explain(text: string, t: ReturnType<typeof useT>): string {
  return text.startsWith("NO_ACCOUNT_LINK") ? t("pg.account-unlinked") : text;
}
