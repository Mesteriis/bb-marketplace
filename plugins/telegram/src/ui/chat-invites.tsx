import { useTelegramLocale } from "./i18n/index.tsx";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { InviteDraft, InviteEditExpected, InviteEditResult, InviteMembersPage, InvitePage, ManagedInvite } from "../core/contract.ts";
import { canonicalTelegramInviteLink } from "../core/public-chat-reference.ts";
import { TelegramLinkQr } from "./copy-message-reference.tsx";
import { formatStarBillingPeriod } from "./star-subscriptions.tsx";

export type ChatInviteActions = {
  load: (id: string, cursor?: NonNullable<InvitePage["next"]>, revoked?: true) => Promise<InvitePage | null>;
  create: (id: string, draft: InviteDraft) => Promise<ManagedInvite>;
  subscriptionLimit?: (id: string) => Promise<number | null>;
  createSubscription?: (id: string, name: string, stars: number) => Promise<ManagedInvite>;
  members?: (id: string, link: string, cursor?: NonNullable<InviteMembersPage["next"]>, expired?: true) => Promise<InviteMembersPage | null>;
  edit?: (id: string, link: string, expected: InviteEditExpected, draft: InviteDraft) => Promise<InviteEditResult>;
  revoke: (id: string, link: string) => Promise<boolean>;
  deleteRevoked?: (id: string, link: string) => Promise<boolean>;
};

const emptyDraft = { name: "", expiry: "", limit: "", approval: false };

function expiryInput(seconds: number) {
  if (!seconds) return "";
  const date = new Date(seconds * 1000);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

export function ChatInvites({ chatId, actions }: { chatId: string; actions: ChatInviteActions }) {
  const { locale: uiLocale, t: tr } = useTelegramLocale();
  const [open, setOpen] = useState(false);
  const [revoked, setRevoked] = useState(false);
  const [page, setPage] = useState<InvitePage | null>();
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [failed, setFailed] = useState(false);
  const [newDraft, setNewDraft] = useState(emptyDraft);
  const [editing, setEditing] = useState<{ original: ManagedInvite; draft: typeof emptyDraft }>();
  const [subscriptionLimit, setSubscriptionLimit] = useState<number | null>(null);
  const [subscriptionName, setSubscriptionName] = useState("");
  const [subscriptionPrice, setSubscriptionPrice] = useState("");
  const nameInput = useRef<HTMLInputElement>(null);
  const draft = editing?.draft ?? newDraft;

  function updateDraft(change: Partial<typeof emptyDraft>) {
    if (editing) setEditing({ ...editing, draft: { ...editing.draft, ...change } });
    else setNewDraft({ ...newDraft, ...change });
  }

  useEffect(() => {
    if (editing?.original.link) nameInput.current?.focus();
  }, [editing?.original.link]);
  const [confirm, setConfirm] = useState<string>();

  useEffect(() => {
    if (!open) return;
    let active = true;
    setFailed(false);
    void (revoked ? actions.load(chatId, undefined, true) : actions.load(chatId)).then(
      (result) => { if (active) setPage(result); },
      () => { if (active) setFailed(true); },
    );
    return () => { active = false; };
  }, [actions, chatId, open, revision, revoked]);

  useEffect(() => {
    if (!open || !actions.subscriptionLimit) return;
    let active = true;
    setSubscriptionLimit(null);
    void actions.subscriptionLimit(chatId).then((limit) => { if (active) setSubscriptionLimit(limit); }, () => {});
    return () => { active = false; };
  }, [actions, chatId, open]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const original = editing?.original;
    const expires = original && draft.expiry === expiryInput(original.expires) ? original.expires
      : draft.expiry ? Math.floor(new Date(draft.expiry).getTime() / 1000) : 0;
    if (!Number.isSafeInteger(expires) || (expires !== 0 && expires <= Math.floor(Date.now() / 1000))) {
      setStatus("Choose a future expiration date.");
      return;
    }
    const input = { name: draft.name.trim(), expires, limit: draft.approval ? 0 : Number(draft.limit), approval: draft.approval };
    setBusy(true);
    setStatus("");
    try {
      if (original && actions.edit) {
        const { name, expires, limit, approval, pricing } = original;
        const result = await actions.edit(chatId, original.link, { name, expires, limit, approval, ...(pricing && { pricing }) }, input);
        if (result.state === "saved") {
          setPage((previous) => previous && { ...previous,
            links: previous.links.map((row) => row.link === result.invite.link ? result.invite : row) });
          setEditing(undefined);
          setStatus("Invite updated.");
        } else if (result.state === "changed") {
          setEditing(undefined);
          setRevision((value) => value + 1);
          setStatus("Invite changed in Telegram. Choose the link again.");
        } else {
          setStatus("Telegram could not edit this invite.");
        }
      } else if (!original) {
        const created = await actions.create(chatId, input);
        setPage((previous) => ({ links: [created, ...(previous?.links ?? []).filter(({ link }) => link !== created.link)], next: previous?.next ?? null }));
        setStatus("Invite created.");
        setNewDraft(emptyDraft);
      }
    } catch { setStatus(original ? "Telegram did not confirm the edit." : "Telegram could not create the invite."); }
    finally { setBusy(false); }
  }

  async function removeLink(link: string) {
    const action = revoked ? actions.deleteRevoked : actions.revoke;
    if (busy || !action) return;
    setBusy(true);
    try {
      if (!await action(chatId, link)) throw new Error("Invite change was not confirmed.");
      setPage((previous) => previous && { ...previous, links: previous.links.filter((row) => row.link !== link) });
      setEditing((previous) => previous?.original.link === link ? undefined : previous);
      setRevision((value) => value + 1);
      setStatus(revoked ? "Revoked invitation deleted." : "Invite revoked.");
    } catch { setStatus(revoked ? "Telegram could not delete this revoked invite." : "Telegram could not revoke this invite."); }
    finally { setBusy(false); setConfirm(undefined); }
  }

  const stars = Number(subscriptionPrice);
  const validPrice = subscriptionLimit !== null && Number.isSafeInteger(stars) && stars >= 1 && stars <= subscriptionLimit;
  async function createSubscription(event: FormEvent) {
    event.preventDefault();
    if (!(validPrice && actions.createSubscription) || busy) return;
    setBusy(true);
    setStatus("");
    try {
      const created = await actions.createSubscription(chatId, subscriptionName.trim(), stars);
      setPage((previous) => ({ links: [created, ...(previous?.links ?? []).filter(({ link }) => link !== created.link)], next: previous?.next ?? null }));
      setSubscriptionName("");
      setSubscriptionPrice("");
      setStatus("Subscription invite created.");
    } catch {
      setStatus("Telegram could not confirm creation. Check the updated invite list before trying again.");
      setRevision((value) => value + 1);
    }
    finally { setBusy(false); }
  }

  async function more(cursor: NonNullable<InvitePage["next"]>) {
    setBusy(true);
    try {
      const result = await (revoked ? actions.load(chatId, cursor, true) : actions.load(chatId, cursor));
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
    <summary>{tr("Invite links")}</summary>
    {open && <>
      {actions.deleteRevoked && <label>{tr("Invite list ")}<select value={revoked ? "revoked" : "active"} disabled={busy}
        onChange={(event) => {
          setPage(undefined);
          setFailed(false);
          setStatus("");
          setConfirm(undefined);
          setEditing(undefined);
          setRevoked(event.currentTarget.value === "revoked");
        }}>
        <option value="active">{tr("Active invitations")}</option>
        <option value="revoked">{tr("Revoked invitations")}</option>
      </select></label>}
      {failed && <p role="alert">{tr("Could not load invites. ")}<button type="button" className="mtg-action"
        onClick={() => setRevision((value) => value + 1)}>{tr("Retry")}</button></p>}
      {page === undefined && !failed && <p role="status">{tr("Loading invites…")}</p>}
      {page === null && <p>{tr("Invite links are unavailable for your role.")}</p>}
      {page && <>
        {!page.links.length && <p>{revoked ? tr("No revoked invitations.") : tr("No active invitations.")}</p>}
        <ul className="mtg-scheduled-list" aria-label={revoked ? tr("My revoked invite links") : tr("My invite links")}>
          {page.links.map((row) => {
            const label = row.name || (row.primary ? tr("Primary invite") : tr("Invite"));
            const qrUrl = canonicalTelegramInviteLink(row.link);
            return <li key={row.link}>
              <bdi>{label}</bdi>
              {row.pricing && <p>{row.pricing.stars.toLocaleString(uiLocale)}{tr(" Stars every ")}{formatStarBillingPeriod(row.pricing.period)}</p>}
              <p>{row.uses}{row.limit ? ` / ${row.limit}` : ""}{tr(" joined")}{row.expiredMembers !== undefined && tr(" · {0} expired subscriptions", [row.expiredMembers.toLocaleString(uiLocale)])}
                {row.approval && tr(" · {0} pending", [row.pending])}
                {row.expires > 0 && tr(" · Expires {0}", [new Date(row.expires * 1000).toLocaleString(uiLocale)])}</p>
              {!revoked && <button type="button" className="mtg-action" onClick={() => {
                void navigator.clipboard.writeText(row.link).then(() => setStatus("Invite copied."), () => setStatus("Could not copy the invite."));
              }}>{tr("Copy link")}</button>}
              {!revoked && qrUrl && <TelegramLinkQr url={qrUrl} label={tr("QR code for {0}", [label])} imageLabel={tr("Telegram invite QR code for {0}", [label])} />}
              {!revoked && actions.members && <InviteMembers chatId={chatId} link={row.link} load={actions.members} />}
              {!revoked && row.subscription && actions.members && <InviteMembers chatId={chatId} link={row.link} load={actions.members} expired />}
              {!revoked && actions.edit && !row.primary && (!row.subscription || row.pricing) && <button type="button" className="mtg-action" disabled={busy}
                onClick={() => {
                  setConfirm(undefined);
                  setStatus("");
                  setEditing({ original: row, draft: { name: row.name, expiry: expiryInput(row.expires),
                    limit: row.limit ? String(row.limit) : "", approval: row.approval } });
                }}>{tr("Edit link")}</button>}
              {confirm === row.link ? <>
                <p>{revoked ? tr("Permanently delete this revoked invitation from Telegram?")
                  : row.primary ? tr("Revoke this link and generate a new primary invite?") : tr("Revoke this invite?")}</p>
                <button type="button" className="mtg-action" disabled={busy} onClick={() => void removeLink(row.link)}>
                  {revoked ? tr("Confirm deletion") : tr("Confirm revoke")}
                </button>
                <button type="button" className="mtg-action" disabled={busy} onClick={() => setConfirm(undefined)}>{tr("Keep link")}</button>
              </> : <button type="button" className="mtg-action" disabled={busy} onClick={() => setConfirm(row.link)}>
                {revoked ? tr("Delete revoked link") : tr("Revoke link")}
              </button>}
            </li>;
          })}
        </ul>
        {page.next && <button type="button" className="mtg-action" disabled={busy} onClick={() => { if (page.next) void more(page.next); }}>{tr("Load more invites")}</button>}
        {!revoked && <form onSubmit={(event) => void submit(event)}>
          <fieldset disabled={busy}>
            <legend>{editing ? tr("Edit invite link") : tr("New invite link")}</legend>
            <label>{tr("Name ")}<input ref={nameInput} maxLength={32} value={draft.name} onChange={(event) => updateDraft({ name: event.target.value })} /></label>
            {editing?.original.pricing
              ? <p>{editing.original.pricing.stars.toLocaleString(uiLocale)}{tr(" Stars every ")}{formatStarBillingPeriod(editing.original.pricing.period)}</p>
              : <><label>{tr("Expires ")}<input type="datetime-local" value={draft.expiry} onChange={(event) => updateDraft({ expiry: event.target.value })} /></label>
            <label><input type="checkbox" checked={draft.approval} onChange={(event) => updateDraft({ approval: event.target.checked })} />{tr(" Require approval")}</label>
            {!draft.approval && <label>{tr("Member limit ")}<input type="number" min={0} max={99_999} value={draft.limit}
              onChange={(event) => updateDraft({ limit: event.target.value })} /></label>}</>}
            <button type="submit" className="mtg-action">{editing ? tr("Save invite changes") : tr("Create invite")}</button>
            {editing && <button type="button" className="mtg-action" onClick={() => setEditing(undefined)}>{tr("Cancel edit")}</button>}
          </fieldset>
        </form>}
        {!revoked && subscriptionLimit !== null && actions.createSubscription && <form onSubmit={(event) => void createSubscription(event)}>
          <fieldset disabled={busy}>
            <legend>{tr("New subscription invite")}</legend>
            <label>{tr("Subscription invite name ")}<input maxLength={32} value={subscriptionName}
              onChange={(event) => setSubscriptionName(event.target.value)} /></label>
            <label>{tr("Stars every 30 days ")}<input type="number" min={1} max={subscriptionLimit} step={1} value={subscriptionPrice}
              onChange={(event) => setSubscriptionPrice(event.target.value)} /></label>
            <button type="submit" className="mtg-action" disabled={!validPrice}>{tr("Create subscription invite")}</button>
          </fieldset>
        </form>}
      </>}
      {status && <p role="status">{tr(status)}</p>}
    </>}
  </details>;
}


function InviteMembers({ chatId, link, load, expired }: {
  chatId: string; link: string; load: NonNullable<ChatInviteActions["members"]>; expired?: true;
}) {
  const { locale: uiLocale, t: tr } = useTelegramLocale();
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState<InviteMembersPage | null>();
  const [request, setRequest] = useState<{ cursor?: NonNullable<InviteMembersPage["next"]> }>({});
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setLoading(true);
    setError(false);
    const result = expired ? load(chatId, link, request.cursor, true) : load(chatId, link, request.cursor);
    void result.then((result) => {
      if (!active) return;
      setPage((previous) => {
        if (!request.cursor || !previous || !result) return result;
        const members = new Map(previous.members.map((row) => [`${row.userId}:${row.date}`, row]));
        for (const row of result.members) members.set(`${row.userId}:${row.date}`, row);
        return { members: [...members.values()], next: result.next };
      });
    }, () => { if (active) setError(true); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [chatId, link, load, open, request, expired]);

  return <details onToggle={(event) => {
    setOpen(event.currentTarget.open);
    if (!event.currentTarget.open) { setPage(undefined); setRequest({}); }
  }}>
    <summary>{expired ? tr("Expired subscriptions") : tr("Members who joined")}</summary>
    {open && <>
      {loading && <p role="status">{tr("Loading members…")}</p>}
      {error && <p role="alert">{tr("Could not load members for this link. ")}<button type="button" className="mtg-action"
        onClick={() => setRequest({ ...request })}>{tr("Retry")}</button></p>}
      {page === null && !loading && <p>{tr("Telegram did not make this member list available.")}</p>}
      {page && !page.members.length && !loading && <p>{expired ? tr("No expired subscriptions for this link.") : tr("No members joined through this link.")}</p>}
      {!!page?.members.length && <ul aria-label={expired ? tr("Members with expired subscriptions") : tr("Members who joined through this link")}>{page.members.map(({ userId, date, name }) => {
        const joined = new Date(date * 1000);
        return <li key={`${userId}:${date}`}><bdi>{name}</bdi>
          {date > 0 && <> · {expired && tr("Joined ")}<time dateTime={joined.toISOString()}>{joined.toLocaleString(uiLocale)}</time></>}</li>;
      })}</ul>}
      {page?.next && !error && <button type="button" className="mtg-action" disabled={loading} onClick={() => {
        if (page.next) setRequest({ cursor: page.next });
      }}>{expired ? tr("Load more expired subscriptions") : tr("Load more joined members")}</button>}
    </>}
  </details>;
}
