import { describe, expect, it } from "vitest";
import { HeldInput, SerialQueue, rdpActionsSchema, toRdpEvents, shortHash } from "./agent-input.ts";

const GEOM = { width: 800, height: 600 };

describe("typed RDP actions", () => {
  it("accepts only the typed actions and refuses anything else (no script, no raw event, no unknown key)", () => {
    expect(rdpActionsSchema.safeParse([{ type: "click", button: "left", x: 10, y: 20 }]).success).toBe(true);
    for (const bad of [
      [{ type: "eval", code: "1+1" }],
      [{ kind: "mouse_move", x: 1, y: 2, geom_width: 8, geom_height: 8 }],
      [{ type: "click", button: "left", x: 1, y: 2, extra: true }],
      [{ type: "click", button: "back", x: 1, y: 2 }],
      [{ type: "click", button: "left", x: -1, y: 2 }],
      [{ type: "key", code: "NotAKey" }],
      [{ type: "text", text: "" }],
      [{ type: "text", text: "x".repeat(257) }],
      [],
      Array.from({ length: 41 }, () => ({ type: "ctrl_alt_del" })),
    ]) {
      expect(rdpActionsSchema.safeParse(bad).success, JSON.stringify(bad).slice(0, 80)).toBe(false);
    }
  });

  it("a click is move, down, up at the position, with the geometry the agent observed; a double click is two", () => {
    const g = { geom_width: 800, geom_height: 600 };
    expect(toRdpEvents([{ type: "click", button: "right", x: 5, y: 6 }], GEOM)).toEqual({
      ok: true,
      events: [
        { kind: "mouse_move", x: 5, y: 6, ...g },
        { kind: "mouse_button", button: "right", down: true, x: 5, y: 6, ...g },
        { kind: "mouse_button", button: "right", down: false, x: 5, y: 6, ...g },
      ],
    });
    const double = toRdpEvents([{ type: "click", button: "left", x: 1, y: 2, double: true }], GEOM);
    expect(double.ok && double.events.map((e) => e.kind)).toEqual(["mouse_move", "mouse_button", "mouse_button", "mouse_button", "mouse_button"]);
  });

  it("a key is pressed (down then up) unless down is given; letters, Enter and arrows map to scancodes", () => {
    expect(toRdpEvents([{ type: "key", code: "Enter" }], GEOM)).toEqual({
      ok: true,
      events: [{ kind: "key", scancode: 0x1c, extended: false, down: true }, { kind: "key", scancode: 0x1c, extended: false, down: false }],
    });
    expect(toRdpEvents([{ type: "key", code: "ArrowDown", down: true }], GEOM)).toEqual({ ok: true, events: [{ kind: "key", scancode: 0x50, extended: true, down: true }] });
    expect(toRdpEvents([{ type: "key", code: "KeyA" }], GEOM)).toMatchObject({ ok: true });
  });

  it("text, ctrl+alt+del and wheel notches (positive scrolls down) map to their events", () => {
    expect(toRdpEvents([{ type: "text", text: "héllo" }], GEOM)).toEqual({ ok: true, events: [{ kind: "unicode", text: "héllo" }] });
    expect(toRdpEvents([{ type: "ctrl_alt_del" }], GEOM)).toEqual({ ok: true, events: [{ kind: "ctrl_alt_del" }] });
    expect(toRdpEvents([{ type: "wheel", x: 3, y: 4, notches: 2 }], GEOM)).toEqual({ ok: true, events: [{ kind: "mouse_wheel", vertical: -200, horizontal: 0, x: 3, y: 4, geom_width: 800, geom_height: 600 }] });
  });

  it("a position outside the observed desktop is refused, not clamped", () => {
    expect(toRdpEvents([{ type: "click", button: "left", x: 800, y: 0 }], GEOM)).toEqual({ ok: false, code: "out_of_bounds", index: 0 });
    expect(toRdpEvents([{ type: "mouse_move", x: 0, y: 0 }, { type: "mouse_move", x: 799, y: 600 }], GEOM)).toEqual({ ok: false, code: "out_of_bounds", index: 1 });
    expect(toRdpEvents([{ type: "mouse_move", x: 799, y: 599 }], GEOM)).toMatchObject({ ok: true });
  });
});

describe("HeldInput", () => {
  it("remembers keys and buttons that are down, forgets them when they go up, and says what to release", () => {
    const held = new HeldInput();
    held.apply([
      { kind: "key", scancode: 0x1d, extended: false, down: true },
      { kind: "key", scancode: 0x2e, extended: false, down: true },
      { kind: "key", scancode: 0x2e, extended: false, down: false },
      { kind: "mouse_button", button: "left", down: true, x: 7, y: 8, geom_width: 800, geom_height: 600 },
    ]);
    expect(held.releaseEvents()).toEqual([
      { kind: "key", scancode: 0x1d, extended: false, down: false },
      { kind: "mouse_button", button: "left", down: false, x: 7, y: 8, geom_width: 800, geom_height: 600 },
    ]);
    expect(held.releaseEvents()).toEqual([]); // released once
  });

  it("an extended key and the plain key with the same scancode are different keys", () => {
    const held = new HeldInput();
    held.apply([{ kind: "key", scancode: 0x1d, extended: true, down: true }, { kind: "key", scancode: 0x1d, extended: false, down: true }, { kind: "key", scancode: 0x1d, extended: false, down: false }]);
    expect(held.releaseEvents()).toEqual([{ kind: "key", scancode: 0x1d, extended: true, down: false }]);
  });
});

describe("SerialQueue", () => {
  it("runs one operation at a time, in order", async () => {
    const q = new SerialQueue();
    const log: string[] = [];
    const slow = q.run("s", () => true, async () => {
      log.push("a start");
      await new Promise((r) => setTimeout(r, 10));
      log.push("a end");
      return "a";
    });
    const fast = q.run("s", () => true, async () => {
      log.push("b");
      return "b";
    });
    expect(await Promise.all([slow, fast])).toEqual([{ ran: true, value: "a" }, { ran: true, value: "b" }]);
    expect(log).toEqual(["a start", "a end", "b"]);
  });

  it("an operation whose owner is gone by the time its turn comes is DROPPED, not run", async () => {
    const q = new SerialQueue();
    let valid = true;
    let ran = 0;
    const first = q.run("s", () => valid, async () => {
      ran += 1;
      valid = false; // the human takes over while the first one is in flight
      await new Promise((r) => setTimeout(r, 5));
    });
    const second = q.run("s", () => valid, async () => void (ran += 1));
    const third = q.run("s", () => valid, async () => void (ran += 1));
    expect(await Promise.all([first, second, third])).toEqual([{ ran: true, value: undefined }, { ran: false }, { ran: false }]);
    expect(ran).toBe(1);
  });

  it("a failing operation does not block the ones after it", async () => {
    const q = new SerialQueue();
    const bad = q.run("s", () => true, async () => {
      throw new Error("x");
    });
    const good = q.run("s", () => true, async () => 1);
    await expect(bad).rejects.toThrow("x");
    expect(await good).toEqual({ ran: true, value: 1 });
  });

  it("sessions do not wait for each other", async () => {
    const q = new SerialQueue();
    let release: () => void = () => {};
    const blocked = q.run("one", () => true, () => new Promise<void>((r) => (release = r)));
    expect(await q.run("two", () => true, async () => "free")).toEqual({ ran: true, value: "free" });
    release();
    await blocked;
  });
});

describe("shortHash", () => {
  it("is the first 8 hex of SHA-256, so an input is recorded as its length and this and never its text", async () => {
    expect(await shortHash("abc")).toBe("ba7816bf"); // SHA-256("abc") = ba7816bf 8f01cfea ...
    expect(await shortHash("")).toBe("e3b0c442");
  });
});
