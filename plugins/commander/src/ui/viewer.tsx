import { useEffect, useState } from "react";
import type { ViewKind, ViewModel } from "../core/preview.ts";
import { ru } from "./strings.ts";

const modeLabel: Record<ViewKind, string> = { text: ru.view.text, binary: ru.view.hex, image: ru.view.image };

/**
 * Renders a file window. Text and hex are plain text inside <pre>, so markup in a
 * file is never parsed. Images, including SVG, go through <img> with a blob URL,
 * which keeps scripts and external references inside the image and out of BB's origin.
 * With `onMode`, one button per offered representation switches the window.
 */
export function Viewer({ name, model, modes, onMode }: {
  name: string; model: ViewModel; modes?: ViewKind[]; onMode?: (mode: ViewKind) => void;
}) {
  return (
    <section aria-label={name} className="commander-viewer">
      {onMode && modes && modes.length > 1 ? (
        <div role="group" aria-label={ru.view.group} className="commander-viewer-modes">
          {modes.map((mode) => (
            <button key={mode} type="button" aria-pressed={mode === model.kind} onClick={() => onMode(mode)}>
              {modeLabel[mode]}
            </button>
          ))}
        </div>
      ) : null}
      {model.kind === "image" ? <ImageView name={name} mime={model.mime} bytes={model.bytes} /> : null}
      {model.kind === "text" ? <pre className="commander-viewer-text">{model.text}</pre> : null}
      {model.kind === "binary" ? <pre className="commander-viewer-hex">{model.lines.join("\n")}</pre> : null}
      {model.truncated ? <p role="status">{ru.view.truncated}</p> : null}
    </section>
  );
}

function ImageView({ name, mime, bytes }: { name: string; mime: string; bytes: Uint8Array }) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    const next = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [bytes, mime]);

  return url ? <img src={url} alt={name} /> : null;
}
