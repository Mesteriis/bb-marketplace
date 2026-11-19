// Pasting the Mac's clipboard into a remote screen that has no clipboard channel (a VM's graphics console, an RDP desktop):
// the text is TYPED. Pure: what to type for a text, and which key combination asks for it.
import type { RdpViewInputEvent } from "./rdp-view-messages.ts";

/** A paste types at most this many characters; the rest is left out and the owner is told. */
export const MAX_PASTE_CHARS = 4096;
/** Characters per RDP input batch (a batch is one message to the service). */
const RDP_RUN = 64;

export interface KeyState {
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/** Cmd+V, or Ctrl+Shift+V. Plain Ctrl+V is the remote machine's own shortcut and is forwarded as it is. */
export function isPasteShortcut(e: KeyState): boolean {
  if (e.code !== "KeyV" || e.altKey) return false;
  return (e.metaKey && !e.ctrlKey) || (e.ctrlKey && e.shiftKey && !e.metaKey);
}

export function modifiersHeld(e: Pick<KeyState, "metaKey" | "ctrlKey" | "shiftKey" | "altKey">): boolean {
  return e.metaKey || e.ctrlKey || e.shiftKey || e.altKey;
}

/** Line ends become "\n"; the text is cut at the limit. */
function prepared(text: string): { chars: string[]; truncated: boolean } {
  const all = [...text.replace(/\r\n?/g, "\n")];
  return { chars: all.slice(0, MAX_PASTE_CHARS), truncated: all.length > MAX_PASTE_CHARS };
}

const XK_RETURN = 0xff0d;
const XK_TAB = 0xff09;
/** The signs a US keyboard types with Shift. */
const SHIFTED = new Set([..."~!@#$%^&*()_+{}|:\"<>?"]);

export interface PasteKey {
  keysym: number;
  /** Shift is held around this key (a capital letter or a shifted sign on a US layout, which is what a console expects). */
  shift: boolean;
}

/** The key presses that type `text` on an RFB (VNC) console. */
export function pasteAsKeysyms(text: string): { keys: PasteKey[]; truncated: boolean } {
  const { chars, truncated } = prepared(text);
  const keys: PasteKey[] = [];
  for (const ch of chars) {
    const cp = ch.codePointAt(0) as number;
    if (ch === "\n") keys.push({ keysym: XK_RETURN, shift: false });
    else if (ch === "\t") keys.push({ keysym: XK_TAB, shift: false });
    else if (cp < 0x20 || cp === 0x7f) continue;
    else if (cp <= 0xff) keys.push({ keysym: cp, shift: (cp >= 0x41 && cp <= 0x5a) || SHIFTED.has(ch) });
    else keys.push({ keysym: 0x01000000 + cp, shift: false });
  }
  return { keys, truncated };
}

const ENTER = 0x1c;
const TAB = 0x0f;
const press = (scancode: number): RdpViewInputEvent[] => [
  { kind: "key", scancode, extended: false, down: true },
  { kind: "key", scancode, extended: false, down: false },
];

/** The input events that type `text` on an RDP desktop, in batches to be sent one after another. */
export function pasteAsRdpEvents(text: string): { batches: RdpViewInputEvent[][]; truncated: boolean } {
  const { chars, truncated } = prepared(text);
  const batches: RdpViewInputEvent[][] = [];
  let batch: RdpViewInputEvent[] = [];
  let run = "";
  let typed = 0;
  const endRun = (): void => {
    if (run !== "") batch.push({ kind: "unicode", text: run });
    run = "";
  };
  const endBatch = (): void => {
    endRun();
    if (batch.length > 0) batches.push(batch);
    batch = [];
    typed = 0;
  };
  for (const ch of chars) {
    const cp = ch.codePointAt(0) as number;
    if (ch === "\n" || ch === "\t") {
      endRun();
      batch.push(...press(ch === "\n" ? ENTER : TAB));
    } else if (cp < 0x20 || cp === 0x7f) continue;
    else run += ch;
    typed += 1;
    if (typed >= RDP_RUN) endBatch();
  }
  endBatch();
  return { batches, truncated };
}
