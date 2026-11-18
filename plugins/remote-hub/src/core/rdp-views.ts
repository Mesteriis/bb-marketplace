// Host-free multiplexer between the helper's SINGLE ack-paced update stream and
// any number of views (stage 2b-2, B5/C1).
//
// The helper has one consumer: the service. It sends one update at a time (all
// its chunks share a frameId; `seq` is the chunk index INSIDE that update and
// restarts at 0 for every update) and sends the next one only after
// `rdp.update_ack {frameId}`. There is no byte credit for RDP and no per-view
// queue here:
//
// - a view with nothing in flight receives every chunk of an update at once and
//   is then "in flight" with that frameId until it acks it;
// - a view that is still busy when an update starts is skipped and marked
//   `needsFull` (it missed pixels, and the service holds no framebuffer to
//   replay them); it only accepts an update that starts with a full-width band
//   at (0, 0), and stays `needsFull` until full-width rows from y=0 reach the
//   framebuffer height;
// - the helper is acked for frameId F on the FIRST ack of F from any view that
//   received it, at once when no view received it, and when the last receiver
//   detaches, so a view that never acks costs the others nothing and the
//   helper never wedges;
// - a view that becomes free while `needsFull` (or is new) triggers one
//   `rdp.refresh` (full framebuffer) request, until an update arrives.
import type { RdpUpdateChunk } from "./rdp-protocol.ts";

interface ViewState {
  inFlight: number | null;
  needsFull: boolean;
  /** Contiguous full-width rows from y=0 delivered in the current update. */
  fullRows: number;
}

interface CurrentUpdate {
  frameId: number;
  nextSeq: number;
  receivers: Set<string>;
  acked: boolean;
  fbHeight: number;
}

export type ChunkViolation = "seq" | "frame_regressed";

export interface ChunkOutcome {
  /** Views that must be sent this chunk's payload. */
  deliver: string[];
  /** Frame id to ack to the helper now, or null. */
  ackHelper: number | null;
  /** Ask the helper for a full framebuffer. */
  refresh: boolean;
  /** Set when the helper's stream is out of step; nothing is delivered. */
  violation?: ChunkViolation;
}

export interface ViewEffects {
  ackHelper: number | null;
  refresh: boolean;
}

export class RdpViewMux {
  private readonly views = new Map<string, ViewState>();
  private current: CurrentUpdate | null = null;
  private lastFrameId = -1;
  private refreshOutstanding = false;

  /** Number of attached views. */
  size(): number {
    return this.views.size;
  }

  /** The frame id the view has been sent and not yet acked (null: free). */
  inFlight(viewId: string): number | null {
    return this.views.get(viewId)?.inFlight ?? null;
  }

  needsFull(viewId: string): boolean {
    return this.views.get(viewId)?.needsFull ?? false;
  }

  attach(viewId: string): { refresh: boolean } {
    this.views.set(viewId, { inFlight: null, needsFull: true, fullRows: 0 });
    return { refresh: this.takeRefresh() };
  }

  /** The view asks for a fresh full frame (explicit refresh): it becomes
   *  needsFull; what it has in flight stays in flight. */
  resync(viewId: string): { refresh: boolean } {
    const view = this.views.get(viewId);
    if (view === undefined) return { refresh: false };
    view.needsFull = true;
    view.fullRows = 0;
    return { refresh: this.takeRefresh() };
  }

  detach(viewId: string): ViewEffects {
    const view = this.views.get(viewId);
    this.views.delete(viewId);
    const cur = this.current;
    if (view === undefined || cur === null) return { ackHelper: null, refresh: false };
    cur.receivers.delete(viewId);
    if (!cur.acked && cur.receivers.size === 0 && view.inFlight === cur.frameId) {
      cur.acked = true;
      return { ackHelper: cur.frameId, refresh: false };
    }
    return { ackHelper: null, refresh: false };
  }

  onChunk(seq: number, chunk: RdpUpdateChunk): ChunkOutcome {
    let cur = this.current;
    const first = cur === null || chunk.frameId !== cur.frameId;
    if (first) {
      if (chunk.frameId <= this.lastFrameId) return { deliver: [], ackHelper: null, refresh: false, violation: "frame_regressed" };
      if (seq !== 0) return { deliver: [], ackHelper: null, refresh: false, violation: "seq" };
      this.lastFrameId = chunk.frameId;
      this.refreshOutstanding = false;
      cur = { frameId: chunk.frameId, nextSeq: 0, receivers: new Set(), acked: false, fbHeight: chunk.fbHeight };
      this.current = cur;
      for (const view of this.views.values()) view.fullRows = 0;
    } else if (seq !== cur!.nextSeq) {
      return { deliver: [], ackHelper: null, refresh: false, violation: "seq" };
    }
    const update = cur!;
    update.nextSeq = seq + 1;

    const deliver: string[] = [];
    let skippedFree = false;
    for (const [viewId, view] of this.views) {
      if (first) {
        if (view.inFlight !== null) {
          view.needsFull = true; // busy: it misses this update
          continue;
        }
        const fullBand = chunk.x === 0 && chunk.y === 0 && chunk.w === chunk.fbWidth;
        if (view.needsFull && !fullBand) {
          skippedFree = true; // free, but only a full-width band at (0,0) can start its resync
          continue;
        }
        view.inFlight = update.frameId;
        update.receivers.add(viewId);
      } else if (!update.receivers.has(viewId)) {
        continue;
      }
      if (view.needsFull) {
        if (chunk.x === 0 && chunk.w === chunk.fbWidth && chunk.y === view.fullRows) {
          view.fullRows += chunk.h;
          if (view.fullRows >= chunk.fbHeight) view.needsFull = false;
        } else {
          view.fullRows = 0; // not contiguous: the resync did not happen
        }
      }
      deliver.push(viewId);
    }

    let ackHelper: number | null = null;
    let refresh = false;
    if (first && update.receivers.size === 0) {
      // Nobody can take this update: release the helper, resync views later.
      update.acked = true;
      ackHelper = update.frameId;
      if (this.views.size > 0) refresh = this.takeRefresh();
    } else if (first && skippedFree) {
      refresh = this.takeRefresh();
    }
    return { deliver, ackHelper, refresh };
  }

  /** A view acked `frameId` after drawing. */
  onViewAck(viewId: string, frameId: number): ViewEffects {
    const view = this.views.get(viewId);
    if (view === undefined || view.inFlight !== frameId) return { ackHelper: null, refresh: false };
    view.inFlight = null;
    let ackHelper: number | null = null;
    const cur = this.current;
    if (cur !== null && cur.frameId === frameId && !cur.acked) {
      cur.acked = true;
      ackHelper = frameId;
    }
    const refresh = view.needsFull ? this.takeRefresh() : false;
    return { ackHelper, refresh };
  }

  /** At most one outstanding refresh until the next update begins. */
  private takeRefresh(): boolean {
    if (this.refreshOutstanding) return false;
    this.refreshOutstanding = true;
    return true;
  }
}
