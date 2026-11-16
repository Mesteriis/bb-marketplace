import { useState } from "react";
import type { TelegramFolder } from "../core/contract.ts";

export type SaveFolderOrder = (order: number[], expected: number[]) => Promise<"saved" | "changed" | "unavailable">;

export function FolderOrder({ folders, save, disabled }: { folders: TelegramFolder[]; save: SaveFolderOrder; disabled: boolean }) {
  const [draft, setDraft] = useState<{ order: number[]; expected: number[] }>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const current = folders.map(({ id }) => id);
  const stale = !!draft && (current.length !== draft.expected.length || current.some((id, index) => id !== draft.expected[index]));
  const order = stale ? current : draft?.order ?? current;
  const labels = new Map(folders.map(({ id, title }) => [id, title]));
  const changed = order.some((id, index) => id !== current[index]);

  function move(index: number, next: number) {
    const moved = [...order];
    [moved[index], moved[next]] = [moved[next]!, moved[index]!];
    setDraft({ order: moved, expected: current });
    setNotice("");
  }

  async function submit() {
    if (!draft || stale || !changed || busy || disabled) return;
    setBusy(true);
    setNotice("");
    try {
      const result = await save(draft.order, draft.expected);
      if (result === "saved" || result === "changed") setDraft(undefined);
      setNotice(result === "saved" ? "Folder order saved." : result === "changed"
        ? "Folder order changed in Telegram. Review the current order." : "Telegram did not accept the folder order.");
    } catch {
      setNotice("Could not save the folder order.");
    } finally {
      setBusy(false);
    }
  }

  return <details>
    <summary>Folder order</summary>
    <ol>{order.map((id, index) => <li key={id}>{labels.get(id)}
      <button type="button" className="mtg-action" disabled={disabled || busy || index === 0}
        aria-label={`Move ${labels.get(id)} up`} onClick={() => move(index, index - 1)}>↑</button>
      <button type="button" className="mtg-action" disabled={disabled || busy || index === order.length - 1}
        aria-label={`Move ${labels.get(id)} down`} onClick={() => move(index, index + 1)}>↓</button>
    </li>)}</ol>
    <button type="button" className="mtg-action" disabled={disabled || busy || !changed}
      onClick={() => void submit()}>Save folder order</button>
    {(stale || notice) && <p role="status">{stale ? "Folder order changed in Telegram. Review the current order." : notice}</p>}
  </details>;
}
