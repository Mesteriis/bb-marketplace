import { useTelegramLocale } from "./i18n/index.tsx";
import { useEffect, useState } from "react";
import { slowModeDelays, type SlowModeDelay, type SlowModeView } from "../core/contract.ts";

export type SlowModeActions = {
  load: (id: string) => Promise<SlowModeView | null>;
  save: (id: string, delay: SlowModeDelay, expected: SlowModeDelay) => Promise<"saved" | "changed" | "unavailable">;
};

const labels: Record<SlowModeDelay, string> = {
  0: "Off", 5: "5 seconds", 10: "10 seconds", 30: "30 seconds",
  60: "1 minute", 300: "5 minutes", 900: "15 minutes", 3600: "1 hour",
};

export function GroupSlowMode({ chatId, actions }: { chatId: string; actions: SlowModeActions }) {
  const { t: tr } = useTelegramLocale();
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<SlowModeView | null>();
  const [delay, setDelay] = useState<SlowModeDelay>(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!open) return;
    let active = true;
    setView(undefined);
    setError("");
    setNotice("");
    void actions.load(chatId).then((result) => {
      if (active) { setView(result); setDelay(result?.delay ?? 0); }
    }, () => { if (active) setError("Could not load slow mode."); });
    return () => { active = false; };
  }, [chatId, actions, open, revision]);

  async function save() {
    if (!view?.editable || view.delay === delay || busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await actions.save(chatId, delay, view.delay);
      if (result === "saved") {
        setView({ ...view, delay });
        setNotice("Slow mode saved.");
      } else {
        setView(undefined);
        setError(result === "changed" ? "Slow mode changed in Telegram. Reload the setting before saving."
          : "Telegram did not save slow mode.");
      }
    } catch { setError("Could not save slow mode."); }
    finally { setBusy(false); }
  }

  return <details onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>{tr("Slow mode")}</summary>
    {open && <>
      {view === undefined && !error && <p role="status">{tr("Loading slow mode…")}</p>}
      {view === null && <p>{tr("Slow mode is unavailable in this chat.")}</p>}
      {view && <form onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <label>{tr("Delay between messages ")}<select disabled={busy || !view.editable} value={delay} onChange={(event) => {
          const selected = slowModeDelays.find((value) => value === Number(event.target.value));
          if (selected !== undefined) setDelay(selected);
        }}>
          {slowModeDelays.map((value) => <option key={value} value={value}>{tr(labels[value])}</option>)}
        </select></label>
        {view.editable && <button type="submit" className="mtg-action" disabled={busy || delay === view.delay}>{tr("Save slow mode")}</button>}
      </form>}
      {error && <p role="alert">{tr(error)} <button type="button" className="mtg-action" disabled={busy}
        onClick={() => setRevision((value) => value + 1)}>{tr("Reload slow mode")}</button></p>}
      {notice && <p role="status">{tr(notice)}</p>}
    </>}
  </details>;
}
