// Gmail-style hotkeys for the Mail page, with Apple Mail's arrows,
// Backspace/Delete and (on a Mac) its Command chords beside them (slice 3i).
// Letters match the physical key (event.code), so they work on any layout
// (Russian included); symbols match the character, with the US key position
// as a fallback. The page listens on its own root element only, so nothing
// fires while another BB page is shown.
import { useCallback, useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { msg } from "./i18n/index.ts";

/** Where `g` then a letter goes. "all" is the All accounts view, "dev" the Dev view (slice 3g), "files" the Files view (slice 3h). */
export type GoTarget = "inbox" | "sent" | "drafts" | "trash" | "all" | "dev" | "files";

export type ShortcutCommand =
  /** `arrow`: from Down/Up (slice 3i), which open the row even with nothing open. */
  | { kind: "next"; arrow?: true }
  | { kind: "previous"; arrow?: true }
  /** Shift+Down/Up: the selection grows by a row (slice 3i). */
  | { kind: "select_down" }
  | { kind: "select_up" }
  /** Down/Up on a message header or the earlier-messages stack: focus moves between them. */
  | { kind: "message_next" }
  | { kind: "message_previous" }
  /** Shift+Command+U on a Mac: mark read when anything is unread, else unread. */
  | { kind: "toggle_read" }
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
  | { kind: "translate" }
  | { kind: "undo" }
  | { kind: "snooze" }
  | { kind: "summarize" }
  | { kind: "find_tasks" }
  | { kind: "new_bb_thread" }
  | { kind: "make_task" }
  | { kind: "labels" }
  | { kind: "expand_all" }
  | { kind: "print" }
  /** `]` and `[`: the next and the previous Inbox tab (Split Inbox). */
  | { kind: "tab_next" }
  | { kind: "tab_previous" }
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
  /** 229 while an IME composes (WebKit), even when isComposing is false. */
  keyCode?: number;
  /** The key is held down (auto-repeat). */
  repeat?: boolean;
}

/** Which platform the keys are read for; only a Mac gets the Command chords. */
export interface KeyPlatform {
  mac: boolean;
}

/**
 * Whether the page runs on a Mac (or an iPad or iPhone): the platform name
 * given, else the browser's own (`navigator.userAgentData.platform`, else
 * `navigator.platform`).
 */
export function isMacPlatform(platform?: string): boolean {
  let name = platform;
  if (name === undefined) {
    if (typeof navigator === "undefined") return false;
    const data = (navigator as Navigator & { userAgentData?: { platform?: unknown } }).userAgentData;
    name = typeof data?.platform === "string" && data.platform !== "" ? data.platform : navigator.platform;
  }
  return /mac|iphone|ipad|ipod/i.test(name ?? "");
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

/**
 * Where a key lands: a field or anything typed into (`typing`), a message
 * header or the earlier-messages stack (`header`), the rest of the open
 * conversation (`reading`, where the arrows scroll), or the page.
 */
export type KeyZone = "typing" | "header" | "reading" | "page";

export function keyZone(target: EventTarget | null): KeyZone {
  if (isTypingTarget(target)) return "typing";
  const element = target as ElementLike | null;
  if (element === null || typeof element.closest !== "function") return "page";
  if (element.closest("[data-mail-message-toggle], [data-mail-stack]") != null) return "header";
  if (element.closest("[data-mail-reading]") != null) return "reading";
  return "page";
}

/** Widgets whose own arrows must keep working (a later one included). */
const ARROW_OWNERS =
  '[role="tablist"], [role="radiogroup"], [role="slider"], [role="spinbutton"], [role="tree"], [role="grid"], [role="toolbar"]';

function ownsArrows(target: EventTarget | null): boolean {
  const element = target as ElementLike | null;
  return element !== null && typeof element.closest === "function" && element.closest(ARROW_OWNERS) != null;
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
  KeyN: "dev",
  KeyF: "files",
};

/** `#`, `!`, `?`: the character, else the key that types it on a US layout. */
function symbol(event: KeyLike, char: string, code: string): boolean {
  return event.key === char || (event.shiftKey && event.code === code);
}

export type KeyMatch = ShortcutCommand | { kind: "g" } | null;

/** The only commands a held key repeats: moves through the list and the messages. */
const REPEATING: ReadonlySet<string> = new Set([
  "next",
  "previous",
  "select_down",
  "select_up",
  "message_next",
  "message_previous",
]);

/**
 * The command for one keydown, given whether `g` was just pressed and the
 * platform (only a Mac gets the Command chords; tests pass it explicitly).
 * Returns `{ kind: "g" }` for the start of a sequence and null for anything else.
 */
export function matchShortcut(event: KeyLike, afterG: boolean, platform: KeyPlatform = { mac: false }): KeyMatch {
  const match = matchKey(event, afterG, platform);
  // A held key repeats only the moves; one press is one action.
  if (event.repeat === true && match !== null && !REPEATING.has(match.kind)) return null;
  return match;
}

/** The modifiers held, as one word: c(trl) a(lt) s(hift) m(eta). */
function modifiers(event: KeyLike): string {
  return `${event.ctrlKey ? "c" : ""}${event.altKey ? "a" : ""}${event.shiftKey ? "s" : ""}${event.metaKey ? "m" : ""}`;
}

/**
 * Apple Mail's Command chords Mail binds on a Mac, by modifiers and physical
 * key; the modifier set must match exactly. Every one is free in BB
 * (HOST_RESERVED); the sheet shows the same list.
 */
const MAC_CHORDS: Record<string, ShortcutCommand> = {
  "m:KeyR": { kind: "reply" },
  "sm:KeyR": { kind: "reply_all" },
  "sm:KeyF": { kind: "forward" },
  "cm:KeyA": { kind: "archive" },
  "sm:KeyJ": { kind: "spam" },
  "sm:KeyU": { kind: "toggle_read" },
  "sm:KeyL": { kind: "flag" },
  "am:KeyF": { kind: "search" },
  "cm:KeyM": { kind: "move" },
  "m:KeyZ": { kind: "undo" },
  "m:Backspace": { kind: "delete" },
};

function isImeKey(event: KeyLike): boolean {
  return event.isComposing === true || event.key === "Process" || event.keyCode === 229;
}

function matchKey(event: KeyLike, afterG: boolean, platform: KeyPlatform): KeyMatch {
  // A field, the composer, a dialog, a menu, a select or an IME first: no key, chord or not.
  if (isImeKey(event)) return null;
  const zone = keyZone(event.target);
  if (zone === "typing") return null;

  if (event.ctrlKey || event.altKey || event.metaKey) {
    if (!platform.mac || !event.metaKey) return null;
    return MAC_CHORDS[`${modifiers(event)}:${event.code}`] ?? null;
  }

  if (event.code === "ArrowDown" || event.code === "ArrowUp") {
    const down = event.code === "ArrowDown";
    if (zone === "reading" || ownsArrows(event.target)) return null;
    if (event.shiftKey) return zone === "page" ? { kind: down ? "select_down" : "select_up" } : null;
    if (zone === "header") return { kind: down ? "message_next" : "message_previous" };
    return down ? { kind: "next", arrow: true } : { kind: "previous", arrow: true };
  }
  if (event.code === "Backspace" || event.code === "Delete") {
    return event.shiftKey ? null : { kind: "delete" };
  }

  if (afterG && !event.shiftKey) {
    const target = GO_KEYS[event.code];
    if (target !== undefined) return { kind: "go", target };
  }

  // Symbols first: Shift+Digit3 is `#`, not a letter.
  if (symbol(event, "#", "Digit3")) return { kind: "delete" };
  if (symbol(event, "!", "Digit1")) return { kind: "spam" };
  if (symbol(event, "?", "Slash")) return { kind: "sheet" };
  if (!event.shiftKey && (event.key === "/" || event.code === "Slash")) return { kind: "search" };
  // Split Inbox: `]` and `[` walk the Inbox tabs; by position where the key types a letter.
  if (event.key === "]" || (!event.shiftKey && event.code === "BracketRight")) return { kind: "tab_next" };
  if (event.key === "[" || (!event.shiftKey && event.code === "BracketLeft")) return { kind: "tab_previous" };
  // Slice 3h: `;` expands or collapses the whole conversation.
  if (event.key === ";" || (!event.shiftKey && event.code === "Semicolon")) return { kind: "expand_all" };

  if (event.code === "Enter" || event.key === "Enter") {
    return isActivatable(event.target) || event.shiftKey ? null : { kind: "open" };
  }

  if (event.shiftKey) {
    if (event.code === "KeyU") return { kind: "mark_unread" };
    if (event.code === "KeyI") return { kind: "mark_read" };
    // Slice 3f: by the physical key, so a Cyrillic layout works too.
    if (event.code === "KeyS") return { kind: "summarize" };
    if (event.code === "KeyT") return { kind: "find_tasks" };
    // Slice 3g: New thread... and Make a task....
    if (event.code === "KeyN") return { kind: "new_bb_thread" };
    if (event.code === "KeyK") return { kind: "make_task" };
    // Slice 3h: Print....
    if (event.code === "KeyP") return { kind: "print" };
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
    case "KeyT":
      return { kind: "translate" };
    // z alone: undo the last action (Mod+Z stays the editor's).
    case "KeyZ":
      return { kind: "undo" };
    // b: snooze (slice 3e), as in Gmail.
    case "KeyB":
      return { kind: "snooze" };
    // l: Labels... (slice 3h), as in Gmail.
    case "KeyL":
      return { kind: "labels" };
    case "KeyG":
      return { kind: "g" };
    default:
      return null;
  }
}

/** How long destructive keys stay quiet after one ran. */
export const DESTRUCTIVE_GUARD_MS = 400;

const DESTRUCTIVE: ReadonlySet<ShortcutCommand["kind"]> = new Set(["archive", "delete", "spam", "move"]);

/** Archive, delete, spam and move take messages out of the list. */
export function isDestructive(command: ShortcutCommand): boolean {
  return DESTRUCTIVE.has(command.kind);
}

export interface DestructiveGuard {
  /**
   * Whether `command` may run now. A destructive key inside the quiet window
   * is refused and keeps the window open, so a burst of taps stays quiet
   * until it stops. Any other key passes and ends the window: j, o or x
   * between two actions is a deliberate choice of the next target.
   */
  admit(command: ShortcutCommand): boolean;
  /** A destructive action ran: the quiet window starts now. */
  ran(): void;
}

/**
 * After an action empties a selection, a quick second tap of the same key
 * would fall through to the cursor row, a message nobody chose. For
 * DESTRUCTIVE_GUARD_MS after a destructive action, destructive keys do nothing
 * until another key is pressed.
 */
export function createDestructiveGuard(now: () => number = Date.now): DestructiveGuard {
  let quietUntil = Number.NEGATIVE_INFINITY;
  return {
    admit(command) {
      if (!isDestructive(command)) {
        quietUntil = Number.NEGATIVE_INFINITY;
        return true;
      }
      const at = now();
      if (at < quietUntil) {
        quietUntil = at + DESTRUCTIVE_GUARD_MS;
        return false;
      }
      return true;
    },
    ran() {
      quietUntil = now() + DESTRUCTIVE_GUARD_MS;
    },
  };
}

export interface ShortcutEntry {
  /** The keys on every platform; empty for a Mac-only row. */
  keys: string[];
  label: string;
  /** Reserved for a later version. */
  soon?: boolean;
  /** The Apple Mail chord, shown only on a Mac. */
  mac?: string[];
}

/** A key chord BB binds itself (BB 0.49.0 defaults): Mail never binds it. */
export interface HostChord {
  /** As the sheet would write it. */
  keys: string[];
  code: string;
  meta?: boolean;
  shift?: boolean;
  ctrl?: boolean;
  alt?: boolean;
}

const CMD = "\u2318";
const SHIFT = "\u21e7";
const CTRL = "\u2303";
const OPT = "\u2325";

/**
 * BB's own keys on a Mac. Mail leaves every one to BB, even where the page
 * could prevent it: c, Shift+P, / and g then a letter cover the same actions.
 */
export const HOST_RESERVED: readonly HostChord[] = [
  { keys: [CMD, "N"], code: "KeyN", meta: true },
  { keys: [SHIFT, CMD, "N"], code: "KeyN", meta: true, shift: true },
  { keys: [CMD, "F"], code: "KeyF", meta: true },
  { keys: [CMD, "P"], code: "KeyP", meta: true },
  { keys: [SHIFT, CMD, "P"], code: "KeyP", meta: true, shift: true },
  ...["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((digit) => ({ keys: [CMD, digit], code: `Digit${digit}`, meta: true })),
  { keys: [CTRL, CMD, "S"], code: "KeyS", meta: true, ctrl: true },
  { keys: [CMD, "K"], code: "KeyK", meta: true },
  { keys: [CMD, "J"], code: "KeyJ", meta: true },
  { keys: [CMD, "W"], code: "KeyW", meta: true },
  { keys: [CMD, "T"], code: "KeyT", meta: true },
  { keys: [SHIFT, CMD, "T"], code: "KeyT", meta: true, shift: true },
  { keys: [CMD, "O"], code: "KeyO", meta: true },
  { keys: [SHIFT, CMD, "O"], code: "KeyO", meta: true, shift: true },
  { keys: [CMD, "["], code: "BracketLeft", meta: true },
  { keys: [CMD, "]"], code: "BracketRight", meta: true },
  { keys: [SHIFT, CMD, "["], code: "BracketLeft", meta: true, shift: true },
  { keys: [SHIFT, CMD, "]"], code: "BracketRight", meta: true, shift: true },
  { keys: [CMD, ","], code: msg("Comma"), meta: true },
  { keys: [CMD, "\\"], code: msg("Backslash"), meta: true },
  { keys: [CMD, "L"], code: "KeyL", meta: true },
  { keys: [SHIFT, CMD, "E"], code: "KeyE", meta: true, shift: true },
  { keys: [SHIFT, CMD, "X"], code: "KeyX", meta: true, shift: true },
  { keys: [SHIFT, CMD, "C"], code: "KeyC", meta: true, shift: true },
  { keys: [SHIFT, CMD, "M"], code: "KeyM", meta: true, shift: true },
  { keys: [CMD, msg("Enter")], code: msg("Enter"), meta: true },
  { keys: [SHIFT, CMD, msg("Enter")], code: msg("Enter"), meta: true, shift: true },
  { keys: [CMD, "."], code: msg("Period"), meta: true },
  { keys: [OPT, "M"], code: "KeyM", alt: true },
  { keys: [OPT, "P"], code: "KeyP", alt: true },
  { keys: [OPT, "T"], code: "KeyT", alt: true },
  ...["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].flatMap((code) => [
    { keys: [CTRL, CMD, code], code, meta: true, ctrl: true },
    { keys: [SHIFT, CTRL, CMD, code], code, meta: true, ctrl: true, shift: true },
  ]),
  { keys: [msg("Esc")], code: msg("Escape") },
];

/** Everything the `?` sheet lists, in its order. */
export const SHORTCUT_SHEET: { title: string; entries: ShortcutEntry[] }[] = [
  {
    title: msg("Navigation"),
    entries: [
      { keys: ["j"], label: msg("Next conversation") },
      { keys: ["k"], label: msg("Previous conversation") },
      { keys: ["\u2193", "\u2191"], label: msg("Open the next or previous conversation") },
      { keys: ["\u2193", "\u2191"], label: msg("On a message header: next or previous message") },
      { keys: ["o", msg("Enter")], label: msg("Open conversation") },
      { keys: ["u"], label: msg("Back to the list") },
      { keys: ["/"], label: msg("Search"), mac: [OPT, CMD, "F"] },
      { keys: ["]", "["], label: msg("Next or previous Inbox tab") },
      { keys: [";"], label: msg("In a message you write: pick a template by name") },
      { keys: ["Tab"], label: msg("In a message you write: take the grey rest of a phrase") },
      // The composer's own key, not one of the page's Apple Mail chords: the label names the Mac form.
      { keys: ["Ctrl", msg("Shift"), "I"], label: msg("In a reply: move the sender to Bcc with a thank-you (Command on a Mac)") },
      { keys: ["Ctrl", "J"], label: msg("In a message: write it with AI from a few words (Command on a Mac)") },
      { keys: ["g", "i"], label: msg("Go to Inbox") },
      { keys: ["g", "s"], label: msg("Go to Sent") },
      { keys: ["g", "d"], label: msg("Go to Drafts") },
      { keys: ["g", "t"], label: msg("Go to Trash") },
      { keys: ["g", "a"], label: msg("Go to All accounts") },
      { keys: ["g", "n"], label: msg("Go to Dev") },
      { keys: ["g", "f"], label: msg("Go to Files") },
      { keys: ["?"], label: msg("Show keyboard shortcuts") },
    ],
  },
  {
    title: msg("Actions"),
    entries: [
      { keys: ["x"], label: msg("Select conversation") },
      { keys: [msg("Shift"), "\u2193"], label: msg("Select the next conversation too") },
      { keys: [msg("Shift"), "\u2191"], label: msg("Select the previous conversation too") },
      { keys: ["e"], label: msg("Archive"), mac: [CTRL, CMD, "A"] },
      { keys: ["#"], label: msg("Delete"), mac: [CMD, "\u232b"] },
      { keys: [msg("Backspace"), msg("Delete")], label: msg("Delete, as #") },
      { keys: ["!"], label: msg("Report spam"), mac: [SHIFT, CMD, "J"] },
      { keys: ["s"], label: msg("Flag or unflag"), mac: [SHIFT, CMD, "L"] },
      { keys: [msg("Shift"), "u"], label: msg("Mark unread") },
      { keys: [msg("Shift"), "i"], label: msg("Mark read") },
      { keys: [], label: msg("Mark read or unread"), mac: [SHIFT, CMD, "U"] },
      { keys: ["v"], label: msg("Move to\u2026"), mac: [CTRL, CMD, "M"] },
      { keys: ["b"], label: msg("Snooze") },
      { keys: ["l"], label: msg("Labels (Gmail)") },
      { keys: [";"], label: msg("Expand or collapse the conversation") },
      { keys: [msg("Shift"), "p"], label: msg("Print the conversation") },
      { keys: ["t"], label: msg("Translate, or show the original") },
      { keys: [msg("Shift"), "s"], label: msg("Summarize the conversation (AI)") },
      { keys: [msg("Shift"), "t"], label: msg("Find tasks in the conversation (AI)") },
      { keys: [msg("Shift"), "n"], label: msg("New BB thread from the message") },
      { keys: [msg("Shift"), "k"], label: msg("Make a task from the message") },
      { keys: ["z"], label: msg("Undo the last action"), mac: [CMD, "Z"] },
    ],
  },
  {
    title: msg("Writing"),
    entries: [
      { keys: ["c"], label: msg("Compose") },
      { keys: ["r"], label: msg("Reply"), mac: [CMD, "R"] },
      { keys: ["a"], label: msg("Reply all"), mac: [SHIFT, CMD, "R"] },
      { keys: ["f"], label: msg("Forward"), mac: [SHIFT, CMD, "F"] },
      { keys: ["Cmd/Ctrl", msg("Enter")], label: msg("Send (in the composer)"), mac: [SHIFT, CMD, "D"] },
      { keys: [msg("Esc")], label: msg("Close the composer") },
    ],
  },
];

/**
 * A keydown handler for the page root: runs `onCommand` for each hotkey (with
 * whether the key is held, which only the moves pass through) and
 * keeps the `g` sequence, which ends after G_SEQUENCE_MS or on the next key.
 * The platform is read once (a Mac gets the Command chords).
 */
export function useShortcuts(onCommand: (command: ShortcutCommand, repeat: boolean) => void) {
  const commandRef = useRef(onCommand);
  commandRef.current = onCommand;
  const gTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const platform = useRef<KeyPlatform | null>(null);
  platform.current ??= { mac: isMacPlatform() };

  const endSequence = useCallback(() => {
    if (gTimer.current !== null) clearTimeout(gTimer.current);
    gTimer.current = null;
  }, []);
  useEffect(() => endSequence, [endSequence]);

  return useCallback(
    (event: ReactKeyboardEvent<HTMLElement>) => {
      if (event.defaultPrevented) return;
      const afterG = gTimer.current !== null;
      const match = matchShortcut(event, afterG, platform.current ?? { mac: false });
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
