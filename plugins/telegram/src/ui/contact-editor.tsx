import { useEffect, useState } from "react";
import type { ContactDetails } from "../core/contract.ts";

export type ContactEditorActions = {
  load: (id: string) => Promise<ContactDetails | null>;
  save: (id: string, expected: ContactDetails, names: Pick<ContactDetails, "first" | "last">) => Promise<boolean>;
  remove: (id: string, expected: ContactDetails) => Promise<boolean>;
};

export function ContactEditor({ chatId, actions }: { chatId: string; actions: ContactEditorActions }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState<ContactDetails | null>();
  const [first, setFirst] = useState("");
  const [last, setLast] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!open) return;
    let active = true;
    setValue(undefined);
    setError("");
    void actions.load(chatId).then((result) => {
      if (!active) return;
      setValue(result);
      setFirst(result?.first ?? "");
      setLast(result?.last ?? "");
    }, () => { if (active) setError("Could not load the contact."); });
    return () => { active = false; };
  }, [actions, chatId, open, revision]);

  async function change(remove: boolean) {
    if (!value || busy) return;
    setBusy(true);
    setError("");
    setStatus("");
    try {
      const applied = remove ? await actions.remove(chatId, value) : await actions.save(chatId, value, { first, last });
      if (!applied) {
        setError("The contact changed or is unavailable. Reload before retrying.");
        return;
      }
      setRevision((current) => current + 1);
      setStatus(remove ? "Contact removed." : "Contact saved.");
    } catch { setError("Telegram could not update this contact."); }
    finally { setBusy(false); setConfirm(false); }
  }

  const canSave = !!(first.trim() || last.trim()) && (!value?.saved || first.trim() !== value.first || last.trim() !== value.last);
  return <details onToggle={(event) => { setOpen(event.currentTarget.open); setConfirm(false); }}>
    <summary>Contact</summary>
    {open && <>
      {value === undefined && !error && <p role="status">Loading contact…</p>}
      {value === null && <p>Contact editing is unavailable for this chat.</p>}
      {value && <form onSubmit={(event) => { event.preventDefault(); if (canSave) void change(false); }}>
        <label>First name <input maxLength={64} value={first} disabled={busy} onChange={(event) => setFirst(event.target.value)} /></label>
        <label>Last name <input maxLength={64} value={last} disabled={busy} onChange={(event) => setLast(event.target.value)} /></label>
        <button type="submit" className="mtg-action" disabled={busy || !canSave}>{value.saved ? "Save contact name" : "Add contact"}</button>
        {value.saved && !confirm && <button type="button" className="mtg-action" disabled={busy}
          onClick={() => setConfirm(true)}>Remove contact</button>}
        {confirm && <>
          <p>Remove this person from your Telegram contacts?</p>
          <button type="button" className="mtg-action" disabled={busy} onClick={() => void change(true)}>Confirm removal</button>
          <button type="button" className="mtg-action" disabled={busy} onClick={() => setConfirm(false)}>Keep contact</button>
        </>}
      </form>}
      {status && <p role="status">{status}</p>}
      {error && <p role="alert">{error} <button type="button" className="mtg-action" onClick={() => setRevision((current) => current + 1)}>Reload contact</button></p>}
    </>}
  </details>;
}
