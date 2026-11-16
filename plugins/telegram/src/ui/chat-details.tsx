import type { MessageSearchFilter } from "../core/contract.ts";
import { Settings2 } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

const sharedCategories = [
  ["photoVideo", "Shared media"], ["document", "Shared files"], ["link", "Shared links"],
  ["audio", "Shared audio"], ["voiceVideoNotes", "Shared voice and video notes"], ["gif", "Shared GIFs"],
] as const satisfies readonly (readonly [MessageSearchFilter, string])[];

export function ChatDetails({ chatId, name, load, change, browse, children }: {
  chatId: string;
  name: string;
  load?: (id: string) => Promise<boolean>;
  change?: (id: string, enabled: boolean) => Promise<boolean>;
  browse?: (filter: MessageSearchFilter) => void;
  children?: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const [enabled, setEnabled] = useState<boolean>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open || !load) return;
    let active = true;
    void load(chatId).then(
      (value) => { if (active) setEnabled(value); },
      () => { if (active) setError("Could not load AI access."); },
    );
    return () => { active = false; };
  }, [open, chatId, load]);

  async function update(value: boolean) {
    if (!change) return;
    setBusy(true);
    setError("");
    try { setEnabled(await change(chatId, value)); }
    catch { setError("Could not change AI access."); }
    finally { setBusy(false); }
  }

  return <>
    <button type="button" className="mtg-action mtg-details-trigger" aria-haspopup="dialog"
      aria-keyshortcuts="Alt+Shift+I" title="Chat details (Alt+Shift+I)" onClick={() => {
      setEnabled(undefined);
      setError("");
      dialog.current?.showModal();
      setOpen(true);
    }}><Settings2 size={16} aria-hidden="true" /> Chat details</button>
    <dialog ref={dialog} className="mtg-agent-settings mtg-chat-details" aria-label="Chat details" onClose={() => setOpen(false)}>
      <strong><bdi>{name}</bdi></strong>
      {load && change && (enabled === undefined ? !error && <p role="status">Loading AI access…</p> : <>
        <label><input type="checkbox" checked={enabled} disabled={busy}
          onChange={(event) => void update(event.target.checked)} /> Allow AI to search and read this chat</label>
        <p>Agents can share the requested history with their model provider without a reading confirmation.</p>
      </>)}
      {error && <p role="alert">{error}</p>}
      {browse && <div className="mtg-chat-detail-actions">
        {sharedCategories.map(([filter, label]) =>
          <button key={filter} type="button" className="mtg-action" onClick={() => {
            dialog.current?.close();
            browse(filter);
          }}>{label}</button>)}
      </div>}
      {open && children && <div className="mtg-chat-detail-actions">{children}</div>}
      <button type="button" className="mtg-action" disabled={busy} onClick={() => dialog.current?.close()}>Done</button>
    </dialog>
  </>;
}
