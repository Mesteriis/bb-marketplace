// Keeps a session's small picture up to date from what its pane shows: a terminal's last lines (xterm's rows), or a scaled
// frame of a desktop's canvas. Read from the pane's own DOM, so every kind of session gets one without knowing about it.
import { useEffect, type RefObject } from "react";
import { thumbLines, thumbSize, type Thumb } from "../../core/thumb.ts";
import { thumbStore, type ThumbStore } from "../thumb-store.ts";

export const THUMB_REFRESH_MS = 2000;

export function readThumb(body: HTMLElement): Thumb | null {
  const rows = body.querySelector(".xterm-rows");
  if (rows !== null) return { type: "text", lines: thumbLines(Array.from(rows.children, (row) => row.textContent ?? "")) };
  const canvas = body.querySelector("canvas");
  if (canvas === null) return null;
  const size = thumbSize(canvas.width, canvas.height);
  if (size === null) return null;
  try {
    const small = document.createElement("canvas");
    small.width = size.width;
    small.height = size.height;
    const context = small.getContext("2d");
    if (context === null) return null;
    context.drawImage(canvas, 0, 0, size.width, size.height);
    return { type: "image", url: small.toDataURL("image/jpeg", 0.6) };
  } catch {
    // No frame yet, or a canvas the browser will not read back: the card stays as it was.
    return null;
  }
}

export function useThumb(id: string, body: RefObject<HTMLElement | null>, store: ThumbStore = thumbStore): void {
  useEffect(() => {
    const sample = (): void => {
      const thumb = body.current === null ? null : readThumb(body.current);
      if (thumb !== null) store.set(id, thumb);
    };
    sample();
    const timer = setInterval(sample, THUMB_REFRESH_MS);
    return () => {
      clearInterval(timer);
      store.drop(id);
    };
  }, [id, body, store]);
}
