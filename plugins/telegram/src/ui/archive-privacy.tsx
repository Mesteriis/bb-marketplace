import { useEffect, useState } from "react";
import type { ArchiveSettings, ArchiveSettingsView } from "../core/contract.ts";

export type ArchivePrivacyActions = {
  load: () => Promise<ArchiveSettingsView>;
  save: (values: ArchiveSettings, expected: ArchiveSettings) => Promise<"saved" | "changed" | "unavailable">;
};

export function ArchivePrivacy({ actions }: { actions: ArchivePrivacyActions }) {
  const [open, setOpen] = useState(false);
  const [original, setOriginal] = useState<ArchiveSettingsView>();
  const [draft, setDraft] = useState<ArchiveSettings>();
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    if (!open) return;
    let active = true;
    setOriginal(undefined);
    setDraft(undefined);
    setError("");
    void actions.load().then((result) => {
      if (!active) return;
      setOriginal(result);
      setDraft(result);
    }, () => {
      if (active) setError("Could not load archive settings.");
    });
    return () => { active = false; };
  }, [actions, open, reload]);

  const changed = !!draft && !!original && (draft.muteUnknown !== original.muteUnknown
    || draft.keepUnmuted !== original.keepUnmuted || draft.keepFolderChats !== original.keepFolderChats);

  async function save() {
    if (!changed || !original || !draft || busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await actions.save(draft, original);
      if (result === "saved") {
        setOriginal({ ...draft, canMuteUnknown: original.canMuteUnknown });
        setNotice("Archive settings saved.");
      } else {
        setOriginal(undefined);
        setError(result === "changed" ? "Archive settings changed in Telegram." : "Telegram did not accept these settings.");
      }
    } catch {
      setOriginal(undefined);
      setError("Telegram did not confirm the change.");
    } finally { setBusy(false); }
  }

  return <details onToggle={(event) => { setOpen(event.currentTarget.open); setNotice(""); }}>
    <summary>Archive behavior</summary>
    {open && <>
      {!original && !error && <p role="status">Loading archive settings…</p>}
      {original && draft && <form onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <label><input type="checkbox" checked={draft.muteUnknown} disabled={busy || (!original.canMuteUnknown && !original.muteUnknown)}
          onChange={(event) => setDraft({ ...draft, muteUnknown: event.currentTarget.checked })} /> Archive and mute new chats from non-contacts</label>
        {!original.canMuteUnknown && !original.muteUnknown && <p>Telegram has disabled this option for your account.</p>}
        <label><input type="checkbox" checked={draft.keepUnmuted} disabled={busy}
          onChange={(event) => setDraft({ ...draft, keepUnmuted: event.currentTarget.checked })} /> Keep unmuted chats in Archive</label>
        <label><input type="checkbox" checked={draft.keepFolderChats} disabled={busy || draft.keepUnmuted}
          onChange={(event) => setDraft({ ...draft, keepFolderChats: event.currentTarget.checked })} /> Keep chats from folders in Archive</label>
        <button type="submit" className="mtg-action" disabled={busy || !changed}>Save archive settings</button>
      </form>}
      {error && <p role="alert">{error} <button type="button" className="mtg-action" disabled={busy}
        onClick={() => setReload((current) => current + 1)}>Reload archive settings</button></p>}
      {notice && <p role="status">{notice}</p>}
    </>}
  </details>;
}
