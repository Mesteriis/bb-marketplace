import { useTelegramLocale } from "./i18n/index.tsx";
import { Download } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import type { DocumentInfo } from "../core/contract.ts";
import { isSaveShortcut } from "./composer-keys.ts";
import { DocumentIcon } from "./document-icon.tsx";
import { MessageSearchLabel } from "./message-text.tsx";

const unitFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
const fileUnits = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];

export function DocumentButton({ document, save, player, compactVideo }: {
  document: DocumentInfo; save?: () => Promise<boolean>; player?: ReactNode; compactVideo?: boolean;
}) {
  const { t: tr } = useTelegramLocale();
  const { name, sizeBytes, approximateSize } = document;
  const order = sizeBytes ? Math.min(fileUnits.length - 1, Math.floor(Math.log2(sizeBytes) / 10)) : 0;
  const size = sizeBytes === undefined ? undefined
    : `${approximateSize ? "≈ " : ""}${unitFormat.format(sizeBytes / 1024 ** order)} ${fileUnits[order]}`;
  const [status, setStatus] = useState<"idle" | "busy" | "error">("idle");
  const saving = useRef(false);
  async function download() {
    if (!save || saving.current) return;
    saving.current = true;
    setStatus("busy");
    try { setStatus(await save() ? "idle" : "error"); }
    catch { setStatus("error"); }
    finally { saving.current = false; }
  }

  const track = document.audioTrack;
  const trackDetails = (track?.title || track?.artist) && <p className="mtg-audio-track">
    {track.title && <strong><bdi><MessageSearchLabel text={track.title} /></bdi></strong>}
    {track.title && track.artist && " · "}
    {track.artist && <bdi><MessageSearchLabel text={track.artist} /></bdi>}
  </p>;
  const label = status === "busy" ? "Downloading" : "Download";
  const details = <span className="mtg-file-label">
    <bdi><MessageSearchLabel text={name} /></bdi>
    {(size || !save || status === "busy") && <span className="mtg-document-size">
      {size}{size && (!save || status === "busy") && " · "}
      {!save && <span>{tr("Download unavailable")}</span>}
      {status === "busy" && <span role="status">{tr("Downloading")}</span>}
    </span>}
  </span>;
  const control = compactVideo ? save && <>
    <button type="button" className="mtg-video-download" aria-label={`${label} ${name}`} title={`${label} ${name}${size ? ` (${size})` : ""}`}
      aria-keyshortcuts="Meta+S Control+S" disabled={status === "busy"} onClick={() => void download()}>
      <Download size={16} aria-hidden="true" />
    </button>
    {status === "busy" && <span className="mtg-visually-hidden" role="status">{tr("Downloading")}</span>}
    {status === "error" && <p role="alert">{tr("Could not download this document.")}</p>}
  </> : <div className="mtg-file-card">
    {save ? <button type="button" className="mtg-action mtg-document" aria-keyshortcuts={player ? "Meta+S Control+S" : undefined}
      aria-label={`${label} ${name}`} disabled={status === "busy"} onClick={() => void download()}>
      <DocumentIcon document={document} />{details}<Download className="mtg-file-download-icon" size={15} aria-hidden="true" />
    </button> : <div className="mtg-file-unavailable"><DocumentIcon document={document} />{details}</div>}
    {status === "error" && <p role="alert">{tr("Could not download this document.")}</p>}
  </div>;
  return player && save ? <div className={compactVideo ? "mtg-video-attachment" : undefined} onKeyDown={(event) => {
    if (!isSaveShortcut(event)) return;
    event.preventDefault();
    event.stopPropagation();
    if (!event.repeat) void download();
  }}>{trackDetails}{player}{control}</div> : <>{trackDetails}{player}{control}</>;
}
