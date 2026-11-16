import { useEffect, useState } from "react";
import type { ChatEventPage } from "../core/contract.ts";

export type ChatEventLoader = (id: string, query: string, cursor?: string) => Promise<ChatEventPage | null>;

export function ChatEvents({ chatId, load }: { chatId: string; load: ChatEventLoader }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [request, setRequest] = useState<{ query: string; cursor?: string }>({ query: "" });
  const [page, setPage] = useState<ChatEventPage | null>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (!open) return;
    let active = true;
    setLoading(true);
    setError(false);
    void load(chatId, request.query, request.cursor).then((next) => {
      if (!active) return;
      if (request.cursor && !next) setError(true);
      else setPage((previous) => {
        if (!request.cursor || !next) return next;
        const events = new Map(previous?.events.map((event) => [event.id, event]));
        for (const event of next.events) events.set(event.id, event);
        return { events: [...events.values()], next: next.next };
      });
    }, () => { if (active) setError(true); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [chatId, load, open, request]);

  return <details onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>Recent actions</summary>
    {open && <>
      <form className="mtg-composer" onSubmit={(event) => {
        event.preventDefault();
        setPage(undefined);
        setRequest({ query: text.trim() });
      }}>
        <input type="search" maxLength={128} aria-label="Search recent actions" placeholder="Search actions"
          value={text} onChange={(event) => setText(event.target.value)} />
        <button type="submit" className="mtg-action">Find</button>
      </form>
      {loading && <p role="status">Loading recent actions…</p>}
      {error && <p role="alert">Could not load recent actions. <button type="button" className="mtg-action"
        onClick={() => setRequest({ ...request })}>Retry</button></p>}
      {page === null && <p>Recent actions are unavailable for your role or chat type.</p>}
      {page && !page.events.length && !page.next && <p>No matching recent actions.</p>}
      {!!page?.events.length && <ol aria-label="Recent Telegram actions" className="mtg-scheduled-list">
        {page.events.map((event) => <li key={event.id}>
          <bdi>{event.actor}</bdi> · {event.action}
          {event.detail && <p>{event.detail}</p>}
          <time>{new Date(event.date * 1000).toLocaleString()}</time>
        </li>)}
      </ol>}
      {page?.next && !error && <button type="button" className="mtg-action" disabled={loading}
        onClick={() => setRequest({ query: request.query, cursor: page.next! })}>Load more actions</button>}
    </>}
  </details>;
}
