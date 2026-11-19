// What a session's small picture in the sidebar shows. A terminal's is its last few lines of text; a desktop's is a scaled
// frame. Kept in memory only, for as long as the session is on the desk.
export type Thumb = { type: "text"; lines: readonly string[] } | { type: "image"; url: string };

/** The last `max` non-empty screen lines, without trailing spaces, each cut to `width` characters. */
export function thumbLines(rows: readonly string[], max = 5, width = 56): string[] {
  const kept: string[] = [];
  for (let i = rows.length - 1; i >= 0 && kept.length < max; i--) {
    const line = (rows[i] ?? "").replace(/\s+$/u, "");
    if (line !== "") kept.unshift(line.length > width ? line.slice(0, width) : line);
  }
  return kept;
}

/** The size a `width`×`height` frame is drawn at to fit a `maxWidth`×`maxHeight` thumbnail, keeping its proportions. */
export function thumbSize(width: number, height: number, maxWidth = 240, maxHeight = 150): { width: number; height: number } | null {
  if (!(width > 0) || !(height > 0)) return null;
  const scale = Math.min(maxWidth / width, maxHeight / height, 1);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

export function sameThumb(a: Thumb | undefined, b: Thumb | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (a.type === "image") return b.type === "image" && a.url === b.url;
  return b.type === "text" && a.lines.length === b.lines.length && a.lines.every((line, i) => line === b.lines[i]);
}
