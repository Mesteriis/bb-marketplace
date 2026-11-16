import { useEffect, useRef, useState } from "react";
import type { ContactPage } from "../core/contract.ts";
import type { Chat } from "../core/demo.ts";

export type ContactActions = {
  load: (query: string, offset?: number) => Promise<ContactPage>;
  open: (id: string) => Promise<Chat>;
};

export function ContactResults({ query, actions, select }: {
  query: string;
  actions: ContactActions;
  select: (chat: Chat) => void;
}) {
  const [page, setPage] = useState<ContactPage>();
  const [offset, setOffset] = useState<number>();
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(false);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState("");
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    let current = true;
    setLoading(true);
    setError("");
    const timer = setTimeout(() => {
      void actions.load(query, offset).then((result) => {
        if (!current) return;
        setPage((previous) => {
          if (!offset) return result;
          const rows = new Map(previous?.contacts.map((contact) => [contact.id, contact]));
          for (const contact of result.contacts) rows.set(contact.id, contact);
          return { contacts: [...rows.values()], next: result.next };
        });
      }, () => { if (current) setError("Could not load contacts."); }).finally(() => {
        if (current) setLoading(false);
      });
    }, query ? 250 : 0);
    return () => { current = false; clearTimeout(timer); };
  }, [actions, query, offset, revision]);

  async function open(id: string) {
    if (opening) return;
    setOpening(true);
    setError("");
    try {
      const chat = await actions.open(id);
      if (mounted.current) select(chat);
    } catch {
      if (mounted.current) setError("Could not open this contact.");
    } finally {
      if (mounted.current) setOpening(false);
    }
  }

  return <ul className="mtg-rows" aria-label="Telegram contacts">
    {loading && !page && <li className="mtg-empty" role="status">Loading contacts…</li>}
    {error && <li className="mtg-empty" role="alert">{error} <button type="button" className="mtg-action"
      onClick={() => setRevision((value) => value + 1)}>Refresh contacts</button></li>}
    {page && page.contacts.length === 0 && page.next === null && <li className="mtg-empty">No matching contacts.</li>}
    {page?.contacts.map(({ id, name }) => <li key={id}><button type="button" className="mtg-row"
      disabled={opening} onClick={() => void open(id)}><span className="mtg-row-body"><bdi>{name}</bdi></span></button></li>)}
    {page?.next != null && !error && <li className="mtg-history-more"><button type="button" className="mtg-action"
      disabled={loading || opening} onClick={() => setOffset(page.next!)}>Load more contacts</button></li>}
  </ul>;
}
