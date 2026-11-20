import { useTelegramLocale } from "./i18n/index.tsx";
import { ExternalLink, Move } from "lucide-react";
import { createContext, useContext, useEffect, useRef, useState, type DragEvent } from "react";
import type { PhotoDragTicket } from "../core/contract.ts";

export const PreparePhotoFileDrag = createContext<((id: string, messageId: string) => Promise<PhotoDragTicket>) | undefined>(undefined);

export function PhotoFileDrag({ chatId, messageId, save }: { chatId: string; messageId: string; save: () => Promise<void> }) {
  const { t: tr } = useTelegramLocale();
  const prepare = useContext(PreparePhotoFileDrag);
  const [file, setFile] = useState<{ data: string; expires: number }>();
  const [preparing, setPreparing] = useState(false);
  const [failed, setFailed] = useState(false);
  const pending = useRef(false);
  useEffect(() => {
    if (!file) return;
    const timer = setTimeout(() => setFile(undefined), Math.max(0, file.expires - Date.now()));
    return () => clearTimeout(timer);
  }, [file]);
  if (!prepare) return null;

  async function prepareFile() {
    if (!prepare || pending.current) return;
    pending.current = true;
    setPreparing(true);
    setFailed(false);
    const started = Date.now();
    try {
      const ticket = await prepare(chatId, messageId);
      if (!/^telegram-photo-[1-9]\d{0,15}\.jpg$/.test(ticket.name)
        || !/^\/api\/v1\/plugins\/makosh-telegram\/http\/document-download\?ticket=[a-z0-9_-]{43}$/i.test(ticket.url)
        || !/^https?:$/.test(window.location.protocol)) throw new Error("Invalid photo drag ticket.");
      const expires = started + ticket.validForMs;
      if (expires <= Date.now()) throw new Error("The photo drag ticket expired.");
      setFile({ data: `image/jpeg:${ticket.name}:${new URL(ticket.url, window.location.origin).href}`, expires });
    } catch {
      setFailed(true);
    } finally {
      pending.current = false;
      setPreparing(false);
    }
  }

  function startDrag(event: DragEvent<HTMLButtonElement>) {
    if (!file || file.expires <= Date.now()) {
      event.preventDefault();
      setFile(undefined);
      return;
    }
    event.dataTransfer.clearData();
    event.dataTransfer.effectAllowed = "copy";
    event.dataTransfer.setData("DownloadURL", file.data);
  }

  const label = preparing ? tr("Preparing photo…") : file ? tr("Drag photo out") : tr("Prepare photo to drag");
  return <>
    <button type="button" className="mtg-viewer-detail-action mtg-photo-file-drag"
      aria-label={label} disabled={preparing} draggable={!!file}
      title={file ? tr("Drag to another app or click to save") : undefined}
      onClick={() => void (file ? save() : prepareFile())} onDragStart={startDrag} onDragEnd={() => setFile(undefined)}>
      {file ? <ExternalLink size={16} aria-hidden="true" /> : <Move size={16} aria-hidden="true" />}{label}
    </button>
    {failed && <span role="alert">{tr("Could not prepare this photo to drag.")}</span>}
  </>;
}
