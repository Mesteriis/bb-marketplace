import { describe, expect, it } from "vitest";
import { MAX_PASTE_CHARS, isPasteShortcut, modifiersHeld, pasteAsKeysyms, pasteAsRdpEvents } from "./paste.ts";

const key = (over: object) => ({ code: "KeyV", metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...over });

describe("isPasteShortcut", () => {
  it("is Cmd+V or Ctrl+Shift+V, and nothing else", () => {
    expect(isPasteShortcut(key({ metaKey: true }))).toBe(true);
    expect(isPasteShortcut(key({ ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(isPasteShortcut(key({ ctrlKey: true }))).toBe(false); // Ctrl+V belongs to the remote machine
    expect(isPasteShortcut(key({ metaKey: true, altKey: true }))).toBe(false);
    expect(isPasteShortcut(key({ metaKey: true, code: "KeyC" }))).toBe(false);
    expect(isPasteShortcut(key({}))).toBe(false);
  });
});

describe("modifiersHeld", () => {
  it("is true while any of the four is down", () => {
    expect(modifiersHeld(key({}))).toBe(false);
    expect(modifiersHeld(key({ shiftKey: true }))).toBe(true);
    expect(modifiersHeld(key({ metaKey: true }))).toBe(true);
  });
});

describe("pasteAsKeysyms", () => {
  it("types letters and digits as their own keysyms, with Shift for capitals and US shifted signs", () => {
    expect(pasteAsKeysyms("aB1!").keys).toEqual([
      { keysym: 0x61, shift: false },
      { keysym: 0x42, shift: true },
      { keysym: 0x31, shift: false },
      { keysym: 0x21, shift: true },
    ]);
  });

  it("turns a line end (LF, CRLF or CR) into one Return and a tab into Tab; other control characters are left out", () => {
    expect(pasteAsKeysyms("a\r\nb\nc\rd\te\u0007").keys.map((k) => k.keysym)).toEqual([0x61, 0xff0d, 0x62, 0xff0d, 0x63, 0xff0d, 0x64, 0xff09, 0x65]);
  });

  it("sends a character outside Latin-1 as a Unicode keysym", () => {
    expect(pasteAsKeysyms("éж").keys).toEqual([
      { keysym: 0xe9, shift: false },
      { keysym: 0x01000436, shift: false },
    ]);
  });

  it("cuts a long text at the limit and says so", () => {
    const result = pasteAsKeysyms("x".repeat(MAX_PASTE_CHARS + 5));
    expect(MAX_PASTE_CHARS).toBe(4096);
    expect(result.keys.length).toBe(4096);
    expect(result.truncated).toBe(true);
    expect(pasteAsKeysyms("abc").truncated).toBe(false);
  });
});

describe("pasteAsRdpEvents", () => {
  it("sends text as unicode events and each line end as the Enter key", () => {
    expect(pasteAsRdpEvents("ab\ncd").batches).toEqual([
      [
        { kind: "unicode", text: "ab" },
        { kind: "key", scancode: 0x1c, extended: false, down: true },
        { kind: "key", scancode: 0x1c, extended: false, down: false },
        { kind: "unicode", text: "cd" },
      ],
    ]);
  });

  it("types a tab as the Tab key and drops other control characters", () => {
    expect(pasteAsRdpEvents("a\tb\u0001").batches).toEqual([
      [
        { kind: "unicode", text: "a" },
        { kind: "key", scancode: 0x0f, extended: false, down: true },
        { kind: "key", scancode: 0x0f, extended: false, down: false },
        { kind: "unicode", text: "b" },
      ],
    ]);
  });

  it("splits a long run into pieces of 64 characters, one batch each", () => {
    const { batches, truncated } = pasteAsRdpEvents("x".repeat(130));
    expect(batches.map((b) => b.map((e) => (e.kind === "unicode" ? e.text.length : 0)))).toEqual([[64], [64], [2]]);
    expect(truncated).toBe(false);
  });

  it("an empty or control-only text produces nothing", () => {
    expect(pasteAsRdpEvents("").batches).toEqual([]);
    expect(pasteAsKeysyms("\u0000").keys).toEqual([]);
  });
});
