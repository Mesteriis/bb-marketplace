import { useTelegramLocale } from "./i18n/index.tsx";
import { useEffect, useState } from "react";
import type { NewChatAudience, NewChatPrivacy as Privacy } from "../core/contract.ts";

export type NewChatPrivacyActions = {
  load: () => Promise<Privacy>;
  save: (audience: NewChatAudience, expected: NewChatAudience) => Promise<"saved" | "changed" | "unavailable">;
};

export function NewChatPrivacy({ actions }: { actions: NewChatPrivacyActions }) {
  const { t: tr } = useTelegramLocale();
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState<Privacy>();
  const [audience, setAudience] = useState<NewChatAudience>();
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<"saved" | "changed" | "unavailable" | "loadFailed">();

  useEffect(() => {
    if (!open) return;
    let active = true;
    setCurrent(undefined);
    setStatus(undefined);
    void actions.load().then((value) => {
      if (active) {
        setCurrent(value);
        setAudience(value.audience ?? undefined);
      }
    }, () => { if (active) setStatus("loadFailed"); });
    return () => { active = false; };
  }, [actions, open, revision]);

  async function save() {
    if (!current?.editable || !current.audience || !audience || current.audience === audience || busy) return;
    setBusy(true);
    setStatus(undefined);
    try {
      const result = await actions.save(audience, current.audience);
      setStatus(result);
      setCurrent(result === "saved" ? { ...current, audience } : undefined);
    } catch {
      setCurrent(undefined);
      setStatus("unavailable");
    } finally {
      setBusy(false);
    }
  }

  return <details onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>{tr("Who can start a private chat with me")}</summary>
    {open && <>
      {!current && !status && <p role="status">{tr("Loading new chat privacy…")}</p>}
      {current?.audience && <form onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <label>{tr("New chat audience ")}<select value={audience} disabled={busy || !current.editable}
          onChange={(event) => setAudience(event.currentTarget.value === "everyone" ? "everyone" : "contactsAndPremium")}>
          <option value="everyone">{tr("Everybody")}</option>
          <option value="contactsAndPremium">{tr("My contacts and Premium users")}</option>
        </select></label>
        {current.editable && <button type="submit" className="mtg-action" disabled={busy || audience === current.audience}>{tr("Save new chat privacy")}</button>}
      </form>}
      {current && !current.editable && <p>{tr("Editing this setting is unavailable for your current Telegram configuration.")}</p>}
      {status === "saved" && <p role="status">{tr("New chat privacy saved.")}</p>}
      {status && status !== "saved" && <p role="alert">
        {status === "changed" ? tr("New chat privacy changed in Telegram.") :
          status === "loadFailed" ? tr("Could not load new chat privacy.") : tr("Telegram did not confirm the change.")}
        <button type="button" className="mtg-action" onClick={() => setRevision((value) => value + 1)}>{tr("Reload new chat privacy")}</button>
      </p>}
    </>}
  </details>;
}
