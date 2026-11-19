import { describe, expect, it } from "vitest";
import { ModifierTracker } from "./vnc-modifiers.ts";

describe("ModifierTracker", () => {
  it("releases exactly the modifiers still held, once", () => {
    const t = new ModifierTracker();
    t.keyDown("ControlLeft");
    t.keyDown("KeyA"); // an ordinary key is not tracked
    t.keyDown("ShiftRight");
    t.keyDown("AltLeft");
    t.keyUp("AltLeft");
    const sent: Array<[number, string]> = [];
    t.releaseAll((keysym, code) => sent.push([keysym, code]));
    expect(sent).toEqual([
      [0xffe3, "ControlLeft"],
      [0xffe2, "ShiftRight"],
    ]);
    const again: unknown[] = [];
    t.releaseAll((k) => again.push(k));
    expect(again).toEqual([]);
    expect(t.pressed).toEqual([]);
  });

  it("knows the left and right Meta and OS keys", () => {
    const t = new ModifierTracker();
    for (const c of ["MetaLeft", "MetaRight", "OSLeft", "OSRight"]) t.keyDown(c);
    const sent: number[] = [];
    t.releaseAll((k) => sent.push(k));
    expect(sent).toEqual([0xffe7, 0xffe8, 0xffeb, 0xffec]);
  });
});
