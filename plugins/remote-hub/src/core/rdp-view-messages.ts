// What a view (the canvas page) may send over the attach socket for an RDP
// session, and its mapping to the helper's `rdp.input` events. Host-free.
import { z } from "zod";
import { MAX_DESKTOP_HEIGHT, MAX_DESKTOP_WIDTH, MAX_RDP_INPUT_EVENTS, type RdpInputEvent } from "./rdp-protocol.ts";

const pointer = {
  x: z.number().int().min(0).max(MAX_DESKTOP_WIDTH),
  y: z.number().int().min(0).max(MAX_DESKTOP_HEIGHT),
  // The framebuffer size the coordinates were computed against; the engine drops
  // the event as stale_geometry when it no longer matches.
  fbWidth: z.number().int().min(1).max(MAX_DESKTOP_WIDTH),
  fbHeight: z.number().int().min(1).max(MAX_DESKTOP_HEIGHT),
};

export const rdpViewInputEventSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("mouse_move"), ...pointer }),
  z.object({ kind: z.literal("mouse_button"), button: z.enum(["left", "right", "middle"]), down: z.boolean(), ...pointer }),
  z.object({
    kind: z.literal("mouse_wheel"),
    vertical: z.number().int().min(-256).max(255),
    horizontal: z.number().int().min(-256).max(255),
    ...pointer,
  }),
  z.object({
    kind: z.literal("key"),
    scancode: z.number().int().min(1).max(0x5d),
    extended: z.boolean(),
    down: z.boolean(),
  }),
  z.object({ kind: z.literal("ctrl_alt_del") }),
  z.object({ kind: z.literal("unicode"), text: z.string().min(1).max(256) }),
]);
export type RdpViewInputEvent = z.infer<typeof rdpViewInputEventSchema>;

export const rdpViewMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ack"), frameId: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) }),
  z.object({ type: z.literal("input"), events: z.array(rdpViewInputEventSchema).min(1).max(MAX_RDP_INPUT_EVENTS) }),
  z.object({ type: z.literal("refresh") }),
  z.object({ type: z.literal("detach") }),
]);
export type RdpViewMessage = z.infer<typeof rdpViewMessageSchema>;

/** The helper's wire form of one view input event (fbWidth/fbHeight -> geom_*). */
export function toHelperEvent(event: RdpViewInputEvent): RdpInputEvent {
  switch (event.kind) {
    case "mouse_move":
      return { kind: "mouse_move", x: event.x, y: event.y, geom_width: event.fbWidth, geom_height: event.fbHeight };
    case "mouse_button":
      return {
        kind: "mouse_button",
        button: event.button,
        down: event.down,
        x: event.x,
        y: event.y,
        geom_width: event.fbWidth,
        geom_height: event.fbHeight,
      };
    case "mouse_wheel":
      return {
        kind: "mouse_wheel",
        vertical: event.vertical,
        horizontal: event.horizontal,
        x: event.x,
        y: event.y,
        geom_width: event.fbWidth,
        geom_height: event.fbHeight,
      };
    case "key":
      return { kind: "key", scancode: event.scancode, extended: event.extended, down: event.down };
    case "ctrl_alt_del":
      return { kind: "ctrl_alt_del" };
    case "unicode":
      return { kind: "unicode", text: event.text };
  }
}
