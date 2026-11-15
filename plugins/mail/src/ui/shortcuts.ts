// Gmail-style hotkeys for the Mail page. Letters match the physical key
// (event.code), so they work on any layout (Russian included); symbols match
// the character, with the US key position as a fallback. The page listens on
// its own root element only, so nothing fires while another BB page is shown.
import { useCallback, useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";

/** Where `g` then a letter goes. "all" is the All accounts view. */
export type GoTarget = "inbox" | "sent" | "drafts" | "trash" | "all";

export type ShortcutCommand =
  | { kind: "next" }
  | { kind: "previous" }
  | { kind: "open" }
  | { kind: "back" }
  | { kind: "select" }
  | { kind: "archive" }
  | { kind: "delete" }
  | { kind: "spam" }
  | { kind: "flag" }
  | { kind: "mark_unread" }
  | { kind: "mark_read" }
  | { kind: "move" }
  | { kind: "search" }
  | { kind: "sheet" }
  | { kind: "compose" }
  | { kind: "reply" }
  | { kind: "reply_all" }
  | { kind: "forward" }
  | { kind: "go"; target: GoTarget };

/** How long `g` waits for its second key. */
export const G_SEQUENCE_MS = 1_000;

/** What the matcher reads from a keydown; a DOM or React event fits. */
export interface KeyLike {
  key: string;
  code: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  target: EventTarget | null;
  isComposing?: boolean;
  /** The key is held down (auto-repeat). */
  repeat?: boolean;
}

type ElementLike = {
  tagName?: string;
  isContentEditable?: boolean;
  closest?: (selector: string) => unknown;
};

/**
 * Typing in a field, or anything inside the composer, a dialog or a select's
 * list, is never a hotkey.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  const element = target as ElementLike | null;
  if (element === null || typeof element.closest !== "function") return false;
  const tag = element.tagName?.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  if (element.isContentEditable === true) return true;
  return (
    element.closest(
      '[contenteditable]:not([contenteditable="false"]), [data-mail-composer], [role="dialog"], [role="alertdialog"], [role="listbox"], [role="option"], [role="combobox"], [role="menu"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="textbox"]',
    ) != null
  );
}

/** Enter on a button or link is that control's own click. */
function isActivatable(target: EventTarget | null): boolean {
  const element = target as ElementLike | null;
  if (element === null || typeof element.closest !== "function") return false;
  return element.closest('button, a[href], summary, [role="button"], [role="checkbox"]') != null;
}

const GO_KEYS: Record<string, GoTarget> = {
  KeyI: "inbox",
  KeyS: "sent",
  KeyD: "drafts",
  KeyT: "trash",
  KeyA: "all",
};

/** `#`, `!`, `?`: the character, else the key that types it on a US layout. */
function symbol(event: KeyLike, char: string, code: string): boolean {
  return event.key === char || (event.shiftKey && event.code === code);
}

export type KeyMatch = ShortcutCommand | { kind: "g" } | null;

/**
 * The command for one keydown, given whether `g` was just pressed. Returns
 * `{ kind: "g" }` for the start of a sequence and null for anything else.
 */
export function matchShortcut(event: KeyLike, afterG: boolean): KeyMatch {
  const match = matchKey(event, afterG);
  // A held key repeats only the moves through the list; one press is one action.
  if (event.repeat === true && match !== null && match.kind !== "next" && match.kind !== "previous") {
    return null;
  }
  return match;
}

function matchKey(event: KeyLike, afterG: boolean): KeyMatch {
  if (event.ctrlKey || event.altKey || event.metaKey || event.isComposing === true) return null;
  if (isTypingTarget(event.target)) return null;

  if (afterG && !event.shiftKey) {
    const target = GO_KEYS[event.code];
    if (target !== undefined) return { kind: "go", target };
  }

  // Symbols first: Shift+Digit3 is `#`, not a letter.
  if (symbol(event, "#", "Digit3")) return { kind: "delete" };
  if (symbol(event, "!", "Digit1")) return { kind: "spam" };
  if (symbol(event, "?", "Slash")) return { kind: "sheet" };
  if (!event.shiftKey && (event.key === "/" || event.code === "Slash")) return { kind: "search" };

  if (event.code === "Enter" || event.key === "Enter") {
    return isActivatable(event.target) || event.shiftKey ? null : { kind: "open" };
  }

  if (event.shiftKey) {
    if (event.code === "KeyU") return { kind: "mark_unread" };
    if (event.code === "KeyI") return { kind: "mark_read" };
    return null;
  }
  switch (event.code) {
    case "KeyJ":
      return { kind: "next" };
    case "KeyK":
      return { kind: "previous" };
    case "KeyO":
      return { kind: "open" };
    case "KeyU":
      return { kind: "back" };
    case "KeyX":
      return { kind: "select" };
    case "KeyE":
      return { kind: "archive" };
    case "KeyS":
      return { kind: "flag" };
    case "KeyV":
      return { kind: "move" };
    case "KeyC":
      return { kind: "compose" };
    case "KeyR":
      return { kind: "reply" };
    case "KeyA":
      return { kind: "reply_all" };
    case "KeyF":
      return { kind: "forward" };
    case "KeyG":
      return { kind: "g" };
    default:
      return null;
  }
}

export interface ShortcutEntry {
  keys: string[];
  label: string;
  /** Reserved for a later version. */
  soon?: boolean;
}

/** Everything the `?` sheet lists, in its order. */
export const SHORTCUT_SHEET: { title: string; entries: ShortcutEntry[] }[] = [
  {
    title: "Navigation",
    entries: [
      { keys: ["j"], label: "Next conversation" },
      { keys: ["k"], label: "Previous conversation" },
      { keys: ["o", "Enter"], label: "Open conversation" },
      { keys: ["u"], label: "Back to the list" },
      { keys: ["/"], label: "Search" },
      { keys: ["g", "i"], label: "Go to Inbox" },
      { keys: ["g", "s"], label: "Go to Sent" },
      { keys: ["g", "d"], label: "Go to Drafts" },
      { keys: ["g", "t"], label: "Go to Trash" },
      { keys: ["g", "a"], label: "Go to All accounts" },
      { keys: ["?"], label: "Show keyboard shortcuts" },
    ],
  },
  {
    title: "Actions",
    entries: [
      { keys: ["x"], label: "Select conversation" },
      { keys: ["e"], label: "Archive" },
      { keys: ["#"], label: "Delete" },
      { keys: ["!"], label: "Report spam" },
      { keys: ["s"], label: "Flag or unflag" },
      { keys: ["Shift", "u"], label: "Mark unread" },
      { keys: ["Shift", "i"], label: "Mark read" },
      { keys: ["v"], label: "Move to…" },
    ],
  },
  {
    title: "Writing",
    entries: [
      { keys: ["c"], label: "Compose" },
      { keys: ["r"], label: "Reply" },
      { keys: ["a"], label: "Reply all" },
      { keys: ["f"], label: "Forward" },
      { keys: ["Cmd/Ctrl", "Enter"], label: "Send (in the composer)" },
      { keys: ["Esc"], label: "Close the composer" },
    ],
  },
];

/**
 * A keydown handler for the page root: runs `onCommand` for each hotkey (with
 * whether the key is held, which only j and k pass through) and
 * keeps the `g` sequence, which ends after G_SEQUENCE_MS or on the next key.
 */
export function useShortcuts(onCommand: (command: ShortcutCommand, repeat: boolean) => void) {
  const commandRef = useRef(onCommand);
  commandRef.current = onCommand;
  const gTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const endSequence = useCallback(() => {
    if (gTimer.current !== null) clearTimeout(gTimer.current);
    gTimer.current = null;
  }, []);
  useEffect(() => endSequence, [endSequence]);

  return useCallback(
    (event: ReactKeyboardEvent<HTMLElement>) => {
      if (event.defaultPrevented) return;
      const afterG = gTimer.current !== null;
      const match = matchShortcut(event, afterG);
      // A modifier on its own neither runs nor ends a sequence.
      if (match === null && (event.key === "Shift" || event.code.startsWith("Shift"))) return;
      endSequence();
      if (match === null) return;
      event.preventDefault();
      if (match.kind === "g") {
        gTimer.current = setTimeout(() => {
          gTimer.current = null;
        }, G_SEQUENCE_MS);
        return;
      }
      commandRef.current(match, event.repeat);
    },
    [endSequence],
  );
}

/**
 * For a plugin dialog's onEscapeKeyDown: the dialog closes, and the key goes
 * no further, so BB does not also treat it as its own Escape (back).
 */
export function stopEscape(event: KeyboardEvent): void {
  event.stopPropagation();
}
