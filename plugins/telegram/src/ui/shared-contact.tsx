import { useTelegramLocale } from "./i18n/index.tsx";
import { ContactRound } from "lucide-react";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { SharedContact } from "../core/contract.ts";
import type { Chat } from "../core/demo.ts";

export type LoadSharedContact = (chatId: string, messageId: string, userId: string) => Promise<Chat>;
export const OpenSharedContact = createContext<((chatId: string, messageId: string, userId: string, signal: AbortSignal) => Promise<void>) | undefined>(undefined);

export function SharedContactCard({ contact, chatId, messageId, actionable }: {
  contact: SharedContact;
  chatId: string;
  messageId: string;
  actionable: boolean;
}) {
  const { t: tr } = useTelegramLocale();
  const open = useContext(OpenSharedContact);
  const pending = useRef<AbortController | undefined>(undefined);
  const userId = contact.userId;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const name = [contact.firstName, contact.lastName].filter(Boolean).join(" ") || "Shared contact";
  useEffect(() => () => pending.current?.abort(), []);

  async function messageContact(userId: string) {
    if (pending.current || !open) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError(false);
    try { await open(chatId, messageId, userId, controller.signal); }
    catch { if (!controller.signal.aborted) setError(true); }
    finally {
      pending.current = undefined;
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  return <div className="mtg-shared-contact">
    <ContactRound size={18} aria-hidden="true" />
    <div>
      <strong><bdi>{name}</bdi></strong>
      {contact.phone && <p><bdi dir="ltr">{contact.phone}</bdi></p>}
      {actionable && userId && open && <button type="button" className="mtg-action" disabled={busy}
        onClick={() => void messageContact(userId)}>{tr("Open contact chat")}</button>}
      {error && <p role="alert">{tr("Could not open this contact’s chat.")}</p>}
    </div>
  </div>;
}
