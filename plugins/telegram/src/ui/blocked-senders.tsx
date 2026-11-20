import { useTelegramLocale } from "./i18n/index.tsx";
import { useEffect, useState } from "react";
import type { BlockedSenderPage, MessageSender, SenderBlockList } from "../core/contract.ts";

import type { Chat } from "../core/demo.ts";

export type BlockedSenderActions = {
  open: (sender: MessageSender) => Promise<Chat>;
  load: (list: SenderBlockList, offset: number) => Promise<BlockedSenderPage>;
  unblock: (sender: MessageSender, list: SenderBlockList) => Promise<boolean>;
};

export function BlockedSenders({ actions, openChat }: { actions: BlockedSenderActions; openChat?: (chat: Chat) => void }) {
  const { t: tr } = useTelegramLocale();
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<SenderBlockList>("main");
  const [offset, setOffset] = useState(0);
  const [revision, setRevision] = useState(0);
  const [page, setPage] = useState<BlockedSenderPage>();
  const [confirm, setConfirm] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    let active = true;
    setPage(undefined);
    void actions.load(list, offset).then((result) => {
      if (active) setPage(result);
    }, () => {
      if (active) setError("Could not load blocked senders.");
    });
    return () => { active = false; };
  }, [actions, list, offset, open, revision]);

  function firstPage() {
    setPage(undefined);
    setConfirm(undefined);
    setOffset(0);
    setRevision((current) => current + 1);
  }

  async function unblock(sender: MessageSender) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      if (!await actions.unblock(sender, list)) setError("This sender's block status changed in Telegram.");
    } catch {
      setError("Telegram did not confirm unblocking.");
    } finally {
      firstPage();
      setBusy(false);
    }
  }

  async function view(sender: MessageSender) {
    if (!openChat || busy) return;
    setBusy(true);
    setConfirm(undefined);
    setError("");
    try {
      openChat(await actions.open(sender));
    } catch {
      setError("Could not open the Telegram conversation.");
    } finally {
      setBusy(false);
    }
  }

  return <details onToggle={(event) => {
    setOpen(event.currentTarget.open);
    setError("");
    firstPage();
  }}>
    <summary>{tr("Blocked users and chats")}</summary>
    {open && <>
      <label>{tr("Block list ")}<select value={list} disabled={busy} onChange={(event) => {
        setList(event.currentTarget.value === "stories" ? "stories" : "main");
        setError("");
        firstPage();
      }}>
        <option value="main">{tr("Blocked users and chats")}</option>
        <option value="stories">{tr("Hidden from stories")}</option>
      </select></label>
      {error && <p role="alert">{tr(error)} <button type="button" className="mtg-action" disabled={busy}
        onClick={() => { setError(""); firstPage(); }}>{tr("Reload blocked senders")}</button></p>}
      {!error && !page && <p role="status">{tr("Loading blocked senders…")}</p>}
      {page?.entries.length === 0 && <p>{offset > 0 ? tr("No blocked senders on this page.")
        : list === "stories" ? tr("You haven’t hidden stories from anyone.") : tr("No blocked users or chats.")}</p>}
      {page && page.entries.length > 0 && <ul>{page.entries.map(({ sender, name }) => {
        const key = `${sender.kind}:${sender.id}`;
        return <li key={key}>
          {openChat ? <button type="button" className="mtg-action" disabled={busy}
            aria-label={tr("Open chat with {0}", [name])} onClick={() => void view(sender)}>{name}</button> : <span>{name}</span>}{" "}
          {confirm === key ? <>
            <button type="button" className="mtg-action" disabled={busy}
              onClick={() => void unblock(sender)}>{list === "stories" ? tr("Confirm showing stories") : tr("Confirm unblock")}</button>
            <button type="button" className="mtg-action" disabled={busy} onClick={() => setConfirm(undefined)}>{tr("Cancel")}</button>
          </> : <button type="button" className="mtg-action" disabled={busy}
            aria-label={list === "stories" ? tr("Show stories to {0}", [name]) : tr("Unblock {0}", [name])}
            onClick={() => setConfirm(key)}>{list === "stories" ? tr("Show stories") : tr("Unblock")}</button>}
        </li>;
      })}</ul>}
      {offset > 0 && <button type="button" className="mtg-action" disabled={busy} onClick={firstPage}>{tr("First page")}</button>}
      {page?.next != null && <button type="button" className="mtg-action" disabled={busy}
        onClick={() => { setPage(undefined); setConfirm(undefined); setError(""); setOffset(page.next!); }}>{tr("Next page")}</button>}
    </>}
  </details>;
}
