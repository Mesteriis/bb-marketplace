import { useEffect, useState } from "react";
import type { ViewModel } from "../core/preview.ts";

const TRUNCATED_NOTE = "Показана только первая часть файла";

/**
 * Renders a file window. Text and hex are plain text inside <pre>, so markup in a
 * file is never parsed. Images, including SVG, go through <img> with a blob URL,
 * which keeps scripts and external references inside the image and out of BB's origin.
 */
export function Viewer({ name, model }: { name: string; model: ViewModel }) {
  return (
    <section aria-label={name} className="commander-viewer">
      {model.kind === "image" ? <ImageView name={name} mime={model.mime} bytes={model.bytes} /> : null}
      {model.kind === "text" ? <pre className="commander-viewer-text">{model.text}</pre> : null}
      {model.kind === "binary" ? <pre className="commander-viewer-hex">{model.lines.join("\n")}</pre> : null}
      {model.truncated ? <p role="status">{TRUNCATED_NOTE}</p> : null}
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
