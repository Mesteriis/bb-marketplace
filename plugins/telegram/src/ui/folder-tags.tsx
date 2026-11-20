import { useTelegramLocale } from "./i18n/index.tsx";
import { useState } from "react";
import type { FolderTagsState } from "../core/contract.ts";

export type FolderTagsActions = {
  load: () => Promise<FolderTagsState | null>;
  save: (enabled: boolean, expected: boolean) => Promise<"saved" | "changed" | "unavailable">;
};

export function FolderTags({ actions, disabled }: { actions: FolderTagsActions; disabled: boolean }) {
  const { t: tr } = useTelegramLocale();
  const [current, setCurrent] = useState<FolderTagsState | null>();
  const [draft, setDraft] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  async function load() {
    if (disabled || busy) return;
    setBusy(true);
    setNotice("");
    try {
      const state = await actions.load();
      setCurrent(state);
      setDraft(state?.enabled ?? false);
    } catch {
      setCurrent(undefined);
      setNotice("Could not load folder tags.");
    } finally { setBusy(false); }
  }

  async function save() {
    if (!current?.editable || disabled || busy || draft === current.enabled) return;
    setBusy(true);
    setNotice("");
    try {
      const result = await actions.save(draft, current.enabled);
      if (result === "saved") {
        setCurrent({ ...current, enabled: draft });
        setNotice("Folder tags updated.");
      } else {
        setCurrent(undefined);
        setNotice(result === "changed" ? "Folder tags changed in Telegram." : "Telegram did not accept the change.");
      }
    } catch {
      setCurrent(undefined);
      setNotice("Telegram did not confirm the change.");
    } finally { setBusy(false); }
  }

  return <details onToggle={(event) => {
    if (event.currentTarget.open && current === undefined) void load();
  }}>
    <summary>{tr("Folder tags")}</summary>
    {current === null && <p>{tr("Folder tags are unavailable for this Telegram connection.")}</p>}
    {current && <>
      <label><input type="checkbox" checked={draft} disabled={disabled || busy || !current.editable}
        onChange={(event) => { setDraft(event.currentTarget.checked); setNotice(""); }} />{tr(" Enable Telegram folder tags")}</label>
      {!current.editable && <p>{tr("Changing folder tags requires Telegram Premium.")}</p>}
      {current.editable && <button type="button" className="mtg-action"
        disabled={disabled || busy || draft === current.enabled} onClick={() => void save()}>{tr("Save folder tags")}</button>}
    </>}
    {busy && <p role="status">{tr("Updating folder tags…")}</p>}
    {notice && <p role="status">{tr(notice)}</p>}
    {!current && notice && <button type="button" className="mtg-action" disabled={disabled || busy}
      onClick={() => void load()}>{tr("Reload folder tags")}</button>}
  </details>;
}
