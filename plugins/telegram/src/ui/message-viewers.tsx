import { Users } from "lucide-react";
import { useId, useState } from "react";
import type { MessageViewer } from "../core/contract.ts";

export type MessageViewerLoader = (chatId: string, messageId: string) => Promise<MessageViewer[] | null>;

export function MessageViewers({ chatId, messageId, load }: {
  chatId: string;
  messageId: string;
  load: MessageViewerLoader;
}) {
  const panel = useId();
  const [viewers, setViewers] = useState<MessageViewer[] | null>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const expanded = busy || error || viewers !== undefined;

  async function toggle() {
    if (busy) return;
    if (expanded) {
      setError(false);
      setViewers(undefined);
      return;
    }
    setBusy(true);
    try {
      setViewers(await load(chatId, messageId));
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  return <div className="mtg-message-viewers">
    <button type="button" className="mtg-reply-action" title="Who viewed this message"
      aria-label="Who viewed this message" aria-expanded={expanded} aria-controls={panel}
      disabled={busy} onClick={() => void toggle()}><Users size={15} aria-hidden="true" /></button>
    <div id={panel} className="mtg-message-viewers-list" hidden={!expanded}>
      {busy && <p role="status">Loading message viewers…</p>}
      {error && <p role="alert">Could not load message viewers.</p>}
      {viewers === null && <p role="status">Telegram does not provide a viewer list for this message.</p>}
      {viewers?.length === 0 && <p role="status">No recorded viewers yet.</p>}
      {!!viewers?.length && <ul aria-label="Message viewers">
        {viewers.map(({ id, name, viewedAt }) => {
          const date = viewedAt ? new Date(viewedAt * 1000) : undefined;
          return <li key={id}>{name}{date && <> · <time dateTime={date.toISOString()}>{date.toLocaleString()}</time></>}</li>;
        })}
      </ul>}
    </div>
  </div>;
}
