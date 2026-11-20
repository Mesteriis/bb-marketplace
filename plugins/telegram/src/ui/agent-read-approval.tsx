import { useTelegramLocale } from "./i18n/index.tsx";
import { useEffect, useState } from "react";
import { ApprovalCountdown } from "./approval-countdown.tsx";
import { readPayload, type ReadDecision } from "../core/agent-read.ts";

export function AgentReadApproval({ payload, expiresAt, submit, cancel, load }: {
  payload: unknown;
  expiresAt?: number | null;
  submit: (value: ReadDecision) => Promise<void>;
  cancel: () => Promise<void>;
  load: (requestId: string, id: string) => Promise<string>;
}) {
  const { locale: uiLocale, t: tr } = useTelegramLocale();
  const parsed = readPayload.safeParse(payload);
  const [id, setId] = useState("");
  const [approved, setApproved] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [preview, setPreview] = useState<{ id: string; text?: string }>();
  const limit = parsed.success ? parsed.data.maxMessages ?? 1 : 1;
  const batch = limit > 1;
  const consent = approved.has(id);
  const requestId = parsed.success ? parsed.data.requestId : undefined;
  const exact = preview?.id === id ? preview : undefined;
  useEffect(() => {
    if (!requestId || !id) return;
    let alive = true;
    void load(requestId, id).then(
      (text) => { if (alive) setPreview({ id, text }); },
      () => { if (alive) setPreview({ id }); },
    );
    return () => { alive = false; };
  }, [requestId, id, load]);
  const note = parsed.success ? parsed.data.notes.find((item) => item.id === id) : undefined;

  async function settle(action: () => Promise<void>) {
    setBusy(true);
    setFailed(false);
    try { await action(); }
    catch { setFailed(true); setBusy(false); }
  }

  return <section lang={uiLocale} data-bb-ru-skip className="mtg-agent-approval" aria-label={tr("Telegram note sharing")}>
    <strong>{batch ? tr("Share original Telegram messages") : tr("Share an original Telegram message")}</strong>
    <p>{batch ? tr("Each approved message will be sent to this BB thread’s model provider.") : tr("The selected text will be sent to this BB thread’s model provider.")}</p>
    {parsed.success ? <>
      {parsed.data.source && <p>{tr("From: ")}<bdi>{parsed.data.source}</bdi></p>}
      <label>{tr("Message ")}<select value={id} onChange={(event) => { setId(event.target.value); if (!batch) setApproved(new Set()); setPreview(undefined); }} disabled={busy}>
        <option value="">{tr("Choose a note")}</option>
        {parsed.data.notes.map((item, index) => <option value={item.id} key={item.id}>{item.time || tr("Note {0}", [index + 1])}{batch && approved.has(item.id) ? tr(" · Approved") : ""}</option>)}
      </select></label>
      {note && !exact && <p role="status">{tr("Loading selected message…")}</p>}
      {note && exact && exact.text === undefined && <p role="alert">{tr("This message preview is unavailable.")}</p>}
      {note && exact?.text !== undefined && <>
        <p className="mtg-agent-text">{exact.text}</p>
        <label className="mtg-agent-consent"><input type="checkbox" checked={consent} disabled={busy || (!consent && approved.size >= limit)}
          onChange={(event) => {
            const checked = event.currentTarget.checked;
            setApproved((previous) => {
              const next = new Set(previous);
              if (checked && next.size < limit) next.add(id);
              if (!checked) next.delete(id);
              return next;
            });
          }} />{tr("I wrote this text and agree to share it with this agent.")}</label>
      </>}
    </> : <p role="alert">{tr("This approval request is invalid.")}</p>}
    {expiresAt != null && <ApprovalCountdown expiresAt={expiresAt} />}
    {failed && <p role="alert">{tr("BB could not submit the decision. Try again.")}</p>}
    <div>
      <button type="button" className="mtg-action" disabled={busy} onClick={() => void settle(cancel)}>{tr("Cancel")}</button>
      <button type="button" className="mtg-action" data-variant="primary" disabled={busy || (batch
        ? !approved.size : !note || exact?.text === undefined || !consent)} onClick={() => {
        if (batch) {
          if (approved.size) void settle(() => submit({ entries: [...approved].map((id) => ({ id, authorConsent: true })) }));
        } else if (note && exact?.text !== undefined && consent) {
          void settle(() => submit({ id: note.id, authorConsent: true }));
        }
      }}>{batch ? tr("Approve {0}", [approved.size]) : tr("Approve")}</button>
    </div>
  </section>;
}
