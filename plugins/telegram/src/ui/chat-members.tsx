import { useEffect, useState } from "react";
import type { ChatMemberPage } from "../core/contract.ts";

export type ChatMemberLoader = (id: string, query: string, offset?: number) => Promise<ChatMemberPage | null>;
const roles = { owner: "Owner", admin: "Administrator", member: "Member", restricted: "Restricted" } as const;

export function ChatMembers({ chatId, load }: { chatId: string; load: ChatMemberLoader }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [request, setRequest] = useState({ query: "", offset: 0 });
  const [page, setPage] = useState<ChatMemberPage | null>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setLoading(true);
    setError(false);
    void load(chatId, request.query, request.offset).then((result) => {
      if (!active) return;
      if (request.offset && !result) setError(true);
      else setPage((previous) => {
        if (!result || !request.offset) return result;
        const rows = new Map(previous?.members.map((member) => [member.id, member]));
        for (const member of result.members) rows.set(member.id, member);
        return { members: [...rows.values()], next: result.next };
      });
    }, () => { if (active) setError(true); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [chatId, load, open, request]);

  return <details onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>Members</summary>
    {open && <>
      <form className="mtg-composer" onSubmit={(event) => {
        event.preventDefault();
        setPage(undefined);
        setRequest({ query: text.trim(), offset: 0 });
      }}>
        <input type="search" aria-label="Find a member" placeholder="Find a member" value={text} maxLength={128}
          onChange={(event) => setText(event.currentTarget.value)} />
        <button type="submit" className="mtg-action">Find</button>
      </form>
      {loading && <p role="status">Loading members…</p>}
      {error && <p role="alert">Telegram could not load members. <button type="button" className="mtg-action"
        onClick={() => setRequest({ ...request })}>Retry</button></p>}
      {page === null && !loading && !error && <p>Member list is unavailable.</p>}
      {page && !page.members.length && page.next === null && !loading && !error && <p>No matching members.</p>}
      {!!page?.members.length && <ul className="mtg-scheduled-list" aria-label="Telegram members">
        {page.members.map(({ id, name, role, tag }) => <li key={id}>
          <bdi>{name}</bdi> · {roles[role]}{tag && <> · <bdi>{tag}</bdi></>}
        </li>)}
      </ul>}
      {page?.next != null && !error && <button type="button" className="mtg-action" disabled={loading}
        onClick={() => setRequest({ query: request.query, offset: page.next! })}>Load more members</button>}
    </>}
  </details>;
}
