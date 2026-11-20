import { useTelegramLocale } from "./i18n/index.tsx";
import { useEffect, useId, useRef, useState } from "react";
import type { ChatReportResult, ChatReportStep } from "../core/contract.ts";

export type ChatReportActions = {
  available?(id: string): Promise<boolean>;
  report(id: string, name: string, step: ChatReportStep, messageIds?: string[]): Promise<ChatReportResult>;
};

export function ChatReport({ id, name, actions, messageIds, close, story = false }: {
  id: string; name: string; actions: ChatReportActions; messageIds?: string[]; close?: () => void; story?: boolean;
}) {
  const { t: tr } = useTelegramLocale();
  const [available, setAvailable] = useState(false);
  const [stage, setStage] = useState<ChatReportResult | "confirm" | undefined>(messageIds || story ? "confirm" : undefined);
  const [busy, setBusy] = useState(false);
  const [option, setOption] = useState("");
  const [text, setText] = useState("");
  const heading = useId();
  const inFlight = useRef(false);

  useEffect(() => {
    if (messageIds || story || !actions.available) return;
    let active = true;
    setAvailable(false);
    void actions.available(id).then((value) => { if (active) setAvailable(value); }, () => {});
    return () => { active = false; };
  }, [actions, id, messageIds, story]);

  async function report(step: ChatReportStep) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      setStage(await (messageIds ? actions.report(id, name, step, messageIds) : actions.report(id, name, step)));
    } catch {
      setStage({ state: "unknown" });
    } finally {
      setBusy(false);
      inFlight.current = false;
      setOption("");
      setText("");
    }
  }

  if (!stage) return available ? <button type="button" className="mtg-action"
    onClick={() => setStage("confirm")}>{tr("Report chat")}</button> : null;

  const status = stage === "confirm" || stage.state === "options" || stage.state === "details" ? undefined : {
    sent: "Report sent to Telegram.",
    unknown: "Telegram did not confirm the report.",
    unavailable: story ? "Telegram could not accept the report for this story." : messageIds ? "Telegram could not accept the report for these messages." : "Telegram could not accept the report for this chat.",
    messagesRequired: "Telegram requires specific messages for this report. Use Select messages in the conversation.",
  }[stage.state];
  if (status) return <div className="mtg-composer-media">
    <p role="status">{tr(status)}</p>
    {close && <button type="button" className="mtg-action" onClick={close}>{tr("Done")}</button>}
  </div>;

  return <form className="mtg-composer-media" aria-labelledby={heading} onSubmit={(event) => {
    event.preventDefault();
    if (stage === "confirm") void report({ action: "start" });
    else if (stage.state === "options" && stage.options.some(({ id }) => id === option)) {
      void report({ action: "choose", option });
    } else if (stage.state === "details" && (stage.optional || text.trim())) {
      void report({ action: "details", option: stage.id, text: text.trim() });
    }
  }}>
    <p id={heading}>{messageIds ? tr("Report {0} selected {1} in ", [messageIds.length, messageIds.length === 1 ? "message" : "messages"]) : tr("Report ")}<bdi>{name}</bdi>{tr(" to Telegram moderators")}</p>
    {stage !== "confirm" && stage.state === "options" && <label>{stage.title || tr("Reason")}
      <select value={option} disabled={busy} onChange={(event) => setOption(event.currentTarget.value)}>
        <option value="">{tr("Choose a reason")}</option>
        {stage.options.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}
      </select>
    </label>}
    {stage !== "confirm" && stage.state === "details" && <label>{tr("Additional details")}{stage.optional ? tr(" (optional)") : ""}
      <textarea value={text} disabled={busy} maxLength={1024} onChange={(event) => setText(event.currentTarget.value)} />
    </label>}
    <button type="submit" className="mtg-action"
      disabled={busy || (stage !== "confirm" && (stage.state === "options" ? !option : stage.state === "details" && !stage.optional && !text.trim()))}>
      {busy ? tr("Waiting for Telegram…") : story && stage === "confirm" ? tr("Choose report reason")
        : story && stage !== "confirm" && stage.state === "options" ? tr("Submit selected reason")
        : stage === "confirm" || stage.state === "details" ? tr("Submit report") : tr("Continue report")}
    </button>
    <button type="button" className="mtg-action" disabled={busy} onClick={() => {
      setOption("");
      setText("");
      if (close) close();
      else setStage(undefined);
    }}>{tr("Cancel")}</button>
  </form>;
}
