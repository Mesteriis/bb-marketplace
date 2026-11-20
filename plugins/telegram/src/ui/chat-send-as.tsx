import { useTelegramLocale } from "./i18n/index.tsx";
import { useCallback, useEffect, useState } from "react";
import type { ChatSendAs } from "../core/contract.ts";

export type ChatSendAsActions = {
  load: (id: string) => Promise<ChatSendAs | null>;
  save: (id: string, key: string, expected: string) => Promise<"saved" | "changed" | "unavailable">;
};

export function ChatSendAsSettings({ id, actions }: { id: string; actions: ChatSendAsActions }) {
  const { t: tr } = useTelegramLocale();
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<ChatSendAs | null>();
  const [selected, select] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    setBusy(true);
    setState(undefined);
    setNotice("");
    try {
      const current = await actions.load(id);
      setState(current);
      select(current?.current ?? "");
    } catch { setNotice("Could not load posting identities."); }
    finally { setBusy(false); }
  }, [actions, id]);

  useEffect(() => { if (open) void load(); }, [open, load]);

  async function save() {
    if (busy || !state || selected === state.current || !state.choices.some(({ key, available }) => selected === key && available)) return;
    setBusy(true);
    setNotice("");
    try {
      const result = await actions.save(id, selected, state.current);
      if (result === "saved") {
        setState({ ...state, current: selected });
        setNotice("Posting identity updated.");
      } else {
        setState(undefined);
        setNotice(result === "changed" ? "The posting identity changed in Telegram." : "Telegram did not confirm the posting identity.");
      }
    } catch {
      setState(undefined);
      setNotice("Could not confirm the posting identity.");
    } finally { setBusy(false); }
  }

  return <details onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>{tr("Send as")}</summary>
    {open && <>
      {busy && <p role="status">{tr("Checking posting identity…")}</p>}
      {state === null && <p>{tr("Telegram offers no alternate posting identity here.")}</p>}
      {state && <form onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <p>{tr("Current identity ")}<bdi>{state.choices.find(({ key }) => key === state.current)?.name}</bdi></p>
        <label>{tr("Posting identity ")}<select value={selected} disabled={busy} onChange={(event) => select(event.currentTarget.value)}>
          {state.choices.map(({ key, name, available }) => <option key={key} value={key} disabled={!available}>
            {name}{available ? "" : tr(" · Premium required")}
          </option>)}
        </select></label>
        <button type="submit" className="mtg-action" disabled={busy || state.current === selected}>{tr("Save posting identity")}</button>
      </form>}
      {notice && <p role="status">{tr(notice)}</p>}
      {state === undefined && !!notice && <button type="button" className="mtg-action" disabled={busy}
        onClick={() => void load()}>{tr("Reload posting identities")}</button>}
    </>}
  </details>;
}
