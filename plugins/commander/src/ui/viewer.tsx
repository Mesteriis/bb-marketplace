import { Fragment, useEffect, useState } from "react";
import type { ViewKind, ViewModel } from "../core/preview.ts";
import { ru } from "./strings.ts";

const modeLabel: Record<ViewKind, string> = { text: ru.view.text, binary: ru.view.hex, image: ru.view.image };
/** Tab order of the artboard: Текст, Hex, Изображение. */
const tabOrder: ViewKind[] = ["text", "binary", "image"];

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
          {tabOrder.filter((mode) => modes.includes(mode)).map((mode) => (
            <button key={mode} type="button" aria-pressed={mode === model.kind} onClick={() => onMode(mode)}>
              {modeLabel[mode]}
            </button>
          ))}
        </div>
      ) : null}
      {model.kind === "image" ? <ImageView name={name} mime={model.mime} bytes={model.bytes} /> : null}
      {model.kind === "text" ? <pre className="commander-viewer-text">{model.text}</pre> : null}
      {model.kind === "binary" ? <pre className="commander-viewer-hex">{model.lines.map((line, index) => (
        <Fragment key={index}>{index > 0 ? "\n" : null}<HexLine line={line} /></Fragment>
      ))}</pre> : null}
      {model.kind === "binary" ? <p className="commander-viewer-count">{ru.view.shown(model.shown, model.total)}</p> : null}
      {model.truncated ? <p role="status">{ru.view.truncated}</p> : null}
    </section>
  );
}

/** One hex row: the offset and the ASCII column are muted, as on the artboard. Text content is the row itself. */
function HexLine({ line }: { line: string }) {
  const match = /^([0-9A-F]{8}  )(.*?)(  \|.*\|)$/.exec(line);
  if (!match) return <>{line}</>;
  return <>
    <span className="commander-hex-off">{match[1]}</span>{match[2]}<span className="commander-hex-asc">{match[3]}</span>
  </>;
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
