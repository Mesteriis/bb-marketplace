import { useTelegramLocale } from "./i18n/index.tsx";
import { useEffect, useState } from "react";
import type { ChatThemeView } from "../core/contract.ts";

export type ChatThemeActions = {
  load: (id: string) => Promise<ChatThemeView | null>;
  save: (id: string, expected: string | null, name: string | null) => Promise<"saved" | "changed" | "unavailable">;
};

export function ChatTheme({ id, actions }: { id: string; actions: ChatThemeActions }) {
  const { t: tr } = useTelegramLocale();
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<ChatThemeView | null>();
  const [selected, setSelected] = useState("");
  const [saving, setSaving] = useState(false);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    if (!open) return;
    let active = true;
    void actions.load(id).then((result) => {
      if (!active) return;
      setView(result);
      setSelected(result?.current ?? "");
    }, () => { if (active) setError("Could not load Telegram chat themes."); });
    return () => { active = false; };
  }, [open, id, actions, revision]);

  async function save() {
    const theme = selected || null;
    if (!view || theme === view.current || saving) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const result = await actions.save(id, view.current, theme);
      if (result === "saved") {
        setNotice("Chat theme saved.");
        setRevision((value) => value + 1);
      } else if (result === "changed") {
        setError("The theme changed in Telegram. Choose a theme again.");
        setRevision((value) => value + 1);
      } else {
        setError("Telegram could not set this theme.");
      }
    } catch {
      setError("Telegram did not confirm the change. Refresh before retrying.");
      setRevision((value) => value + 1);
    } finally {
      setSaving(false);
    }
  }

  const accent = view?.themes.find(({ name }) => name === selected)?.accent;
  return <details onToggle={(event) => {
    setOpen(event.currentTarget.open);
    if (event.currentTarget.open) { setView(undefined); setError(""); setNotice(""); }
  }}>
    <summary>{tr("Chat theme")}</summary>
    {open && <>
      {view === undefined && !error && <p role="status">{tr("Loading chat themes…")}</p>}
      {view === null && <p>{tr("Theme selection is unavailable for this chat.")}</p>}
      {view && <form onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <label>{tr("Theme ")}<select value={selected} disabled={saving} onChange={(event) => setSelected(event.currentTarget.value)}>
          <option value="">{tr("Default")}</option>
          {view.current && !view.themes.some(({ name }) => name === view.current) && <option value={view.current}>{view.current}{tr(" (current)")}</option>}
          {view.themes.map(({ name }) => <option key={name} value={name}>{name}</option>)}
        </select></label>
        {accent && <p><span className="mtg-theme-swatch" style={{ backgroundColor: accent }} aria-hidden="true" />{tr(" Preview accent")}</p>}
        {view.themes.length === 0 && <p>{tr("Telegram has not supplied a list of themes.")}</p>}
        <button type="submit" className="mtg-action" disabled={saving || (selected || null) === view.current}>{tr("Apply theme")}</button>
      </form>}
      <button type="button" className="mtg-action" disabled={saving} onClick={() => {
        setView(undefined);
        setError("");
        setNotice("");
        setRevision((value) => value + 1);
      }}>{tr("Refresh themes")}</button>
      {error && <p role="alert">{tr(error)}</p>}
      {notice && <p role="status">{tr(notice)}</p>}
    </>}
  </details>;
}
