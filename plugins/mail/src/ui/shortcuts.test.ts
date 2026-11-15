// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  createDestructiveGuard,
  DESTRUCTIVE_GUARD_MS,
  isTypingTarget,
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
    expect(matchShortcut(key({ key: "T", code: "KeyT", shiftKey: true }), false)).toBeNull();
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
