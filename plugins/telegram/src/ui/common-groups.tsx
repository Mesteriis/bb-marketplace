import { useTelegramLocale } from "./i18n/index.tsx";
import { useState } from "react";
import type { CommonGroupPage } from "../core/contract.ts";
import type { Chat } from "../core/demo.ts";

export type CommonGroupLoader = (id: string, after?: string) => Promise<CommonGroupPage>;

export function CommonGroups({ id, load, onOpen }: { id: string; load: CommonGroupLoader; onOpen: (chat: Chat) => void }) {
  const { t: tr } = useTelegramLocale();
  const [page, setPage] = useState<CommonGroupPage>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  async function browse(after?: string) {
    if (busy) return;
    setBusy(true);
    setError(false);
    try {
      const next = await load(id, after);
      setPage((previous) => {
        if (!previous || !after) return next;
        const known = new Set(previous.chats.map((chat) => chat.id));
        return { chats: [...previous.chats, ...next.chats.filter((chat) => !known.has(chat.id))],
          next: next.next === after ? null : next.next };
      });
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  const next = page?.next;
  return <section aria-label={tr("Groups in common")}>
    <button type="button" className="mtg-action" aria-expanded={page !== undefined} disabled={busy}
      onClick={() => {
        if (page) {
          setPage(undefined);
          setError(false);
        } else void browse();
      }}>{tr("Groups in common")}</button>
    {busy && <p role="status">{tr("Loading groups in common…")}</p>}
    {error && <p role="alert">{tr("Could not load groups in common.")}</p>}
    {page && !page.chats.length && !next && <p>{tr("No groups in common.")}</p>}
    {!!page?.chats.length && <ul>{page.chats.map((chat) => <li key={chat.id}>
      <button type="button" className="mtg-action" onClick={() => onOpen(chat)}><bdi>{chat.name}</bdi></button>
    </li>)}</ul>}
    {next && <button type="button" className="mtg-action" disabled={busy}
      onClick={() => void browse(next)}>{tr("More groups in common")}</button>}
  </section>;
}
