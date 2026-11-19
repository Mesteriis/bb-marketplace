// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  createDestructiveGuard,
  DESTRUCTIVE_GUARD_MS,
  HOST_RESERVED,
  isMacPlatform,
  isTypingTarget,
  keyZone,
  matchShortcut,
  SHORTCUT_SHEET,
  type KeyLike,
  type ShortcutCommand,
} from "./shortcuts.ts";

function key(overrides: Partial<KeyLike>): KeyLike {
  return {
    key: "",
    code: "",
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    target: document.body,
    ...overrides,
  };
}

describe("matchShortcut", () => {
  it("matches letters by the physical key, whatever the layout types", () => {
    expect(matchShortcut(key({ key: "о", code: "KeyJ" }), false)).toEqual({ kind: "next" });
    expect(matchShortcut(key({ key: "л", code: "KeyK" }), false)).toEqual({ kind: "previous" });
    expect(matchShortcut(key({ key: "у", code: "KeyE" }), false)).toEqual({ kind: "archive" });
    expect(matchShortcut(key({ key: "ч", code: "KeyX" }), false)).toEqual({ kind: "select" });
    expect(matchShortcut(key({ key: "г", code: "KeyU" }), false)).toEqual({ kind: "back" });
    expect(matchShortcut(key({ key: "Г", code: "KeyU", shiftKey: true }), false)).toEqual({
      kind: "mark_unread",
    });
    expect(matchShortcut(key({ key: "Ш", code: "KeyI", shiftKey: true }), false)).toEqual({
      kind: "mark_read",
    });
  });

  it("matches symbols by character, with the US position as fallback", () => {
    expect(matchShortcut(key({ key: "#", code: "Digit3", shiftKey: true }), false)).toEqual({ kind: "delete" });
    expect(matchShortcut(key({ key: "№", code: "Digit3", shiftKey: true }), false)).toEqual({ kind: "delete" });
    expect(matchShortcut(key({ key: "!", code: "Digit1", shiftKey: true }), false)).toEqual({ kind: "spam" });
    expect(matchShortcut(key({ key: "?", code: "Slash", shiftKey: true }), false)).toEqual({ kind: "sheet" });
    expect(matchShortcut(key({ key: ",", code: "Slash", shiftKey: true }), false)).toEqual({ kind: "sheet" });
    expect(matchShortcut(key({ key: "/", code: "Slash" }), false)).toEqual({ kind: "search" });
    expect(matchShortcut(key({ key: ".", code: "Slash" }), false)).toEqual({ kind: "search" });
  });

  it("starts and finishes g sequences", () => {
    expect(matchShortcut(key({ key: "п", code: "KeyG" }), false)).toEqual({ kind: "g" });
    expect(matchShortcut(key({ key: "ш", code: "KeyI" }), true)).toEqual({ kind: "go", target: "inbox" });
    expect(matchShortcut(key({ key: "a", code: "KeyA" }), true)).toEqual({ kind: "go", target: "all" });
    // Without a g first, `a` is Reply all.
    expect(matchShortcut(key({ key: "a", code: "KeyA" }), false)).toEqual({ kind: "reply_all" });
  });

  it("matches c, r, a and f by the physical key on a Cyrillic layout", () => {
    expect(matchShortcut(key({ key: "с", code: "KeyC" }), false)).toEqual({ kind: "compose" });
    expect(matchShortcut(key({ key: "к", code: "KeyR" }), false)).toEqual({ kind: "reply" });
    expect(matchShortcut(key({ key: "ф", code: "KeyA" }), false)).toEqual({ kind: "reply_all" });
    expect(matchShortcut(key({ key: "а", code: "KeyF" }), false)).toEqual({ kind: "forward" });
    // A layout that types a Latin letter on another key does not move the binding.
    expect(matchShortcut(key({ key: "c", code: "KeyX" }), false)).toEqual({ kind: "select" });
  });

  it("ignores c, r, a and f while typing, in the editor and in the composer", () => {
    const input = document.createElement("input");
    const editor = document.createElement("div");
    editor.setAttribute("contenteditable", "true");
    const paragraph = document.createElement("p");
    editor.append(paragraph);
    const composer = document.createElement("section");
    composer.setAttribute("data-mail-composer", "");
    const toolButton = document.createElement("button");
    composer.append(toolButton);
    document.body.append(editor, composer);
    for (const target of [input, paragraph, toolButton]) {
      for (const code of ["KeyC", "KeyR", "KeyA", "KeyF", "KeyE"]) {
        expect(matchShortcut(key({ key: "x", code, target }), false)).toBeNull();
      }
    }
    editor.remove();
    composer.remove();
  });

  it("t translates by the physical key (Cyrillic layout too), and g t still goes to Trash", () => {
    expect(matchShortcut(key({ key: "t", code: "KeyT" }), false)).toEqual({ kind: "translate" });
    expect(matchShortcut(key({ key: "е", code: "KeyT" }), false)).toEqual({ kind: "translate" });
    expect(matchShortcut(key({ key: "е", code: "KeyT" }), true)).toEqual({ kind: "go", target: "trash" });
    expect(matchShortcut(key({ key: "T", code: "KeyT", shiftKey: true }), false)).toEqual({ kind: "find_tasks" });
  });

  it("Shift+N starts a BB thread, Shift+K makes a task and g n goes to Dev, by the physical key; never while typing (slice 3g)", () => {
    expect(matchShortcut(key({ key: "N", code: "KeyN", shiftKey: true }), false)).toEqual({ kind: "new_bb_thread" });
    expect(matchShortcut(key({ key: "\u0422", code: "KeyN", shiftKey: true }), false)).toEqual({ kind: "new_bb_thread" });
    expect(matchShortcut(key({ key: "\u041b", code: "KeyK", shiftKey: true }), false)).toEqual({ kind: "make_task" });
    expect(matchShortcut(key({ key: "\u0442", code: "KeyN" }), true)).toEqual({ kind: "go", target: "dev" });
    // k alone still moves up; n alone is nothing.
    expect(matchShortcut(key({ key: "k", code: "KeyK" }), false)).toEqual({ kind: "previous" });
    expect(matchShortcut(key({ key: "n", code: "KeyN" }), false)).toBeNull();
    const input = document.createElement("input");
    document.body.append(input);
    expect(matchShortcut(key({ key: "N", code: "KeyN", shiftKey: true, target: input }), false)).toBeNull();
    expect(matchShortcut(key({ key: "K", code: "KeyK", shiftKey: true, target: input }), false)).toBeNull();
    input.remove();
    const labels = SHORTCUT_SHEET.flatMap((section) => section.entries.map((entry) => entry.keys.join(" ")));
    expect(labels).toEqual(expect.arrayContaining(["Shift n", "Shift k", "g n"]));
  });

  it("Shift+S summarizes and Shift+T finds tasks by the physical key (Cyrillic layout too); never while typing (slice 3f)", () => {
    expect(matchShortcut(key({ key: "S", code: "KeyS", shiftKey: true }), false)).toEqual({ kind: "summarize" });
    expect(matchShortcut(key({ key: "\u042b", code: "KeyS", shiftKey: true }), false)).toEqual({ kind: "summarize" });
    expect(matchShortcut(key({ key: "\u0415", code: "KeyT", shiftKey: true }), false)).toEqual({ kind: "find_tasks" });
    // s alone still flags.
    expect(matchShortcut(key({ key: "s", code: "KeyS" }), false)).toEqual({ kind: "flag" });
    expect(matchShortcut(key({ key: "S", code: "KeyS", shiftKey: true, metaKey: true }), false)).toBeNull();
    const input = document.createElement("input");
    const editor = document.createElement("div");
    editor.setAttribute("contenteditable", "true");
    document.body.append(input, editor);
    for (const target of [input, editor]) {
      expect(matchShortcut(key({ key: "S", code: "KeyS", shiftKey: true, target }), false)).toBeNull();
      expect(matchShortcut(key({ key: "T", code: "KeyT", shiftKey: true, target }), false)).toBeNull();
    }
    input.remove();
    editor.remove();
    const labels = SHORTCUT_SHEET.flatMap((section) => section.entries.map((entry) => entry.label));
    expect(labels).toContain("Summarize the conversation (AI)");
    expect(labels).toContain("Find tasks in the conversation (AI)");
  });

  it("t is never a hotkey while typing", () => {
    const input = document.createElement("input");
    const editor = document.createElement("div");
    editor.setAttribute("contenteditable", "true");
    document.body.append(input, editor);
    for (const target of [input, editor]) {
      expect(matchShortcut(key({ key: "t", code: "KeyT", target }), false)).toBeNull();
    }
    input.remove();
    editor.remove();
  });

  it("z undoes by the physical key (Cyrillic layout too); Mod+Z and Shift+Z are not ours; never while typing", () => {
    expect(matchShortcut(key({ key: "z", code: "KeyZ" }), false)).toEqual({ kind: "undo" });
    expect(matchShortcut(key({ key: "я", code: "KeyZ" }), false)).toEqual({ kind: "undo" });
    expect(matchShortcut(key({ key: "z", code: "KeyZ", metaKey: true }), false)).toBeNull();
    expect(matchShortcut(key({ key: "z", code: "KeyZ", ctrlKey: true }), false)).toBeNull();
    expect(matchShortcut(key({ key: "Z", code: "KeyZ", shiftKey: true }), false)).toBeNull();
    expect(matchShortcut(key({ key: "z", code: "KeyZ", repeat: true }), false)).toBeNull();
    const input = document.createElement("input");
    document.body.append(input);
    expect(matchShortcut(key({ key: "z", code: "KeyZ", target: input }), false)).toBeNull();
    input.remove();
    const entries = SHORTCUT_SHEET.flatMap((section) => section.entries);
    expect(entries.find((entry) => entry.keys.join(" ") === "z")?.label).toBe("Undo the last action");
  });

  it("b snoozes by the physical key (Cyrillic layout too); never with a modifier or while typing", () => {
    expect(matchShortcut(key({ key: "b", code: "KeyB" }), false)).toEqual({ kind: "snooze" });
    expect(matchShortcut(key({ key: "\u0438", code: "KeyB" }), false)).toEqual({ kind: "snooze" });
    expect(matchShortcut(key({ key: "b", code: "KeyB", metaKey: true }), false)).toBeNull();
    expect(matchShortcut(key({ key: "B", code: "KeyB", shiftKey: true }), false)).toBeNull();
    expect(matchShortcut(key({ key: "b", code: "KeyB", repeat: true }), false)).toBeNull();
    const input = document.createElement("input");
    document.body.append(input);
    expect(matchShortcut(key({ key: "b", code: "KeyB", target: input }), false)).toBeNull();
    input.remove();
    const entries = SHORTCUT_SHEET.flatMap((section) => section.entries);
    expect(entries.find((entry) => entry.keys.join(" ") === "b")?.label).toBe("Snooze");
  });

  it("the sheet lists t", () => {
    const entries = SHORTCUT_SHEET.flatMap((section) => section.entries);
    expect(entries.find((entry) => entry.keys.join(" ") === "t")?.label).toBe("Translate, or show the original");
  });

  it("ignores Ctrl, Alt and Meta, and IME composition", () => {
    expect(matchShortcut(key({ key: "j", code: "KeyJ", ctrlKey: true }), false)).toBeNull();
    expect(matchShortcut(key({ key: "j", code: "KeyJ", altKey: true }), false)).toBeNull();
    expect(matchShortcut(key({ key: "j", code: "KeyJ", metaKey: true }), false)).toBeNull();
    expect(matchShortcut(key({ key: "j", code: "KeyJ", isComposing: true }), false)).toBeNull();
  });

  it("repeats only j and k while a key is held", () => {
    expect(matchShortcut(key({ key: "j", code: "KeyJ", repeat: true }), false)).toEqual({ kind: "next" });
    expect(matchShortcut(key({ key: "k", code: "KeyK", repeat: true }), false)).toEqual({ kind: "previous" });
    expect(matchShortcut(key({ key: "#", code: "Digit3", shiftKey: true, repeat: true }), false)).toBeNull();
    expect(matchShortcut(key({ key: "s", code: "KeyS", repeat: true }), false)).toBeNull();
    expect(matchShortcut(key({ key: "g", code: "KeyG", repeat: true }), false)).toBeNull();
    expect(matchShortcut(key({ key: "i", code: "KeyI", repeat: true }), true)).toBeNull();
  });

  it("leaves Enter on a summary to the summary", () => {
    const summary = document.createElement("summary");
    expect(matchShortcut(key({ key: "Enter", code: "Enter", target: summary }), false)).toBeNull();
  });

  it("leaves Enter on a button to the button", () => {
    const button = document.createElement("button");
    expect(matchShortcut(key({ key: "Enter", code: "Enter", target: button }), false)).toBeNull();
    expect(matchShortcut(key({ key: "Enter", code: "Enter" }), false)).toEqual({ kind: "open" });
  });
});

describe("slice 3h keys", () => {
  it("g f goes to Files and l opens Labels, by the physical key; f alone still forwards", () => {
    expect(matchShortcut(key({ key: "f", code: "KeyF" }), true)).toEqual({ kind: "go", target: "files" });
    expect(matchShortcut(key({ key: "\u0430", code: "KeyF" }), true)).toEqual({ kind: "go", target: "files" });
    expect(matchShortcut(key({ key: "f", code: "KeyF" }), false)).toEqual({ kind: "forward" });
    expect(matchShortcut(key({ key: "l", code: "KeyL" }), false)).toEqual({ kind: "labels" });
    expect(matchShortcut(key({ key: "\u0434", code: "KeyL" }), false)).toEqual({ kind: "labels" });
    const input = document.createElement("input");
    document.body.append(input);
    expect(matchShortcut(key({ key: "l", code: "KeyL", target: input }), false)).toBeNull();
    input.remove();
    const labels = SHORTCUT_SHEET.flatMap((section) => section.entries.map((entry) => entry.keys.join(" ")));
    expect(labels).toEqual(expect.arrayContaining(["g f", "l"]));
  });

  it("] and [ walk the Inbox tabs, by position on another layout, never with Shift or while typing", () => {
    expect(matchShortcut(key({ key: "]", code: "BracketRight" }), false)).toEqual({ kind: "tab_next" });
    expect(matchShortcut(key({ key: "[", code: "BracketLeft" }), false)).toEqual({ kind: "tab_previous" });
    expect(matchShortcut(key({ key: "\u044a", code: "BracketRight" }), false)).toEqual({ kind: "tab_next" });
    expect(matchShortcut(key({ key: "\u0445", code: "BracketLeft" }), false)).toEqual({ kind: "tab_previous" });
    expect(matchShortcut(key({ key: "}", code: "BracketRight", shiftKey: true }), false)).toBeNull();
    expect(matchShortcut(key({ key: "{", code: "BracketLeft", shiftKey: true }), false)).toBeNull();
    const input = document.createElement("input");
    document.body.append(input);
    expect(matchShortcut(key({ key: "]", code: "BracketRight", target: input }), false)).toBeNull();
    input.remove();
    expect(SHORTCUT_SHEET.flatMap((section) => section.entries.map((entry) => entry.keys.join(" ")))).toContain("] [");
  });

  it("; toggles the conversation and Shift+P prints, never while typing", () => {
    expect(matchShortcut(key({ key: ";", code: "Semicolon" }), false)).toEqual({ kind: "expand_all" });
    expect(matchShortcut(key({ key: "\u0436", code: "Semicolon" }), false)).toEqual({ kind: "expand_all" });
    expect(matchShortcut(key({ key: "P", code: "KeyP", shiftKey: true }), false)).toEqual({ kind: "print" });
    expect(matchShortcut(key({ key: "p", code: "KeyP" }), false)).toBeNull();
    const input = document.createElement("textarea");
    document.body.append(input);
    expect(matchShortcut(key({ key: "P", code: "KeyP", shiftKey: true, target: input }), false)).toBeNull();
    input.remove();
    const labels = SHORTCUT_SHEET.flatMap((section) => section.entries.map((entry) => entry.keys.join(" ")));
    expect(labels).toEqual(expect.arrayContaining([";", "Shift p"]));
  });
});

describe("isTypingTarget", () => {
  it("is true in fields, editable content and dialogs", () => {
    const input = document.createElement("input");
    const textarea = document.createElement("textarea");
    const select = document.createElement("select");
    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "true");
    const inner = document.createElement("span");
    editable.append(inner);
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    const dialogButton = document.createElement("button");
    dialog.append(dialogButton);
    const combobox = document.createElement("button");
    combobox.setAttribute("role", "combobox");
    const option = document.createElement("div");
    option.setAttribute("role", "option");
    const menuItem = document.createElement("div");
    menuItem.setAttribute("role", "menuitem");
    document.body.append(editable, dialog);

    for (const target of [input, textarea, select, inner, dialogButton, combobox, option, menuItem]) {
      expect(isTypingTarget(target)).toBe(true);
    }
    expect(isTypingTarget(document.createElement("button"))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
    editable.remove();
    dialog.remove();
  });
});

describe("createDestructiveGuard", () => {
  function clock() {
    let t = 1_000;
    return { now: () => t, advance: (ms: number) => (t += ms) };
  }
  /** A keydown on a Cyrillic layout, matched by its physical key. */
  function press(code: string, keyChar: string, shiftKey = false): ShortcutCommand {
    const match = matchShortcut(key({ key: keyChar, code, shiftKey }), false);
    if (match === null || match.kind === "g") throw new Error(`no command for ${code}`);
    return match;
  }

  it("lets a second tap of e, #, ! or v within the window do nothing", () => {
    expect(DESTRUCTIVE_GUARD_MS).toBe(400);
    for (const [code, char, shift] of [
      ["KeyE", "у", false],
      ["Digit3", "№", true],
      ["Digit1", "!", true],
      ["KeyV", "м", false],
    ] as const) {
      const c = clock();
      const guard = createDestructiveGuard(c.now);
      const command = press(code, char, shift);
      expect(guard.admit(command)).toBe(true);
      guard.ran();
      c.advance(150);
      expect(guard.admit(command)).toBe(false);
    }
  });

  it("blocks any destructive key after another one ran, not only the same key", () => {
    const c = clock();
    const guard = createDestructiveGuard(c.now);
    expect(guard.admit(press("KeyE", "у"))).toBe(true);
    guard.ran();
    c.advance(100);
    expect(guard.admit(press("Digit3", "№", true))).toBe(false);
  });

  it("acts again once the window has passed", () => {
    const c = clock();
    const guard = createDestructiveGuard(c.now);
    guard.ran();
    c.advance(DESTRUCTIVE_GUARD_MS);
    expect(guard.admit(press("Digit3", "№", true))).toBe(true);
  });

  it("keeps a run of quick taps quiet until the taps stop", () => {
    const c = clock();
    const guard = createDestructiveGuard(c.now);
    guard.ran();
    c.advance(300);
    expect(guard.admit(press("KeyE", "у"))).toBe(false);
    c.advance(300);
    expect(guard.admit(press("KeyE", "у"))).toBe(false);
    c.advance(DESTRUCTIVE_GUARD_MS);
    expect(guard.admit(press("KeyE", "у"))).toBe(true);
  });

  it("never holds back j, k, r, a, f, c, x, s or ?", () => {
    const c = clock();
    const guard = createDestructiveGuard(c.now);
    guard.ran();
    c.advance(10);
    for (const [code, char, shift] of [
      ["KeyJ", "о", false],
      ["KeyK", "л", false],
      ["KeyR", "к", false],
      ["KeyA", "ф", false],
      ["KeyF", "а", false],
      ["KeyC", "с", false],
      ["KeyX", "ч", false],
      ["KeyS", "ы", false],
      ["Slash", ",", true],
    ] as const) {
      expect(guard.admit(press(code, char, shift))).toBe(true);
    }
  });

  it("ends the window on a non-destructive key: j then e is a choice", () => {
    const c = clock();
    const guard = createDestructiveGuard(c.now);
    guard.ran();
    c.advance(50);
    expect(guard.admit(press("KeyJ", "о"))).toBe(true);
    c.advance(50);
    expect(guard.admit(press("KeyE", "у"))).toBe(true);
  });

  it("does not block the first destructive key when nothing ran yet", () => {
    const guard = createDestructiveGuard(clock().now);
    expect(guard.admit({ kind: "delete" })).toBe(true);
    expect(guard.admit({ kind: "delete" })).toBe(true);
  });
});

describe("slice 3i part B: Apple Mail keys", () => {
  const MAC = { mac: true };
  const PC = { mac: false };
  /** A Cyrillic letter, built at run time so no tool turns an escape into a raw character. */
  const cyr = (code: number) => String.fromCharCode(code);
  function inside(selector: string): { target: HTMLElement; remove: () => void } {
    const outer = document.createElement("div");
    const [name, value] = selector.replace(/^\[|\]$/g, "").split("=");
    outer.setAttribute(name!, value === undefined ? "" : value.replace(/"/g, ""));
    const target = document.createElement("button");
    outer.append(target);
    document.body.append(outer);
    return { target, remove: () => outer.remove() };
  }

  it("arrows in the page zone are next/previous with arrow: true; j and k carry no arrow", () => {
    expect(matchShortcut(key({ key: "ArrowDown", code: "ArrowDown" }), false)).toEqual({ kind: "next", arrow: true });
    expect(matchShortcut(key({ key: "ArrowUp", code: "ArrowUp" }), false)).toEqual({ kind: "previous", arrow: true });
    expect(matchShortcut(key({ key: "j", code: "KeyJ" }), false)).toEqual({ kind: "next" });
    expect(matchShortcut(key({ key: "k", code: "KeyK" }), false)).toEqual({ kind: "previous" });
  });

  it("arrows on a message header or the stack move between messages; inside the reading zone they stay native", () => {
    for (const selector of ["[data-mail-message-toggle]", "[data-mail-stack]"]) {
      const { target, remove } = inside(selector);
      expect(matchShortcut(key({ key: "ArrowDown", code: "ArrowDown", target }), false)).toEqual({ kind: "message_next" });
      expect(matchShortcut(key({ key: "ArrowUp", code: "ArrowUp", target }), false)).toEqual({ kind: "message_previous" });
      remove();
    }
    const reading = inside("[data-mail-reading]");
    expect(matchShortcut(key({ key: "ArrowDown", code: "ArrowDown", target: reading.target }), false)).toBeNull();
    expect(matchShortcut(key({ key: "ArrowUp", code: "ArrowUp", target: reading.target }), false)).toBeNull();
    expect(matchShortcut(key({ key: "ArrowDown", code: "ArrowDown", shiftKey: true, target: reading.target }), false)).toBeNull();
    // Letters still work in the reading zone.
    expect(matchShortcut(key({ key: "j", code: "KeyJ", target: reading.target }), false)).toEqual({ kind: "next" });
    reading.remove();
  });

  it("keyZone names the zone of a target", () => {
    const header = inside("[data-mail-message-toggle]");
    const reading = inside("[data-mail-reading]");
    const input = document.createElement("input");
    expect(keyZone(header.target)).toBe("header");
    expect(keyZone(reading.target)).toBe("reading");
    expect(keyZone(input)).toBe("typing");
    expect(keyZone(document.body)).toBe("page");
    expect(keyZone(null)).toBe("page");
    header.remove();
    reading.remove();
  });

  it("arrows inside an element that owns arrow keys are left to it", () => {
    for (const role of ["tablist", "radiogroup", "slider", "spinbutton", "tree", "grid", "toolbar"]) {
      const { target, remove } = inside(`[role="${role}"]`);
      expect(matchShortcut(key({ key: "ArrowDown", code: "ArrowDown", target }), false)).toBeNull();
      expect(matchShortcut(key({ key: "ArrowUp", code: "ArrowUp", shiftKey: true, target }), false)).toBeNull();
      // Letters are not arrows: j still moves.
      expect(matchShortcut(key({ key: "j", code: "KeyJ", target }), false)).toEqual({ kind: "next" });
      remove();
    }
  });

  it("Shift+arrows extend the selection", () => {
    expect(matchShortcut(key({ key: "ArrowDown", code: "ArrowDown", shiftKey: true }), false)).toEqual({ kind: "select_down" });
    expect(matchShortcut(key({ key: "ArrowUp", code: "ArrowUp", shiftKey: true }), false)).toEqual({ kind: "select_up" });
  });

  it("held arrows and Shift+arrows repeat; held Backspace, Delete and chords do not", () => {
    expect(matchShortcut(key({ key: "ArrowDown", code: "ArrowDown", repeat: true }), false)).toEqual({ kind: "next", arrow: true });
    expect(matchShortcut(key({ key: "ArrowDown", code: "ArrowDown", shiftKey: true, repeat: true }), false)).toEqual({ kind: "select_down" });
    const header = inside("[data-mail-message-toggle]");
    expect(matchShortcut(key({ key: "ArrowUp", code: "ArrowUp", repeat: true, target: header.target }), false)).toEqual({ kind: "message_previous" });
    header.remove();
    expect(matchShortcut(key({ key: "Backspace", code: "Backspace", repeat: true }), false)).toBeNull();
    expect(matchShortcut(key({ key: "Delete", code: "Delete", repeat: true }), false)).toBeNull();
    expect(matchShortcut(key({ key: "r", code: "KeyR", metaKey: true, repeat: true }), false, MAC)).toBeNull();
    expect(matchShortcut(key({ key: "Backspace", code: "Backspace", metaKey: true, repeat: true }), false, MAC)).toBeNull();
  });

  it("Backspace and Delete delete, on every platform", () => {
    expect(matchShortcut(key({ key: "Backspace", code: "Backspace" }), false)).toEqual({ kind: "delete" });
    expect(matchShortcut(key({ key: "Delete", code: "Delete" }), false)).toEqual({ kind: "delete" });
    expect(matchShortcut(key({ key: "Backspace", code: "Backspace" }), false, PC)).toEqual({ kind: "delete" });
    // With Shift, Ctrl or Alt it is not ours.
    expect(matchShortcut(key({ key: "Backspace", code: "Backspace", shiftKey: true }), false)).toBeNull();
    expect(matchShortcut(key({ key: "Backspace", code: "Backspace", ctrlKey: true }), false)).toBeNull();
    expect(matchShortcut(key({ key: "Delete", code: "Delete", altKey: true }), false, MAC)).toBeNull();
  });

  it("Backspace, Delete, arrows and chords never act in a field, the composer, a dialog, a textbox or a select's list", () => {
    const input = document.createElement("input");
    const textarea = document.createElement("textarea");
    const editable = inside('[contenteditable="true"]');
    const composer = inside("[data-mail-composer]");
    const dialog = inside('[role="dialog"]');
    const textbox = inside('[role="textbox"]');
    const listbox = inside('[role="listbox"]');
    const menu = inside('[role="menu"]');
    const select = document.createElement("select");
    document.body.append(input, textarea, select);
    for (const target of [input, textarea, select, editable.target, composer.target, dialog.target, textbox.target, listbox.target, menu.target]) {
      for (const platform of [MAC, PC]) {
        expect(matchShortcut(key({ key: "Backspace", code: "Backspace", target }), false, platform)).toBeNull();
        expect(matchShortcut(key({ key: "Delete", code: "Delete", target }), false, platform)).toBeNull();
        expect(matchShortcut(key({ key: "ArrowDown", code: "ArrowDown", target }), false, platform)).toBeNull();
        expect(matchShortcut(key({ key: "ArrowDown", code: "ArrowDown", shiftKey: true, target }), false, platform)).toBeNull();
      }
      expect(matchShortcut(key({ key: "r", code: "KeyR", metaKey: true, target }), false, MAC)).toBeNull();
      expect(matchShortcut(key({ key: "Backspace", code: "Backspace", metaKey: true, target }), false, MAC)).toBeNull();
      expect(matchShortcut(key({ key: "z", code: "KeyZ", metaKey: true, target }), false, MAC)).toBeNull();
      expect(matchShortcut(key({ key: "a", code: "KeyA", metaKey: true, ctrlKey: true, target }), false, MAC)).toBeNull();
    }
    input.remove();
    textarea.remove();
    select.remove();
    for (const holder of [editable, composer, dialog, textbox, listbox, menu]) holder.remove();
  });

  it("nothing acts during IME composition: isComposing, key Process, keyCode 229", () => {
    for (const ime of [{ isComposing: true }, { key: "Process" }, { keyCode: 229 }]) {
      expect(matchShortcut(key({ key: "Backspace", code: "Backspace", ...ime }), false, MAC)).toBeNull();
      expect(matchShortcut(key({ key: "ArrowDown", code: "ArrowDown", ...ime }), false, MAC)).toBeNull();
      expect(matchShortcut(key({ key: "j", code: "KeyJ", ...ime }), false, MAC)).toBeNull();
      expect(matchShortcut(key({ key: "r", code: "KeyR", metaKey: true, ...ime }), false, MAC)).toBeNull();
    }
  });

  it("Mac chords match the physical key on a Russian layout", () => {
    const chords: [Partial<KeyLike>, ShortcutCommand][] = [
      [{ key: cyr(0x043a), code: "KeyR", metaKey: true }, { kind: "reply" }],
      [{ key: cyr(0x041a), code: "KeyR", metaKey: true, shiftKey: true }, { kind: "reply_all" }],
      [{ key: cyr(0x0410), code: "KeyF", metaKey: true, shiftKey: true }, { kind: "forward" }],
      [{ key: cyr(0x0424), code: "KeyA", metaKey: true, ctrlKey: true }, { kind: "archive" }],
      [{ key: cyr(0x041e), code: "KeyJ", metaKey: true, shiftKey: true }, { kind: "spam" }],
      [{ key: cyr(0x0413), code: "KeyU", metaKey: true, shiftKey: true }, { kind: "toggle_read" }],
      [{ key: cyr(0x0414), code: "KeyL", metaKey: true, shiftKey: true }, { kind: "flag" }],
      [{ key: cyr(0x0430), code: "KeyF", metaKey: true, altKey: true }, { kind: "search" }],
      [{ key: cyr(0x044c), code: "KeyM", metaKey: true, ctrlKey: true }, { kind: "move" }],
      [{ key: cyr(0x044f), code: "KeyZ", metaKey: true }, { kind: "undo" }],
      [{ key: "Backspace", code: "Backspace", metaKey: true }, { kind: "delete" }],
    ];
    for (const [init, command] of chords) {
      expect(matchShortcut(key(init), false, MAC)).toEqual(command);
      // Not on Windows or Linux, and never with Ctrl in place of Command.
      expect(matchShortcut(key(init), false, PC)).toBeNull();
      expect(matchShortcut(key({ ...init, metaKey: false, ctrlKey: true }), false, MAC)).toBeNull();
      expect(matchShortcut(key({ ...init, metaKey: false, ctrlKey: true }), false, PC)).toBeNull();
    }
  });

  it("a chord with an extra modifier is not ours", () => {
    expect(matchShortcut(key({ key: "r", code: "KeyR", metaKey: true, altKey: true }), false, MAC)).toBeNull();
    expect(matchShortcut(key({ key: "r", code: "KeyR", metaKey: true, ctrlKey: true }), false, MAC)).toBeNull();
    expect(matchShortcut(key({ key: "a", code: "KeyA", metaKey: true, ctrlKey: true, shiftKey: true }), false, MAC)).toBeNull();
    expect(matchShortcut(key({ key: "z", code: "KeyZ", metaKey: true, shiftKey: true }), false, MAC)).toBeNull();
    expect(matchShortcut(key({ key: "f", code: "KeyF", metaKey: true, altKey: true, shiftKey: true }), false, MAC)).toBeNull();
    // A plain letter with Command is not the letter's Gmail command.
    expect(matchShortcut(key({ key: "e", code: "KeyE", metaKey: true }), false, MAC)).toBeNull();
    expect(matchShortcut(key({ key: "j", code: "KeyJ", metaKey: true }), false, MAC)).toBeNull();
    expect(matchShortcut(key({ key: "ArrowDown", code: "ArrowDown", metaKey: true }), false, MAC)).toBeNull();
  });

  it("never takes a chord BB owns", () => {
    expect(HOST_RESERVED.length).toBeGreaterThan(20);
    for (const chord of HOST_RESERVED) {
      const init = {
        key: chord.code,
        code: chord.code,
        metaKey: chord.meta === true,
        shiftKey: chord.shift === true,
        ctrlKey: chord.ctrl === true,
        altKey: chord.alt === true,
      };
      expect(matchShortcut(key(init), false, MAC), chord.keys.join("")).toBeNull();
      expect(matchShortcut(key(init), false, PC), chord.keys.join("")).toBeNull();
    }
    const named = HOST_RESERVED.map((chord) => chord.keys.join(""));
    // The owner's list: these never become Mail keys.
    for (const code of ["KeyN", "KeyF", "KeyP", "KeyK", "KeyJ", "KeyW", "KeyT", "KeyO", "BracketLeft", "BracketRight"]) {
      expect(HOST_RESERVED.some((chord) => chord.code === code && chord.meta === true && chord.shift !== true && chord.ctrl !== true && chord.alt !== true)).toBe(true);
    }
    for (const digit of ["1", "2", "3", "4", "5", "6", "7", "8", "9"]) {
      expect(HOST_RESERVED.some((chord) => chord.code === `Digit${digit}` && chord.meta === true)).toBe(true);
    }
    expect(HOST_RESERVED.some((chord) => chord.code === "KeyN" && chord.meta === true && chord.shift === true)).toBe(true);
    expect(HOST_RESERVED.some((chord) => chord.code === "KeyS" && chord.meta === true && chord.ctrl === true)).toBe(true);
    expect(HOST_RESERVED.some((chord) => chord.code === "Escape")).toBe(true);
    // No sheet entry offers a BB chord as an Apple key.
    for (const entry of SHORTCUT_SHEET.flatMap((section) => section.entries)) {
      if (entry.mac !== undefined) expect(named).not.toContain(entry.mac.join(""));
    }
  });

  it("the sheet lists the arrows, Shift+arrows, Backspace/Delete and the Apple chords", () => {
    const entries = SHORTCUT_SHEET.flatMap((section) => section.entries);
    const byKeys = (keys: string) => entries.filter((entry) => entry.keys.join(" ") === keys).map((entry) => entry.label);
    const down = String.fromCharCode(0x2193);
    const up = String.fromCharCode(0x2191);
    expect(byKeys(`${down} ${up}`).length).toBe(2);
    expect(byKeys(`Shift ${down}`).length).toBe(1);
    expect(byKeys(`Shift ${up}`).length).toBe(1);
    expect(byKeys("Backspace Delete").length).toBe(1);
    const cmd = String.fromCharCode(0x2318);
    const macOf = (label: string) => entries.find((entry) => entry.label === label)?.mac?.join("");
    expect(macOf("Reply")).toBe(`${cmd}R`);
    expect(macOf("Undo the last action")).toBe(`${cmd}Z`);
    expect(macOf("Archive")).toBe(`${String.fromCharCode(0x2303)}${cmd}A`);
    // Every chord matchShortcut binds is on the sheet, and nothing else is.
    const macChords = entries.flatMap((entry) => (entry.mac === undefined ? [] : [entry.mac.join("")]));
    expect(macChords.sort()).toEqual(
      [
        `${cmd}R`,
        `${String.fromCharCode(0x21e7)}${cmd}R`,
        `${String.fromCharCode(0x21e7)}${cmd}F`,
        `${String.fromCharCode(0x2303)}${cmd}A`,
        `${String.fromCharCode(0x21e7)}${cmd}J`,
        `${String.fromCharCode(0x21e7)}${cmd}U`,
        `${String.fromCharCode(0x21e7)}${cmd}L`,
        `${String.fromCharCode(0x2325)}${cmd}F`,
        `${String.fromCharCode(0x2303)}${cmd}M`,
        `${cmd}Z`,
        `${cmd}${String.fromCharCode(0x232b)}`,
        // Slice 3i: the composer's Shift+Command+D.
        `${String.fromCharCode(0x21e7)}${cmd}D`,
      ].sort(),
    );
  });

  it("isMacPlatform reads the platform name", () => {
    expect(isMacPlatform("MacIntel")).toBe(true);
    expect(isMacPlatform("macOS")).toBe(true);
    expect(isMacPlatform("iPad")).toBe(true);
    expect(isMacPlatform("Win32")).toBe(false);
    expect(isMacPlatform("Linux x86_64")).toBe(false);
    expect(typeof isMacPlatform()).toBe("boolean");
  });
});
