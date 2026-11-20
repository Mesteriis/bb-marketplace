import { useTelegramLocale } from "./i18n/index.tsx";
import { useEffect, useState } from "react";
import type { TelegramFolder } from "../core/contract.ts";

type MainPositionChange = { mainPosition: number; expectedMainPosition: number };
type FolderOrderEntry = number | "main";
export type SaveFolderOrder = (order: number[], expected: number[], positions?: MainPositionChange) =>
  Promise<"saved" | "changed" | "unavailable">;

export function FolderOrder({ folders, mainPosition, canMoveMain, save, disabled }: {
  folders: TelegramFolder[];
  mainPosition?: number;
  canMoveMain?: () => Promise<boolean>;
  save: SaveFolderOrder;
  disabled: boolean;
}) {
  const { t: tr } = useTelegramLocale();
  const [draft, setDraft] = useState<{ order: FolderOrderEntry[]; expected: FolderOrderEntry[]; mainPosition?: number }>();
  const [open, setOpen] = useState(false);
  const [canMove, setCanMove] = useState<boolean>();
  const canCheckPosition = mainPosition !== undefined;
  useEffect(() => {
    if (!open || !canMoveMain || !canCheckPosition) return;
    let current = true;
    void canMoveMain().then((allowed) => { if (current) setCanMove(allowed); }, () => { if (current) setCanMove(false); });
    return () => { current = false; };
  }, [open, canMoveMain, canCheckPosition]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const current: FolderOrderEntry[] = folders.map(({ id }) => id);
  if (canMove && mainPosition !== undefined) current.splice(mainPosition, 0, "main");
  const stale = !!draft && (mainPosition !== draft.mainPosition || current.length !== draft.expected.length ||
    current.some((id, index) => id !== draft.expected[index]));
  const order = stale ? current : draft?.order ?? current;
  const labels = new Map<FolderOrderEntry, string>(folders.map(({ id, title }) => [id, title]));
  labels.set("main", "All chats");
  const checking = canMoveMain !== undefined && mainPosition !== undefined && canMove === undefined;
  const changed = order.some((id, index) => id !== current[index]);

  function move(index: number, next: number) {
    const moved = [...order];
    [moved[index], moved[next]] = [moved[next]!, moved[index]!];
    setDraft({ order: moved, expected: current, mainPosition });
    setNotice("");
  }

  async function submit() {
    if (!draft || stale || !changed || busy || disabled) return;
    setBusy(true);
    setNotice("");
    try {
      const ids = (entries: FolderOrderEntry[]) => entries.filter((id): id is number => typeof id === "number");
      const position = draft.order.indexOf("main");
      const result = draft.mainPosition !== undefined
        ? await save(ids(draft.order), ids(draft.expected), {
          mainPosition: position >= 0 ? position : draft.mainPosition, expectedMainPosition: draft.mainPosition,
        })
        : await save(ids(draft.order), ids(draft.expected));
      if (result === "saved" || result === "changed") setDraft(undefined);
      setNotice(result === "saved" ? "Folder order saved." : result === "changed"
        ? "Folder order changed in Telegram. Review the current order." : "Telegram did not accept the folder order.");
    } catch {
      setNotice("Could not save the folder order.");
    } finally {
      setBusy(false);
    }
  }

  return <details onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>{tr("Folder order")}</summary>
    {open && canMove && mainPosition !== undefined && <p>{tr("BB opens the first folder on startup if there is no conversation to restore.")}</p>}
    <ol>{order.map((id, index) => <li key={id}>{labels.get(id)}
      <button type="button" className="mtg-action" disabled={disabled || busy || checking || index === 0}
        aria-label={tr("Move {0} up", [labels.get(id)])} onClick={() => move(index, index - 1)}>↑</button>
      <button type="button" className="mtg-action" disabled={disabled || busy || checking || index === order.length - 1}
        aria-label={tr("Move {0} down", [labels.get(id)])} onClick={() => move(index, index + 1)}>↓</button>
    </li>)}</ol>
    <button type="button" className="mtg-action" disabled={disabled || busy || checking || !changed}
      onClick={() => void submit()}>{tr("Save folder order")}</button>
    {(stale || notice) && <p role="status">{stale ? tr("Folder order changed in Telegram. Review the current order.") : tr(notice)}</p>}
  </details>;
}
