// Where the text of a paste comes from. The browser's own paste event carries it, but not every browser fires that event
// on a canvas, and Ctrl+Shift+V is not a paste command on a Mac at all: so a moment after the shortcut, if no paste event
// came, the clipboard is read directly (the browser may ask the owner to allow it once).
export const PASTE_EVENT_WAIT_MS = 150;

export interface PasteFallback {
  /** The paste shortcut was pressed. */
  shortcut(): void;
  /** The browser's paste event arrived: the direct read is not needed. */
  eventSeen(): void;
  cancel(): void;
}

export function createPasteFallback(deliver: (text: string) => void, read: () => Promise<string> = () => navigator.clipboard.readText()): PasteFallback {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let cancelled = false;
  const clear = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  return {
    shortcut: () => {
      clear();
      timer = setTimeout(() => {
        timer = null;
        read().then(
          (text) => {
            if (!cancelled && text !== "") deliver(text);
          },
          () => undefined, // refused or unavailable: nothing is typed
        );
      }, PASTE_EVENT_WAIT_MS);
    },
    eventSeen: clear,
    cancel: () => {
      cancelled = true;
      clear();
    },
  };
}
