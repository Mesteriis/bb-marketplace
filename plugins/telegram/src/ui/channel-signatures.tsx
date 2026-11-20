import { useTelegramLocale } from "./i18n/index.tsx";
import { useEffect, useState } from "react";
import type { ChannelSignatures, ChannelSignatureView } from "../core/contract.ts";

export type ChannelSignatureActions = {
  load: (id: string) => Promise<ChannelSignatureView | null>;
  save: (id: string, values: ChannelSignatures, expected: ChannelSignatures) => Promise<"saved" | "changed" | "unavailable">;
};

export function ChannelSignaturesPanel({ chatId, actions }: { chatId: string; actions: ChannelSignatureActions }) {
  const { t: tr } = useTelegramLocale();
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState<ChannelSignatureView | null>();
  const [draft, setDraft] = useState<ChannelSignatures>();
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const changed = current && draft && (draft.sign !== current.values.sign || draft.showProfile !== current.values.showProfile);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setCurrent(undefined);
    setDraft(undefined);
    setError("");
    setSaved(false);
    void actions.load(chatId).then((view) => {
      if (active) { setCurrent(view); setDraft(view?.values); }
    }, () => { if (active) setError("Could not load channel signatures."); });
    return () => { active = false; };
  }, [actions, chatId, open, revision]);

  async function save() {
    if (busy || !current?.editable || !draft || !changed) return;
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      const result = await actions.save(chatId, draft, current.values);
      if (result === "saved") {
        setCurrent({ ...current, values: draft });
        setSaved(true);
      } else {
        setCurrent(undefined);
        setError(result === "changed" ? "The channel settings changed in Telegram. Reload them before saving."
          : "Telegram did not save the channel signatures.");
      }
    } catch { setError("Could not save channel signatures."); }
    finally { setBusy(false); }
  }

  return <details onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>{tr("Post signatures")}</summary>
    {open && <form onSubmit={(event) => { event.preventDefault(); void save(); }}>
      {current === undefined && !error && <p role="status">{tr("Loading post signatures…")}</p>}
      {current === null && <p role="status">{tr("Telegram does not provide signature settings for this channel.")}</p>}
      {current && draft && <>
        <label><input type="checkbox" checked={draft.sign} disabled={busy || !current.editable}
          onChange={(event) => { setSaved(false); setDraft({ ...draft, sign: event.target.checked }); }} />{tr(" Sign posts")}</label>
        <label><input type="checkbox" checked={draft.showProfile} disabled={busy || !current.editable}
          onChange={(event) => { setSaved(false); setDraft({ ...draft, showProfile: event.target.checked }); }} />{tr(" Show author profiles")}</label>
        {current.editable && <button type="submit" className="mtg-action" disabled={busy || !changed}>{tr("Save post signatures")}</button>}
      </>}
      {error && <p role="alert">{tr(error)} <button type="button" className="mtg-action" disabled={busy}
        onClick={() => setRevision((value) => value + 1)}>{tr("Reload settings")}</button></p>}
      {saved && <p role="status">{tr("Post signatures saved.")}</p>}
    </form>}
  </details>;
}
