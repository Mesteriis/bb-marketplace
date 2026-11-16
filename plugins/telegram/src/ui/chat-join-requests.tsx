import { useEffect, useState } from "react";
import type { JoinRequestPage } from "../core/contract.ts";

export type JoinRequestActions = {
  load: (id: string, query: string, cursor?: NonNullable<JoinRequestPage["next"]>) => Promise<JoinRequestPage | null>;
  review: (id: string, userId: string, approve: boolean) => Promise<boolean>;
};

export function ChatJoinRequests({ chatId, actions }: { chatId: string; actions: JoinRequestActions }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");
  const [revision, setRevision] = useState(0);
  const [page, setPage] = useState<JoinRequestPage | null>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirm, setConfirm] = useState<{ userId: string; approve: boolean }>();

  useEffect(() => {
    if (!open) return;
    let current = true;
    setPage(undefined);
    setError("");
    void actions.load(chatId, query).then(
      (result) => { if (current) setPage(result); },
      () => { if (current) setError("Could not load join requests."); },
    );
    return () => { current = false; };
  }, [open, chatId, query, revision, actions]);

  async function submit() {
    if (!confirm || busy) return;
    setBusy(true);
    setError("");
    try {
      if (!await actions.review(chatId, confirm.userId, confirm.approve)) throw new Error("Review unconfirmed.");
      setRevision((value) => value + 1);
    } catch { setError("Telegram did not process the request."); }
    finally { setBusy(false); setConfirm(undefined); }
  }

  async function more(cursor: NonNullable<JoinRequestPage["next"]>) {
    setBusy(true);
    setError("");
    try {
      const result = await actions.load(chatId, query, cursor);
      if (!result) throw new Error("Requests unavailable.");
      setPage((previous) => {
        const rows = new Map(previous?.requests.map((row) => [row.userId, row]));
        for (const row of result.requests) rows.set(row.userId, row);
        return { requests: [...rows.values()], next: result.next };
      });
    } catch { setError("Could not load more join requests."); }
    finally { setBusy(false); }
  }

  return <details onToggle={(event) => { setOpen(event.currentTarget.open); setConfirm(undefined); }}>
    <summary>Join requests</summary>
    {open && <>
      <form className="mtg-composer" onSubmit={(event) => {
        event.preventDefault();
        setConfirm(undefined);
        setQuery(text.trim());
        setRevision((value) => value + 1);
      }}>
        <input type="search" aria-label="Find a join request" placeholder="Find a request" value={text} maxLength={128}
          onChange={(event) => setText(event.target.value)} />
        <button type="submit" className="mtg-action" disabled={busy}>Find</button>
      </form>
      {page === undefined && !error && <p role="status">Loading join requests…</p>}
      {page === null && <p>Join requests are unavailable for your role.</p>}
      {page && !page.requests.length && !page.next && <p>No pending join requests.</p>}
      {error && <p role="alert">{error} <button type="button" className="mtg-action"
        onClick={() => setRevision((value) => value + 1)}>Refresh</button></p>}
      {!!page?.requests.length && <ul className="mtg-scheduled-list" aria-label="Pending join requests">
        {page.requests.map((row) => <li key={row.userId}>
          <bdi>{row.name}</bdi>
          {row.bio && <p>{row.bio}</p>}
          {confirm?.userId === row.userId ? <>
            <button type="button" className="mtg-action" disabled={busy} onClick={() => void submit()}>
              {confirm.approve ? "Confirm approval" : "Confirm decline"}
            </button>
            <button type="button" className="mtg-action" disabled={busy} onClick={() => setConfirm(undefined)}>Cancel</button>
          </> : <>
            <button type="button" className="mtg-action" disabled={busy} onClick={() => setConfirm({ userId: row.userId, approve: true })}>Approve</button>
            <button type="button" className="mtg-action" disabled={busy} onClick={() => setConfirm({ userId: row.userId, approve: false })}>Decline</button>
          </>}
        </li>)}
      </ul>}
      {page?.next && <button type="button" className="mtg-action" disabled={busy}
        onClick={() => { if (page.next) void more(page.next); }}>Load more requests</button>}
    </>}
  </details>;
}
