// What an agent does, announced to the live views the owner has open (stage 4c: agents are never hidden). In memory only,
// nothing is stored: a view that opens later sees only what happens from then on. Typed text needs no event of its own
// (it appears in the same terminal the owner sees); a desktop has no such trace, so the pointer is shown.
import type { RdpInputEvent } from "./rdp-protocol.ts";

export type FeedEvent =
  | { kind: "pointer"; x: number; y: number; width: number; height: number; click?: "left" | "right" | "middle" }
  | { kind: "typed"; length: number }
  | { kind: "exec"; commandId: string; phase: "started" | "output" | "finished"; text: string; stream?: "stdout" | "stderr"; exitCode?: number | null; reason?: string };

export class AgentFeed {
  private readonly listeners = new Map<string, Set<(event: FeedEvent) => void>>();

  emit(sessionKey: string, event: FeedEvent): void {
    for (const cb of [...(this.listeners.get(sessionKey) ?? [])]) {
      try {
        cb(event);
      } catch {
        // one view's throw must not skip the others
      }
    }
  }

  subscribe(sessionKey: string, cb: (event: FeedEvent) => void): () => void {
    let set = this.listeners.get(sessionKey);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(sessionKey, set);
    }
    set.add(cb);
    return () => {
      set.delete(cb);
      if (set.size === 0 && this.listeners.get(sessionKey) === set) this.listeners.delete(sessionKey);
    };
  }
}

/** The pointer a batch of desktop events leaves: the last position, and the button of the last press. Null without a pointer event. */
export function pointerOf(events: RdpInputEvent[]): Extract<FeedEvent, { kind: "pointer" }> | null {
  let result: Extract<FeedEvent, { kind: "pointer" }> | null = null;
  let click: "left" | "right" | "middle" | undefined;
  for (const e of events) {
    if (e.kind === "mouse_move" || e.kind === "mouse_button" || e.kind === "mouse_wheel") {
      result = { kind: "pointer", x: e.x, y: e.y, width: e.geom_width, height: e.geom_height };
      if (e.kind === "mouse_button" && e.down) click = e.button;
    }
  }
  if (result !== null && click !== undefined) result.click = click;
  return result;
}
