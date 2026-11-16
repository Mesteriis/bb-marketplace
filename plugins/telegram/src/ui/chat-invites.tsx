import { useEffect, useState, type FormEvent } from "react";
import type { InviteDraft, InvitePage, ManagedInvite } from "../core/contract.ts";

export type ChatInviteActions = {
  load: (id: string, cursor?: NonNullable<InvitePage["next"]>) => Promise<InvitePage | null>;
  create: (id: string, draft: InviteDraft) => Promise<ManagedInvite>;
  revoke: (id: string, link: string) => Promise<boolean>;
};

export function ChatInvites({ chatId, actions }: { chatId: string; actions: ChatInviteActions }) {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState<InvitePage | null>();
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [failed, setFailed] = useState(false);
  const [name, setName] = useState("");
  const [expiry, setExpiry] = useState("");
  const [limit, setLimit] = useState("");
  const [approval, setApproval] = useState(false);
  const [confirm, setConfirm] = useState<string>();

  useEffect(() => {
    if (!open) return;
    let active = true;
    setFailed(false);
    void actions.load(chatId).then(
      (result) => { if (active) setPage(result); },
      () => { if (active) setFailed(true); },
    );
    return () => { active = false; };
  }, [actions, chatId, open, revision]);

  async function create(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const expires = expiry ? Math.floor(new Date(expiry).getTime() / 1000) : 0;
    if (!Number.isSafeInteger(expires) || (expires !== 0 && expires <= Math.floor(Date.now() / 1000))) {
      setStatus("Choose a future expiration date.");
      return;
    }
    setBusy(true);
    try {
      const created = await actions.create(chatId, { name: name.trim(), expires, limit: approval ? 0 : Number(limit), approval });
      setPage((previous) => ({ links: [created, ...(previous?.links ?? []).filter(({ link }) => link !== created.link)], next: previous?.next ?? null }));
      setStatus("Invite created.");
      setName("");
      setExpiry("");
      setLimit("");
      setApproval(false);
    } catch { setStatus("Telegram could not create the invite."); }
    finally { setBusy(false); }
  }

  async function revoke(link: string) {
    if (busy) return;
    setBusy(true);
    try {
      if (!await actions.revoke(chatId, link)) throw new Error("Invite revocation was not confirmed.");
      setPage((previous) => previous && { ...previous, links: previous.links.filter((row) => row.link !== link) });
      setRevision((value) => value + 1);
      setStatus("Invite revoked.");
    } catch { setStatus("Telegram could not revoke this invite."); }
    finally { setBusy(false); setConfirm(undefined); }
  }

  async function more(cursor: NonNullable<InvitePage["next"]>) {
    setBusy(true);
    try {
      const result = await actions.load(chatId, cursor);
      if (!result) throw new Error("Invite list is unavailable.");
      setPage((previous) => {
        const links = new Map(previous?.links.map((row) => [row.link, row]));
        for (const row of result.links) links.set(row.link, row);
        return { links: [...links.values()], next: result.next };
      });
    } catch { setStatus("Could not load more invites."); }
    finally { setBusy(false); }
  }

  return <details onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>Invite links</summary>
    {open && <>
      {failed && <p role="alert">Could not load invites. <button type="button" className="mtg-action"
        onClick={() => setRevision((value) => value + 1)}>Retry</button></p>}
      {page === undefined && !failed && <p role="status">Loading invites…</p>}
      {page === null && <p>Invite links are unavailable for your role.</p>}
      {page && <>
        <ul className="mtg-scheduled-list" aria-label="My invite links">
          {page.links.map((row) => <li key={row.link}>
            <bdi>{row.name || (row.primary ? "Primary invite" : "Invite")}</bdi>
            <p>{row.uses}{row.limit ? ` / ${row.limit}` : ""} joined
              {row.approval && ` · ${row.pending} pending`}
              {row.expires > 0 && ` · Expires ${new Date(row.expires * 1000).toLocaleString()}`}</p>
            <button type="button" className="mtg-action" onClick={() => {
              void navigator.clipboard.writeText(row.link).then(() => setStatus("Invite copied."), () => setStatus("Could not copy the invite."));
            }}>Copy link</button>
            {confirm === row.link ? <>
              <p>{row.primary ? "Revoke this link and generate a new primary invite?" : "Revoke this invite?"}</p>
              <button type="button" className="mtg-action" disabled={busy} onClick={() => void revoke(row.link)}>Confirm revoke</button>
              <button type="button" className="mtg-action" disabled={busy} onClick={() => setConfirm(undefined)}>Keep link</button>
            </> : <button type="button" className="mtg-action" disabled={busy} onClick={() => setConfirm(row.link)}>Revoke link</button>}
          </li>)}
        </ul>
        {page.next && <button type="button" className="mtg-action" disabled={busy} onClick={() => { if (page.next) void more(page.next); }}>Load more invites</button>}
        <form onSubmit={(event) => void create(event)}>
          <fieldset disabled={busy}>
            <legend>New invite link</legend>
            <label>Name <input maxLength={32} value={name} onChange={(event) => setName(event.target.value)} /></label>
            <label>Expires <input type="datetime-local" value={expiry} onChange={(event) => setExpiry(event.target.value)} /></label>
            <label><input type="checkbox" checked={approval} onChange={(event) => setApproval(event.target.checked)} /> Require approval</label>
            {!approval && <label>Member limit <input type="number" min={0} max={99_999} value={limit} onChange={(event) => setLimit(event.target.value)} /></label>}
            <button type="submit" className="mtg-action">Create invite</button>
          </fieldset>
        </form>
      </>}
      {status && <p role="status">{status}</p>}
    </>}
  </details>;
}
