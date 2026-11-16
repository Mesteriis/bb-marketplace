import { useState } from "react";

export type StickerPackSummary = { id: string; title: string };

export function StickerPackOrder({ packs, save, onSaved, reload, close }: {
  packs: StickerPackSummary[];
  save: (order: string[], expected: string[]) => Promise<"saved" | "changed" | "unavailable" | "unknown">;
  onSaved: (current: StickerPackSummary[], next: StickerPackSummary[]) => void;
  reload: () => void;
  close: () => void;
}) {
  const [draft, setDraft] = useState(packs);
  const [selected, setSelected] = useState(packs[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [requiresReload, setRequiresReload] = useState(false);
  const index = draft.findIndex(({ id }) => id === selected);
  const changed = draft.some(({ id }, position) => packs[position]?.id !== id);

  function move(offset: -1 | 1) {
    const destination = index + offset;
    if (index < 0 || destination < 0 || destination >= draft.length) return;
    const next = [...draft];
    [next[index], next[destination]] = [next[destination]!, next[index]!];
    setDraft(next);
    setNotice("");
  }

  async function submit() {
    if (!changed || busy || requiresReload) return;
    setBusy(true);
    setNotice("");
    try {
      const result = await save(draft.map(({ id }) => id), packs.map(({ id }) => id));
      if (result === "saved") {
        onSaved(packs, draft);
        setNotice("Sticker pack order saved.");
      } else {
        setRequiresReload(true);
        setNotice(result === "changed" ? "The order changed in Telegram. Reload the list."
          : "Telegram did not confirm the new order. Reload the list.");
      }
    } catch {
      setRequiresReload(true);
      setNotice("Could not verify the new order. Reload the list.");
    } finally { setBusy(false); }
  }

  return <fieldset aria-label="Sticker pack order">
    <label>Pack to move <select value={selected} disabled={busy || requiresReload}
      onChange={(event) => setSelected(event.currentTarget.value)}>
      {draft.map(({ id, title }, position) => <option key={id} value={id}>{position + 1}. {title}</option>)}
    </select></label>
    <button type="button" className="mtg-action" disabled={busy || requiresReload || index <= 0} onClick={() => move(-1)}>Move up</button>
    <button type="button" className="mtg-action" disabled={busy || requiresReload || index < 0 || index >= draft.length - 1} onClick={() => move(1)}>Move down</button>
    <button type="button" className="mtg-action" disabled={busy || requiresReload || !changed} onClick={() => void submit()}>Save sticker pack order</button>
    {requiresReload && <button type="button" className="mtg-action" onClick={reload}>Reload sticker packs</button>}
    <button type="button" className="mtg-action" disabled={busy} onClick={close}>Close pack order</button>
    {notice && <p role={requiresReload ? "alert" : "status"}>{notice}</p>}
  </fieldset>;
}
