// Host-free pointer -> framebuffer coordinate mapping for the RDP canvas.
//
// The canvas element rect is measured in CSS pixels. The framebuffer is the
// engine's RGBA8 desktop (width x height). Two fit modes:
//   - "fit": scale the framebuffer to fit inside the element preserving
//     aspect ratio, centered; the bars around it are the letterbox.
//   - "actual": one framebuffer pixel == one device pixel (CSS px * dpr),
//     anchored to the top-left; anything beyond the framebuffer is the
//     letterbox.
// A point outside the drawn framebuffer (inside a letterbox bar) maps to null.
export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

export type FitMode = "fit" | "actual";

export function clientToFramebuffer(
  clientX: number,
  clientY: number,
  rect: Rect,
  dpr: number,
  mode: FitMode,
  fb: Size,
): { x: number; y: number } | null {
  if (fb.width <= 0 || fb.height <= 0 || rect.width <= 0 || rect.height <= 0 || dpr <= 0) {
    return null;
  }
  const dx = clientX - rect.left;
  const dy = clientY - rect.top;
  // Outside the element entirely.
  if (dx < 0 || dy < 0 || dx >= rect.width || dy >= rect.height) return null;

  if (mode === "actual") {
    const fx = Math.floor(dx * dpr);
    const fy = Math.floor(dy * dpr);
    // Letterbox beyond the framebuffer's bottom/right edge.
    if (fx < 0 || fy < 0 || fx >= fb.width || fy >= fb.height) return null;
    return { x: fx, y: fy };
  }

  // fit: uniform scale, centered.
  const scale = Math.min(rect.width / fb.width, rect.height / fb.height);
  const drawW = fb.width * scale;
  const drawH = fb.height * scale;
  const ox = (rect.width - drawW) / 2;
  const oy = (rect.height - drawH) / 2;
  if (dx < ox || dx >= ox + drawW || dy < oy || dy >= oy + drawH) return null; // letterbox bar
  const fx = Math.floor((dx - ox) / scale);
  const fy = Math.floor((dy - oy) / scale);
  if (fx < 0 || fy < 0 || fx >= fb.width || fy >= fb.height) return null;
  return { x: fx, y: fy };
}
