// Carrying a lost console's screen into the terminal of the next one.
// The text is written, then followed by as many blank lines as the screen has rows, which scrolls it out of the viewport into the
// scrollback. A guest that redraws when it is attached (ESC[2J, ESC[H ESC[J: a container console through dtach does) erases only the
// viewport, so the old text and the separator lines stay one scroll up. Nothing the guest sends is touched. (A full reset, ESC c,
// clears the scrollback too; that is the guest's own request and is not worked around.)
export interface HistoryTarget {
  rows: number;
  write(data: string): void;
}

export function writeCarriedHistory(terminal: HistoryTarget, history: string): void {
  if (history === "") return;
  terminal.write(history);
  terminal.write("\r\n".repeat(Math.max(1, terminal.rows)));
}
