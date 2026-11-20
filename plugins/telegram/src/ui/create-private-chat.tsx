import { useTelegramLocale } from "./i18n/index.tsx";
import { Plus } from "lucide-react";
import { useRef, useState, type FormEvent } from "react";
import type { Chat } from "../core/demo.ts";

export type CreatePrivateChat = (title: string, kind: "Group" | "Channel") => Promise<Chat>;

export function CreatePrivateChatDialog({ create, onCreated }: {
  create: CreatePrivateChat;
  onCreated: (chat: Chat) => void;
}) {
  const { t: tr } = useTelegramLocale();
  const dialog = useRef<HTMLDialogElement>(null);
  const [kind, setKind] = useState<"Group" | "Channel">("Group");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = title.trim();
    if (!name || name.length > 128 || busy) return;
    setBusy(true);
    setError(false);
    try {
      const chat = await create(name, kind);
      dialog.current?.close();
      onCreated(chat);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  return <>
    <button type="button" className="mtg-action" aria-label={tr("New group or channel")} title={tr("New group or channel")} aria-haspopup="dialog"
      onClick={() => {
        setKind("Group");
        setTitle("");
        setError(false);
        dialog.current?.showModal();
      }}><Plus size={18} aria-hidden="true" /></button>
    <dialog ref={dialog} className="mtg-agent-settings mtg-chat-details" aria-label={tr("Create a private chat")}
      onCancel={(event) => { if (busy) event.preventDefault(); }}>
      <form onSubmit={(event) => void submit(event)}>
        <label>{tr("Chat type ")}<select value={kind} disabled={busy}
          onChange={(event) => setKind(event.currentTarget.value === "Channel" ? "Channel" : "Group")}>
          <option value="Group">{tr("Private group")}</option>
          <option value="Channel">{tr("Private channel")}</option>
        </select></label>
        <label>{tr("Name ")}<input autoFocus required maxLength={128} value={title} disabled={busy}
          onChange={(event) => setTitle(event.currentTarget.value)} /></label>
        {error && <p role="alert">{tr("Telegram did not confirm creation. Check the chat list before retrying.")}</p>}
        <button type="button" className="mtg-action" disabled={busy} onClick={() => dialog.current?.close()}>{tr("Cancel")}</button>
        <button type="submit" className="mtg-action" disabled={busy || !title.trim()}>
          {busy ? tr("Creating…") : kind === "Group" ? tr("Create group") : tr("Create channel")}
        </button>
      </form>
    </dialog>
  </>;
}
