// Host-free mapping from DOM pointer, wheel and keyboard events to the view's
// RDP input events (src/core/rdp-view-messages.ts). Pure: the canvas component
// reads the DOM and calls these.
import { codeToScancode } from "./rdp-keys.ts";
import type { RdpViewInputEvent } from "./rdp-view-messages.ts";

export interface FbSize {
  width: number;
  height: number;
}

export function mouseMoveEvent(pos: { x: number; y: number }, fb: FbSize): RdpViewInputEvent {
  return { kind: "mouse_move", x: pos.x, y: pos.y, fbWidth: fb.width, fbHeight: fb.height };
}

/** DOM MouseEvent.button -> the helper's button name; null for back/forward/other. */
export function buttonName(button: number): "left" | "middle" | "right" | null {
  if (button === 0) return "left";
  if (button === 1) return "middle";
  if (button === 2) return "right";
  return null;
}

export function mouseButtonEvent(
  button: number,
  down: boolean,
  pos: { x: number; y: number },
  fb: FbSize,
): RdpViewInputEvent | null {
  const name = buttonName(button);
  if (name === null) return null;
  return { kind: "mouse_button", button: name, down, x: pos.x, y: pos.y, fbWidth: fb.width, fbHeight: fb.height };
}

/**
 * Wheel rotation units for the helper (-256..255). A DOM wheel delta is positive
 * when the content scrolls down; RDP's is positive for rotation away from the
 * user (scroll up), so the sign flips. Pixel deltas pass through (a notch is ~100),
 * line deltas count 40 pixels each, page deltas 120; a non-zero delta never rounds
 * to 0.
 */
export function wheelUnits(delta: number, deltaMode: number): number {
  if (delta === 0 || !Number.isFinite(delta)) return 0;
  const pixels = deltaMode === 1 ? delta * 40 : deltaMode === 2 ? delta * 120 : delta;
  const units = Math.round(-pixels);
  const clamped = Math.max(-255, Math.min(255, units));
  return clamped === 0 ? (pixels > 0 ? -1 : 1) : clamped;
}

export function mouseWheelEvent(
  deltaX: number,
  deltaY: number,
  deltaMode: number,
  pos: { x: number; y: number },
  fb: FbSize,
): RdpViewInputEvent | null {
  const vertical = wheelUnits(deltaY, deltaMode);
  // A horizontal DOM delta is positive to the right; RDP's horizontal is positive to the right too.
  const horizontal = wheelUnitsHorizontal(deltaX, deltaMode);
  if (vertical === 0 && horizontal === 0) return null;
  return { kind: "mouse_wheel", vertical, horizontal, x: pos.x, y: pos.y, fbWidth: fb.width, fbHeight: fb.height };
}

function wheelUnitsHorizontal(delta: number, deltaMode: number): number {
  if (delta === 0 || !Number.isFinite(delta)) return 0;
  return -wheelUnits(delta, deltaMode); // undo the vertical flip: right stays positive
}

export interface KeyInput {
  code: string;
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

/** One key down/up as view input events: a scancode when the code is known, else
 *  a unicode character for a printable key pressed without ctrl/alt/meta. */
export function keyEvents(input: KeyInput, down: boolean): RdpViewInputEvent[] {
  const mapped = codeToScancode(input.code);
  if (mapped !== null) return [{ kind: "key", scancode: mapped.scancode, extended: mapped.extended, down }];
  const printable = [...input.key].length === 1;
  if (down && printable && !input.ctrlKey && !input.altKey && !input.metaKey) {
    return [{ kind: "unicode", text: input.key }];
  }
  return [];
}

/** The scancode keys currently held, so focus loss can release them. */
export class HeldKeys {
  private readonly held = new Map<string, { scancode: number; extended: boolean }>();

  down(code: string): void {
    const mapped = codeToScancode(code);
    if (mapped !== null) this.held.set(code, mapped);
  }

  up(code: string): void {
    this.held.delete(code);
  }

  size(): number {
    return this.held.size;
  }

  /** Key-up events for everything held, in the order pressed; clears the set. */
  releaseAll(): RdpViewInputEvent[] {
    const events: RdpViewInputEvent[] = [];
    for (const key of this.held.values()) {
      events.push({ kind: "key", scancode: key.scancode, extended: key.extended, down: false });
    }
    this.held.clear();
    return events;
  }
}
