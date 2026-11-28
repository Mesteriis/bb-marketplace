import { useEffect, useState } from "react";
import { describeLocation, type ReviewThread } from "../../core/code-review/model.ts";
import { ExecutionChoice, useRunDefaults } from "./ai-runs.tsx";
import { message, type CodeReviewApi } from "./review-api.ts";
import type { MessageKey } from "../../core/i18n/dictionary.ts";
import { useT } from "../i18n/use-t.tsx";

/**
 * Sends open comment threads to a thread working on this copy: the current thread in a thread's tab, or one picked
 * from the copy's threads; or "Fix in a new thread", an AI run on this copy. Threads still waiting for an answer
 * start unticked.
 */
export function SendForm({api, copyId, sessionId, threads, currentThreadId, onClose, onSent}: {
  api: CodeReviewApi; copyId: string; sessionId: string; threads: ReviewThread[]; currentThreadId?: string; onClose(): void; onSent(text: string): void;
}) {
  const t = useT();
  const open = threads.filter(thread => thread.status === "open");
  const [chosen, setChosen] = useState<string[]>(() => open.filter(thread => thread.delivery?.state !== "sent").map(thread => thread.id));
  const [note, setNote] = useState("");
  const [targets, setTargets] = useState<{id: string; title: string}[]>();
  const [target, setTarget] = useState(currentThreadId ?? "");
  const [pending, setPending] = useState(false);
  const [fresh, setFresh] = useState(false);
  const run = useRunDefaults(api, copyId, currentThreadId ?? null, fresh);
  const [error, setError] = useState("");
  useEffect(() => {
    if (currentThreadId) return;
    let active = true;
    api.targets(copyId).then(rows => { if (active) { setTargets(rows); setTarget(current => current || rows[0]?.id || ""); } },
      cause => { if (active) setError(message(cause)); });
    return () => { active = false; };
  }, [api, copyId, currentThreadId]);
  const toggle = (id: string) => setChosen(value => value.includes(id) ? value.filter(item => item !== id) : [...value, id]);
  const send = async () => {
    setPending(true); setError("");
    try {
      if (fresh) {
        if (!run.execution) return;
        const {run: started, count} = await api.fix(sessionId, chosen, note, run.execution, currentThreadId ?? null);
        onSent(started.status !== "running" ? started.summary ?? t("ai.closed-early") : t("send.sent-new", {n: count}));
      } else {
        const {count} = await api.send(sessionId, target, chosen, note);
        onSent(t("send.sent", {n: count}));
      }
    } catch (cause) { setError(message(cause)); }
    finally { setPending(false); }
  };
  return <fieldset className="git-ci-threads git-cr-send" aria-label={t("cr.send")}>
    <legend>{t("cr.send")}</legend>
    {!open.length && <p className="g-muted">{t("send.none")}</p>}
    <div className="git-ci-thread-list">{open.map(thread => <label key={thread.id}>
      <input type="checkbox" checked={chosen.includes(thread.id)} onChange={() => toggle(thread.id)}/>{" "}
      {describeLocation(thread)}{thread.severity ? " · " + t(("cr.sev." + thread.severity) as MessageKey) : ""}
      <span className="g-muted"> — {thread.comments.at(-1)?.body.split("\n")[0]!.slice(0, 80)}</span>
      {thread.delivery?.state === "sent" && <span className="g-muted"> ({t("send.waiting")})</span>}</label>)}</div>
    <label className="git-ci-thread-note">{t("send.note")}
      <textarea className="g-inp" value={note} maxLength={20_000} onChange={event => setNote(event.target.value)}/></label>
    <div className="git-cr-send-where" role="radiogroup" aria-label={t("send.where")}>
      <label><input type="radio" checked={!fresh} onChange={() => setFresh(false)}/> {t(currentThreadId ? "send.this" : "send.copy-thread")}</label>
      <label><input type="radio" checked={fresh} onChange={() => setFresh(true)}/> {t("send.fresh")}</label>
    </div>
    {fresh ? <ExecutionChoice api={api} run={run} disabled={pending}/> : currentThreadId ? <p className="g-muted">{t("send.to-this")}</p> : <label>{t("send.to")}{" "}
      <select className="g-inp" value={target} onChange={event => setTarget(event.target.value)} disabled={!targets?.length}>
        {targets?.map(row => <option key={row.id} value={row.id}>{row.title}</option>)}
      </select>
      {targets && !targets.length && <span className="g-muted"> {t("send.no-thread")}</span>}
    </label>}
    <div className="git-cr-send-actions">
      <button type="button" className="g-btn pri" disabled={pending || !chosen.length || (fresh ? !run.execution : !target)} onClick={() => void send()}>{pending ? t("send.sending") : t("send.n", {n: chosen.length})}</button>
      <button type="button" className="g-btn ghost" onClick={onClose}>{t("ci.close")}</button>
    </div>
    {error && <p className="git-error" role="alert">{error}</p>}
  </fieldset>;
}
