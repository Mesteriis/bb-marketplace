import { useEffect, useState } from "react";
import type { GlobalSearchMode, GlobalSearchPage } from "../core/contract.ts";
import { previewMessageText } from "../core/message-spoilers.ts";

export type GlobalSearchLoader = (input: {
  query: string;
  mode: GlobalSearchMode;
  cursor?: NonNullable<GlobalSearchPage["next"]>;
}) => Promise<GlobalSearchPage>;

export function GlobalSearchResults({ query, mode, search, open }: {
  query: string;
  mode: GlobalSearchMode;
  search: GlobalSearchLoader;
  open: (hit: GlobalSearchPage["hits"][number]) => void;
}) {
  const [page, setPage] = useState<GlobalSearchPage>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const awaitingSubmit = mode === "public" && retry === 0;

  useEffect(() => {
    if (query.length < 2 || awaitingSubmit) return;
    let active = true;
    const timer = setTimeout(() => {
      void search({ query, mode }).then(
        (result) => { if (active) setPage(result); },
        () => { if (active) setError(true); },
      );
    }, 250);
    return () => { active = false; clearTimeout(timer); };
  }, [query, mode, retry, search, awaitingSubmit]);

  async function more() {
    if (!page?.next || loading) return;
    setLoading(true);
    setError(false);
    try {
      const result = await search({ query, mode, cursor: page.next });
      setPage((previous) => {
        const hits = new Map(previous?.hits.map((hit) => [`${hit.chat.id}:${hit.message.id}`, hit]));
        for (const hit of result.hits) hits.set(`${hit.chat.id}:${hit.message.id}`, hit);
        return { hits: [...hits.values()], next: result.next };
      });
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }

  return <ul className="mtg-rows" aria-label={mode === "public" ? "Public posts" : "Telegram message results"}>
    {query.length < 2 && <li className="mtg-empty">Enter at least two characters.</li>}
    {query.length >= 2 && awaitingSubmit && <li className="mtg-empty">
      <button type="button" className="mtg-action" onClick={() => setRetry(1)}>Search public posts</button>
    </li>}
    {query.length >= 2 && !awaitingSubmit && !page && !error && <li className="mtg-empty" role="status">Searching Telegram…</li>}
    {page?.hits.map((hit) => <li key={`${hit.chat.id}:${hit.message.id}`}>
      <button type="button" className="mtg-row" onClick={() => open(hit)}>
        <span className="mtg-row-body">
          <span className="mtg-row-line"><strong>{hit.chat.name}</strong><time>{hit.message.time}</time></span>
          <span className="mtg-preview">{previewMessageText(hit.message)}</span>
        </span>
      </button>
    </li>)}
    {page && !page.hits.length && !page.next && <li className="mtg-empty">No matching messages.</li>}
    {error && <li className="mtg-empty" role="alert">
      {mode === "public" ? "Free public post search is unavailable for this query. Try a hashtag." : "Could not search Telegram messages."}
      {!page && <button type="button" className="mtg-action" onClick={() => { setError(false); setRetry((value) => value + 1); }}>Retry</button>}
    </li>}
    {page?.next && <li className="mtg-history-more"><button type="button" className="mtg-action" disabled={loading}
      onClick={() => void more()}>{loading ? "Loading…" : error ? "Retry more results" : "Load more results"}</button></li>}
  </ul>;
}
