import { describe, expect, it } from "vitest";
import { buttonName, HeldKeys, keyEvents, mouseButtonEvent, mouseMoveEvent, mouseWheelEvent, wheelUnits } from "./rdp-input-map.ts";

const fb = { width: 800, height: 600 };
const key = (code: string, k: string, mods: Partial<{ ctrlKey: boolean; altKey: boolean; metaKey: boolean }> = {}) => ({
  code,
  key: k,
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  ...mods,
});

describe("pointer events", () => {
  it("carries the framebuffer geometry it was computed against", () => {
    expect(mouseMoveEvent({ x: 200, y: 150 }, fb)).toEqual({ kind: "mouse_move", x: 200, y: 150, fbWidth: 800, fbHeight: 600 });
    expect(mouseButtonEvent(0, true, { x: 1, y: 2 }, fb)).toEqual({
      kind: "mouse_button",
      button: "left",
      down: true,
      x: 1,
      y: 2,
      fbWidth: 800,
      fbHeight: 600,
    });
  });
  it("names the three buttons and ignores the others", () => {
    expect([0, 1, 2].map(buttonName)).toEqual(["left", "middle", "right"]);
    expect(buttonName(3)).toBeNull();
    expect(buttonName(4)).toBeNull();
    expect(mouseButtonEvent(3, true, { x: 0, y: 0 }, fb)).toBeNull();
  });
});

describe("wheel", () => {
  it("flips the sign (DOM down = RDP negative), clamps to -255..255 and never rounds a real delta to zero", () => {
    expect(wheelUnits(100, 0)).toBe(-100);
    expect(wheelUnits(-100, 0)).toBe(100);
    expect(wheelUnits(1000, 0)).toBe(-255);
    expect(wheelUnits(-1000, 0)).toBe(255);
    expect(wheelUnits(0.2, 0)).toBe(-1);
    expect(wheelUnits(-0.2, 0)).toBe(1);
    expect(wheelUnits(0, 0)).toBe(0);
    expect(wheelUnits(3, 1)).toBe(-120); // lines: 3 x 40
    expect(wheelUnits(1, 2)).toBe(-120); // pages
    expect(wheelUnits(Number.NaN, 0)).toBe(0);
  });
  it("builds a wheel event with both axes and none when nothing moved", () => {
    expect(mouseWheelEvent(0, 100, 0, { x: 5, y: 6 }, fb)).toEqual({
      kind: "mouse_wheel",
      vertical: -100,
      horizontal: 0,
      x: 5,
      y: 6,
      fbWidth: 800,
      fbHeight: 600,
    });
    expect(mouseWheelEvent(50, 0, 0, { x: 5, y: 6 }, fb)).toMatchObject({ vertical: 0, horizontal: 50 });
    expect(mouseWheelEvent(0, 0, 0, { x: 5, y: 6 }, fb)).toBeNull();
  });
});

describe("keys", () => {
  it("uses the scancode table for a known code", () => {
    expect(keyEvents(key("KeyA", "a"), true)).toEqual([{ kind: "key", scancode: 0x1e, extended: false, down: true }]);
    expect(keyEvents(key("ArrowLeft", "ArrowLeft"), false)).toEqual([{ kind: "key", scancode: 0x4b, extended: true, down: false }]);
    expect(keyEvents(key("ControlRight", "Control"), true)).toEqual([{ kind: "key", scancode: 0x1d, extended: true, down: true }]);
  });
  it("sends a printable character without a scancode as unicode, only on key down and never with ctrl/alt/meta", () => {
    expect(keyEvents(key("IntlBackslash2", "é"), true)).toEqual([{ kind: "unicode", text: "é" }]);
    expect(keyEvents(key("IntlBackslash2", "é"), false)).toEqual([]);
    expect(keyEvents(key("IntlBackslash2", "é", { ctrlKey: true }), true)).toEqual([]);
    expect(keyEvents(key("IntlBackslash2", "😀"), true)).toEqual([{ kind: "unicode", text: "😀" }]);
    expect(keyEvents(key("Unidentified", "Dead"), true)).toEqual([]);
    expect(keyEvents(key("Unidentified", "F20"), true)).toEqual([]);
  });
});

describe("HeldKeys", () => {
  it("releases exactly the keys still down, in press order, once", () => {
    const held = new HeldKeys();
    held.down("ControlLeft");
    held.down("KeyC");
    held.down("ArrowLeft");
    held.up("KeyC");
    held.down("Nonsense"); // unknown codes are not tracked
    expect(held.size()).toBe(2);
    expect(held.releaseAll()).toEqual([
      { kind: "key", scancode: 0x1d, extended: false, down: false },
      { kind: "key", scancode: 0x4b, extended: true, down: false },
    ]);
    expect(held.releaseAll()).toEqual([]);
  });
});
