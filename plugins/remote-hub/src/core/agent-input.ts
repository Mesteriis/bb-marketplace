// What an agent may send to a session, as typed data (stage 4b-1): RDP actions that map to the helper's input
// events, the keys and buttons an agent left down (released when its lease ends), a per-session serial queue whose
// waiting operations are dropped when the owner is gone, and the short hash an audit row records instead of text.
import { z } from "zod";
import { codeToScancode } from "./rdp-keys.ts";
import type { RdpInputEvent } from "./rdp-protocol.ts";

const coordinate = z.number().int().min(0).max(65535);
const button = z.enum(["left", "right", "middle"]);
const keyCode = z.string().min(1).max(32).refine((code) => codeToScancode(code) !== null, { message: "not a key this plugin knows (a DOM KeyboardEvent.code such as Enter, KeyA, ArrowDown)" });

export const rdpActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("mouse_move"), x: coordinate, y: coordinate }).strict(),
  z.object({ type: z.literal("click"), button, x: coordinate, y: coordinate, double: z.boolean().optional() }).strict(),
  z.object({ type: z.literal("mouse_button"), button, down: z.boolean(), x: coordinate, y: coordinate }).strict(),
  z.object({ type: z.literal("wheel"), x: coordinate, y: coordinate, notches: z.number().int().min(-10).max(10) }).strict(),
  z.object({ type: z.literal("key"), code: keyCode, down: z.boolean().optional() }).strict(),
  z.object({ type: z.literal("text"), text: z.string().min(1).max(256) }).strict(),
  z.object({ type: z.literal("ctrl_alt_del") }).strict(),
]);
export const MAX_RDP_ACTIONS = 40;
export const rdpActionsSchema = z.array(rdpActionSchema).min(1).max(MAX_RDP_ACTIONS);
export type RdpAction = z.infer<typeof rdpActionSchema>;

export type ToEvents = { ok: true; events: RdpInputEvent[] } | { ok: false; code: "out_of_bounds"; index: number };

/**
 * The helper's events for typed actions. Positions are in desktop pixels of the geometry the agent observed; one
 * outside it is refused (never clamped).
 */
export function toRdpEvents(actions: RdpAction[], geometry: { width: number; height: number }): ToEvents {
  const events: RdpInputEvent[] = [];
  const g = { geom_width: geometry.width, geom_height: geometry.height };
  for (const [index, a] of actions.entries()) {
    if ("x" in a && (a.x >= geometry.width || a.y >= geometry.height)) return { ok: false, code: "out_of_bounds", index };
    switch (a.type) {
      case "mouse_move":
        events.push({ kind: "mouse_move", x: a.x, y: a.y, ...g });
        break;
      case "click":
        events.push({ kind: "mouse_move", x: a.x, y: a.y, ...g });
        for (let i = 0; i < (a.double === true ? 2 : 1); i++) {
          events.push({ kind: "mouse_button", button: a.button, down: true, x: a.x, y: a.y, ...g });
          events.push({ kind: "mouse_button", button: a.button, down: false, x: a.x, y: a.y, ...g });
        }
        break;
      case "mouse_button":
        events.push({ kind: "mouse_button", button: a.button, down: a.down, x: a.x, y: a.y, ...g });
        break;
      case "wheel":
        // Positive notches scroll down, which is a negative rotation for RDP; a notch is 100 units.
        events.push({ kind: "mouse_wheel", vertical: -100 * a.notches, horizontal: 0, x: a.x, y: a.y, ...g });
        break;
      case "key": {
        const key = codeToScancode(a.code);
        if (key === null) break; // the schema refused unknown codes already
        if (a.down === undefined || a.down) events.push({ kind: "key", scancode: key.scancode, extended: key.extended, down: true });
        if (a.down === undefined || !a.down) events.push({ kind: "key", scancode: key.scancode, extended: key.extended, down: false });
        break;
      }
      case "text":
        events.push({ kind: "unicode", text: a.text });
        break;
      case "ctrl_alt_del":
        events.push({ kind: "ctrl_alt_del" });
        break;
    }
  }
  return { ok: true, events };
}

/** The keys and mouse buttons an agent's input left pressed, so they can be released when it loses the session. */
export class HeldInput {
  private readonly keys = new Map<string, { scancode: number; extended: boolean }>();
  private readonly buttons = new Map<string, { x: number; y: number; geom_width: number; geom_height: number }>();

  apply(events: RdpInputEvent[]): void {
    for (const e of events) {
      if (e.kind === "key") {
        const id = `${e.extended ? "e" : "p"}${e.scancode}`;
        if (e.down) this.keys.set(id, { scancode: e.scancode, extended: e.extended });
        else this.keys.delete(id);
      } else if (e.kind === "mouse_button") {
        if (e.down) this.buttons.set(e.button, { x: e.x, y: e.y, geom_width: e.geom_width, geom_height: e.geom_height });
        else this.buttons.delete(e.button);
      }
    }
  }

  /** What to send to let go of everything still held; clears the memory. */
  releaseEvents(): RdpInputEvent[] {
    const out: RdpInputEvent[] = [];
    for (const k of this.keys.values()) out.push({ kind: "key", scancode: k.scancode, extended: k.extended, down: false });
    for (const [name, pos] of this.buttons) out.push({ kind: "mouse_button", button: name as "left" | "right" | "middle", down: false, ...pos });
    this.keys.clear();
    this.buttons.clear();
    return out;
  }
}

/** Per-session serial execution; an operation whose owner is gone when its turn comes is dropped, not run. */
export class SerialQueue {
  private readonly tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, stillValid: () => boolean, op: () => Promise<T>): Promise<{ ran: true; value: T } | { ran: false }> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.then(async () => (stillValid() ? { ran: true as const, value: await op() } : { ran: false as const }));
    // The next operation waits for this one, whether it worked or not.
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }
}

/** The first 8 hex characters of SHA-256 of a text: what an audit row keeps of an input instead of the input. */
export async function shortHash(text: string): Promise<string> {
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return Array.from(digest.subarray(0, 4), (b) => b.toString(16).padStart(2, "0")).join("");
}
