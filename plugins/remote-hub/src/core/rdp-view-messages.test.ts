import { describe, expect, it } from "vitest";
import { rdpViewMessageSchema, toHelperEvent } from "./rdp-view-messages.ts";

describe("view messages", () => {
  it("parses ack, input, refresh and detach", () => {
    expect(rdpViewMessageSchema.parse({ type: "ack", frameId: 12 })).toEqual({ type: "ack", frameId: 12 });
    expect(rdpViewMessageSchema.parse({ type: "refresh" })).toEqual({ type: "refresh" });
    expect(rdpViewMessageSchema.parse({ type: "detach" })).toEqual({ type: "detach" });
    const input = { type: "input", events: [{ kind: "mouse_move", x: 200, y: 150, fbWidth: 800, fbHeight: 600 }] };
    expect(rdpViewMessageSchema.parse(input)).toEqual(input);
  });

  it("rejects an empty or oversized batch, a negative ack and unknown types", () => {
    expect(rdpViewMessageSchema.safeParse({ type: "input", events: [] }).success).toBe(false);
    const many = Array.from({ length: 257 }, () => ({ kind: "ctrl_alt_del" }));
    expect(rdpViewMessageSchema.safeParse({ type: "input", events: many }).success).toBe(false);
    expect(rdpViewMessageSchema.safeParse({ type: "ack", frameId: -1 }).success).toBe(false);
    expect(rdpViewMessageSchema.safeParse({ type: "resize", cols: 1, rows: 1 }).success).toBe(false);
  });

  it("rejects scancodes outside the helper's accepted set and a button it does not know", () => {
    const key = (scancode: number) => ({ type: "input", events: [{ kind: "key", scancode, extended: false, down: true }] });
    expect(rdpViewMessageSchema.safeParse(key(0)).success).toBe(false);
    expect(rdpViewMessageSchema.safeParse(key(0x5e)).success).toBe(false);
    expect(rdpViewMessageSchema.safeParse(key(0x5d)).success).toBe(true);
    const button = { type: "input", events: [{ kind: "mouse_button", button: "back", down: true, x: 1, y: 1, fbWidth: 8, fbHeight: 8 }] };
    expect(rdpViewMessageSchema.safeParse(button).success).toBe(false);
  });

  it("maps fbWidth/fbHeight to the helper's geom_width/geom_height literally", () => {
    expect(toHelperEvent({ kind: "mouse_move", x: 200, y: 150, fbWidth: 800, fbHeight: 600 })).toEqual({
      kind: "mouse_move",
      x: 200,
      y: 150,
      geom_width: 800,
      geom_height: 600,
    });
    expect(toHelperEvent({ kind: "mouse_button", button: "right", down: false, x: 1, y: 2, fbWidth: 3, fbHeight: 4 })).toEqual({
      kind: "mouse_button",
      button: "right",
      down: false,
      x: 1,
      y: 2,
      geom_width: 3,
      geom_height: 4,
    });
    expect(toHelperEvent({ kind: "mouse_wheel", vertical: -1, horizontal: 2, x: 5, y: 6, fbWidth: 7, fbHeight: 8 })).toEqual({
      kind: "mouse_wheel",
      vertical: -1,
      horizontal: 2,
      x: 5,
      y: 6,
      geom_width: 7,
      geom_height: 8,
    });
    expect(toHelperEvent({ kind: "key", scancode: 0x1e, extended: true, down: true })).toEqual({ kind: "key", scancode: 0x1e, extended: true, down: true });
    expect(toHelperEvent({ kind: "ctrl_alt_del" })).toEqual({ kind: "ctrl_alt_del" });
    expect(toHelperEvent({ kind: "unicode", text: "é" })).toEqual({ kind: "unicode", text: "é" });
  });
});
