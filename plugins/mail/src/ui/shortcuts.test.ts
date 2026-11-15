// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { isTypingTarget, matchShortcut, type KeyLike } from "./shortcuts.ts";

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
    // Without a g first, `a` is reserved for Reply all and does nothing yet.
    expect(matchShortcut(key({ key: "a", code: "KeyA" }), false)).toBeNull();
    expect(matchShortcut(key({ key: "r", code: "KeyR" }), false)).toBeNull();
  });

  it("ignores Ctrl, Alt and Meta, and IME composition", () => {
    expect(matchShortcut(key({ key: "j", code: "KeyJ", ctrlKey: true }), false)).toBeNull();
    expect(matchShortcut(key({ key: "j", code: "KeyJ", altKey: true }), false)).toBeNull();
    expect(matchShortcut(key({ key: "j", code: "KeyJ", metaKey: true }), false)).toBeNull();
    expect(matchShortcut(key({ key: "j", code: "KeyJ", isComposing: true }), false)).toBeNull();
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
    document.body.append(editable, dialog);

    for (const target of [input, textarea, select, inner, dialogButton]) {
      expect(isTypingTarget(target)).toBe(true);
    }
    expect(isTypingTarget(document.createElement("button"))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
    editable.remove();
    dialog.remove();
  });
});
