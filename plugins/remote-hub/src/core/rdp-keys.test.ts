import { describe, expect, it } from "vitest";
import { codeToScancode } from "./rdp-keys.ts";

describe("rdp-keys codeToScancode", () => {
  it("maps the contract's literal examples", () => {
    expect(codeToScancode("KeyA")).toEqual({ scancode: 0x1e, extended: false });
    expect(codeToScancode("ArrowLeft")).toEqual({ scancode: 0x4b, extended: true });
    expect(codeToScancode("ControlRight")).toEqual({ scancode: 0x1d, extended: true });
    expect(codeToScancode("Delete")).toEqual({ scancode: 0x53, extended: true });
  });

  it("maps every US letter to its set-1 scancode", () => {
    const expected: Record<string, number> = {
      KeyQ: 0x10, KeyW: 0x11, KeyE: 0x12, KeyR: 0x13, KeyT: 0x14, KeyY: 0x15,
      KeyU: 0x16, KeyI: 0x17, KeyO: 0x18, KeyP: 0x19,
      KeyA: 0x1e, KeyS: 0x1f, KeyD: 0x20, KeyF: 0x21, KeyG: 0x22, KeyH: 0x23,
      KeyJ: 0x24, KeyK: 0x25, KeyL: 0x26,
      KeyZ: 0x2c, KeyX: 0x2d, KeyC: 0x2e, KeyV: 0x2f, KeyB: 0x30, KeyN: 0x31,
      KeyM: 0x32,
    };
    for (const [code, scancode] of Object.entries(expected)) {
      expect(codeToScancode(code), code).toEqual({ scancode, extended: false });
    }
  });

  it("maps digits, punctuation, function and modifier keys", () => {
    expect(codeToScancode("Digit1")).toEqual({ scancode: 0x02, extended: false });
    expect(codeToScancode("Digit9")).toEqual({ scancode: 0x0a, extended: false });
    expect(codeToScancode("Digit0")).toEqual({ scancode: 0x0b, extended: false });
    expect(codeToScancode("Minus")).toEqual({ scancode: 0x0c, extended: false });
    expect(codeToScancode("Equal")).toEqual({ scancode: 0x0d, extended: false });
    expect(codeToScancode("BracketLeft")).toEqual({ scancode: 0x1a, extended: false });
    expect(codeToScancode("BracketRight")).toEqual({ scancode: 0x1b, extended: false });
    expect(codeToScancode("Semicolon")).toEqual({ scancode: 0x27, extended: false });
    expect(codeToScancode("Quote")).toEqual({ scancode: 0x28, extended: false });
    expect(codeToScancode("Backquote")).toEqual({ scancode: 0x29, extended: false });
    expect(codeToScancode("Backslash")).toEqual({ scancode: 0x2b, extended: false });
    expect(codeToScancode("Comma")).toEqual({ scancode: 0x33, extended: false });
    expect(codeToScancode("Period")).toEqual({ scancode: 0x34, extended: false });
    expect(codeToScancode("Slash")).toEqual({ scancode: 0x35, extended: false });
    expect(codeToScancode("F1")).toEqual({ scancode: 0x3b, extended: false });
    expect(codeToScancode("F12")).toEqual({ scancode: 0x58, extended: false });
    expect(codeToScancode("ShiftLeft")).toEqual({ scancode: 0x2a, extended: false });
    expect(codeToScancode("ShiftRight")).toEqual({ scancode: 0x36, extended: false });
    expect(codeToScancode("ControlLeft")).toEqual({ scancode: 0x1d, extended: false });
    expect(codeToScancode("AltLeft")).toEqual({ scancode: 0x38, extended: false });
    expect(codeToScancode("AltRight")).toEqual({ scancode: 0x38, extended: true });
    expect(codeToScancode("MetaLeft")).toEqual({ scancode: 0x5b, extended: true });
    expect(codeToScancode("MetaRight")).toEqual({ scancode: 0x5c, extended: true });
  });

  it("maps Enter/Escape/Tab/Backspace/Space/CapsLock", () => {
    expect(codeToScancode("Enter")).toEqual({ scancode: 0x1c, extended: false });
    expect(codeToScancode("Escape")).toEqual({ scancode: 0x01, extended: false });
    expect(codeToScancode("Tab")).toEqual({ scancode: 0x0f, extended: false });
    expect(codeToScancode("Backspace")).toEqual({ scancode: 0x0e, extended: false });
    expect(codeToScancode("Space")).toEqual({ scancode: 0x39, extended: false });
    expect(codeToScancode("CapsLock")).toEqual({ scancode: 0x3a, extended: false });
  });

  it("maps navigation and editing keys with the extended flag", () => {
    expect(codeToScancode("ArrowUp")).toEqual({ scancode: 0x48, extended: true });
    expect(codeToScancode("ArrowDown")).toEqual({ scancode: 0x50, extended: true });
    expect(codeToScancode("ArrowRight")).toEqual({ scancode: 0x4d, extended: true });
    expect(codeToScancode("Home")).toEqual({ scancode: 0x47, extended: true });
    expect(codeToScancode("End")).toEqual({ scancode: 0x4f, extended: true });
    expect(codeToScancode("PageUp")).toEqual({ scancode: 0x49, extended: true });
    expect(codeToScancode("PageDown")).toEqual({ scancode: 0x51, extended: true });
    expect(codeToScancode("Insert")).toEqual({ scancode: 0x52, extended: true });
  });

  it("returns null for unknown codes (caller falls back to unicode input)", () => {
    expect(codeToScancode("IntlBackslash")).toBeNull();
    expect(codeToScancode("KeyAt")).toBeNull();
    expect(codeToScancode("")).toBeNull();
  });
});
