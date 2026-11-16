import { ChartNoAxesColumn } from "lucide-react";
import { useState, type FormEvent } from "react";
import { pollDraft, type ForumTopicTarget, type PollSendResult, type PollSender } from "../core/contract.ts";

export function PollComposer({ chatId, topic, send }: { chatId: string; topic?: ForumTopicTarget; send: PollSender }) {
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState(["", ""]);
  const [multiple, setMultiple] = useState(false);
  const [status, setStatus] = useState<PollSendResult["state"] | "sending">();
  const parsed = pollDraft.safeParse({ question, options, multiple });
  const busy = status === "sending";

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!parsed.success || busy) return;
    setStatus("sending");
    const result = await send(chatId, parsed.data, topic).catch(() => ({ state: "unknown" as const }));
    setStatus(result.state);
    if (result.state === "sent") {
      setQuestion("");
      setOptions(["", ""]);
      setMultiple(false);
      setOpen(false);
    }
  }

  return <>
    {!open && <div className="mtg-poll-compose">
      <button type="button" className="mtg-action" onClick={() => { setStatus(undefined); setOpen(true); }}>
        <ChartNoAxesColumn size={15} aria-hidden="true" /> Create poll
      </button>
      {status === "sent" && <span role="status">Poll published.</span>}
    </div>}
    {open && <form className="mtg-edit" aria-label="Create Telegram poll" onSubmit={(event) => void submit(event)}>
      <label>Question <input autoFocus value={question} maxLength={255} disabled={busy}
        onChange={(event) => setQuestion(event.currentTarget.value)} /></label>
      {options.map((option, index) => <label key={index}>Option {index + 1}
        <input value={option} maxLength={100} disabled={busy} onChange={(event) => {
          const text = event.currentTarget.value;
          setOptions((previous) => previous.map((value, i) => i === index ? text : value));
        }} />
      </label>)}
      <div>
        <button type="button" className="mtg-action" disabled={busy || options.length >= 10}
          onClick={() => setOptions((previous) => [...previous, ""])}>Add an option</button>
        <button type="button" className="mtg-action" disabled={busy || options.length <= 2}
          onClick={() => setOptions((previous) => previous.slice(0, -1))}>Remove last option</button>
      </div>
      <label><input type="checkbox" disabled={busy} checked={multiple}
        onChange={(event) => setMultiple(event.currentTarget.checked)} /> Allow multiple answers</label>
      <p>Votes are anonymous.</p>
      {status === "unavailable" && <p role="alert">This TDLib version cannot create polls from BB.</p>}
      {status === "failed" && <p role="alert">Telegram refused the poll. Your draft is still here.</p>}
      {status === "unknown" && <p role="alert">Telegram did not confirm the poll. Check the chat before retrying.</p>}
      <div>
        <button type="button" className="mtg-action" disabled={busy} onClick={() => { setOpen(false); setStatus(undefined); }}>Close poll editor</button>
        <button type="submit" className="mtg-action" disabled={busy || !parsed.success}>{busy ? "Publishing poll…" : "Publish poll"}</button>
      </div>
    </form>}
  </>;
}
