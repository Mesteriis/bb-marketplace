import { useTelegramLocale } from "./i18n/index.tsx";
import { useEffect, useState } from "react";
import type { SenderBlockState } from "../core/contract.ts";

export type SenderBlockActions = {
  load: (id: string) => Promise<SenderBlockState | null>;
  change: (id: string, expected: SenderBlockState, next: SenderBlockState) => Promise<boolean>;
};

export function SenderBlockSettings({ chatId, actions }: { chatId: string; actions: SenderBlockActions }) {
  const { t: tr } = useTelegramLocale();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState<SenderBlockState | null>();
  const [confirm, setConfirm] = useState<{ next: SenderBlockState; label: string }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setValue(undefined);
    setError("");
    void actions.load(chatId).then((state) => {
      if (active) setValue(state);
    }, () => {
      if (active) setError("Could not load the block status.");
    });
    return () => { active = false; };
  }, [actions, chatId, open, revision]);

  const blocked = value === "main";
  const action = blocked ? "Unblock" : "Block";

  async function submit() {
    if (!value || !confirm || busy) return;
    setBusy(true);
    setError("");
    try {
      const applied = await actions.change(chatId, value, confirm.next);
      setValue(applied ? confirm.next : undefined);
      if (!applied) setError("The block status changed in Telegram or is unavailable.");
    } catch {
      setValue(undefined);
      setError("Telegram did not confirm the change.");
    } finally {
      setBusy(false);
      setConfirm(undefined);
    }
  }

  return <details onToggle={(event) => { setOpen(event.currentTarget.open); setConfirm(undefined); }}>
    <summary>{tr("Blocking")}</summary>
    {open && <>
      {value === undefined && !error && <p role="status">{tr("Loading block status…")}</p>}
      {value === null && <p>{tr("Blocking is unavailable for this chat.")}</p>}
      {value && <>
        <p role="status">{blocked ? tr("User is blocked.") : value === "stories" ? tr("User is blocked from seeing your stories.") : tr("User is not blocked.")}</p>
        {confirm ? <>
          <button type="button" className="mtg-action" disabled={busy} onClick={() => void submit()}>{confirm.label}</button>
          <button type="button" className="mtg-action" disabled={busy} onClick={() => setConfirm(undefined)}>{tr("Cancel")}</button>
        </> : <>
          <button type="button" className="mtg-action" disabled={busy}
            onClick={() => setConfirm({ next: blocked ? "none" : "main", label: blocked ? "Confirm unblock" : "Confirm block" })}>{action}{tr(" user")}</button>
          {!blocked && <button type="button" className="mtg-action" disabled={busy} onClick={() => setConfirm(value === "stories"
            ? { next: "none", label: "Confirm showing stories" }
            : { next: "stories", label: "Confirm hiding stories" })}>{value === "stories" ? tr("Show stories to user") : tr("Hide stories from user")}</button>}
        </>}
      </>}
      {error && <p role="alert">{tr(error)} <button type="button" className="mtg-action"
        onClick={() => setRevision((current) => current + 1)}>{tr("Reload block status")}</button></p>}
    </>}
  </details>;
}
