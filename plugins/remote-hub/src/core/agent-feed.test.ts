import { describe, expect, it } from "vitest";
import { AgentFeed, pointerOf } from "./agent-feed.ts";

describe("AgentFeed: what an agent does, as the owner's open views see it", () => {
  it("delivers an event to the views of that session only, and stops after unsubscribe", () => {
    const feed = new AgentFeed();
    const seen: unknown[] = [];
    const other: unknown[] = [];
    const off = feed.subscribe("g.1", (e) => seen.push(e));
    feed.subscribe("g.2", (e) => other.push(e));
    feed.emit("g.1", { kind: "typed", length: 3 });
    expect(seen).toEqual([{ kind: "typed", length: 3 }]);
    expect(other).toEqual([]);
    off();
    feed.emit("g.1", { kind: "typed", length: 1 });
    expect(seen).toHaveLength(1);
  });

  it("one listener that throws does not stop the others", () => {
    const feed = new AgentFeed();
    const seen: unknown[] = [];
    feed.subscribe("g.1", () => {
      throw new Error("x");
    });
    feed.subscribe("g.1", (e) => seen.push(e));
    feed.emit("g.1", { kind: "typed", length: 1 });
    expect(seen).toHaveLength(1);
  });
});

describe("pointerOf: the pointer an agent's desktop events leave", () => {
  const g = { geom_width: 800, geom_height: 600 };
  it("is the last position, with the button that was pressed, and nothing when there was no pointer event", () => {
    expect(pointerOf([{ kind: "key", scancode: 1, extended: false, down: true }])).toBeNull();
    expect(pointerOf([{ kind: "mouse_move", x: 5, y: 6, ...g }, { kind: "mouse_move", x: 7, y: 8, ...g }])).toEqual({ kind: "pointer", x: 7, y: 8, width: 800, height: 600 });
    expect(pointerOf([{ kind: "mouse_move", x: 1, y: 2, ...g }, { kind: "mouse_button", button: "right", down: true, x: 1, y: 2, ...g }, { kind: "mouse_button", button: "right", down: false, x: 1, y: 2, ...g }])).toEqual({
      kind: "pointer",
      x: 1,
      y: 2,
      width: 800,
      height: 600,
      click: "right",
    });
  });
});
