import { describe, expect, it } from "vitest";
import { RdpViewMux } from "./rdp-views.ts";
import type { RdpUpdateChunk } from "./rdp-protocol.ts";

const FB_W = 100;
const FB_H = 60;

function chunk(frameId: number, x: number, y: number, w: number, h: number): RdpUpdateChunk {
  return { frameId, fbWidth: FB_W, fbHeight: FB_H, x, y, w, h, pixels: new Uint8Array(w * h * 4) };
}
const full = (frameId: number) => chunk(frameId, 0, 0, FB_W, FB_H);
const part = (frameId: number) => chunk(frameId, 10, 10, 8, 8);

describe("RdpViewMux", () => {
  it("a new view needs a full frame and asks for exactly one refresh", () => {
    const mux = new RdpViewMux();
    expect(mux.attach("a")).toEqual({ refresh: true, ackHelper: null });
    expect(mux.needsFull("a")).toBe(true);
    // a second view while the refresh is outstanding does not ask again
    expect(mux.attach("b")).toEqual({ refresh: false, ackHelper: null });
  });

  it("delivers the full update to both views, acks the helper on the FIRST view ack, and clears needsFull", () => {
    const mux = new RdpViewMux();
    mux.attach("a");
    mux.attach("b");
    const out = mux.onChunk(0, full(5));
    expect(out).toEqual({ deliver: ["a", "b"], ackHelper: null, refresh: false });
    expect(mux.inFlight("a")).toBe(5);
    expect(mux.needsFull("a")).toBe(false);
    expect(mux.onViewAck("a", 5)).toEqual({ ackHelper: 5, refresh: false });
    // the second ack of the same frame must not ack the helper again
    expect(mux.onViewAck("b", 5)).toEqual({ ackHelper: null, refresh: false });
    expect(mux.inFlight("b")).toBeNull();
  });

  it("a view that never acks receives exactly one update while the other keeps updating (case 8)", () => {
    const mux = new RdpViewMux();
    mux.attach("a");
    mux.attach("silent");
    expect(mux.onChunk(0, full(1)).deliver).toEqual(["a", "silent"]);
    mux.onViewAck("a", 1);
    const delivered: Record<string, number> = { a: 1, silent: 1 };
    for (let frame = 2; frame <= 11; frame++) {
      const out = mux.onChunk(0, part(frame));
      for (const id of out.deliver) delivered[id] += 1;
      expect(out.ackHelper).toBeNull(); // the helper waits for the ack of `a`
      expect(mux.onViewAck("a", frame).ackHelper).toBe(frame);
    }
    expect(delivered).toEqual({ a: 11, silent: 1 });
    expect(mux.inFlight("silent")).toBe(1);
    expect(mux.needsFull("silent")).toBe(true);
  });

  it("a skipped free needsFull view causes one refresh, and takes only a full-width band at (0,0)", () => {
    const mux = new RdpViewMux();
    mux.attach("a");
    mux.onChunk(0, full(1));
    mux.onViewAck("a", 1);
    expect(mux.attach("late")).toEqual({ refresh: true, ackHelper: null });
    const partial = mux.onChunk(0, part(2));
    expect(partial.deliver).toEqual(["a"]); // late is free but a partial band cannot resync it
    // a new update began without resyncing `late`: the earlier request is spent, ask once more
    expect(partial.refresh).toBe(true);
    mux.onViewAck("a", 2);
    const refreshed = mux.onChunk(0, full(3));
    expect(refreshed.deliver).toEqual(["a", "late"]);
    expect(mux.needsFull("late")).toBe(false);
  });

  it("an update nobody can take releases the helper at once and a freed view asks for a refresh", () => {
    const mux = new RdpViewMux();
    mux.attach("a");
    mux.onChunk(0, full(1)); // a in flight, never acks for now
    const out = mux.onChunk(0, part(2));
    // a is busy and frame 2 started while frame 1 is un-acked: a is skipped
    expect(out).toEqual({ deliver: [], ackHelper: 2, refresh: true });
    expect(mux.needsFull("a")).toBe(true);
    // a acks frame 1 (the helper was already moved on); a is needsFull and free:
    // the refresh is outstanding, so no second one
    expect(mux.onViewAck("a", 1)).toEqual({ ackHelper: null, refresh: false });
  });

  it("with no view attached the helper is released immediately", () => {
    const mux = new RdpViewMux();
    expect(mux.onChunk(0, full(1))).toEqual({ deliver: [], ackHelper: 1, refresh: false });
  });

  it("the helper is released when the last receiver detaches un-acked, not before", () => {
    const mux = new RdpViewMux();
    mux.attach("a");
    mux.attach("b");
    mux.onChunk(0, full(1));
    expect(mux.detach("a")).toEqual({ ackHelper: null, refresh: false }); // b still holds it
    expect(mux.detach("b")).toEqual({ ackHelper: 1, refresh: false });
    expect(mux.size()).toBe(0);
  });

  it("seq is the chunk index inside ONE update and restarts at 0 for the next", () => {
    const mux = new RdpViewMux();
    mux.attach("a");
    const band = (frameId: number, y: number) => chunk(frameId, 0, y, FB_W, 20);
    expect(mux.onChunk(0, band(7, 0)).deliver).toEqual(["a"]);
    expect(mux.onChunk(1, band(7, 20)).deliver).toEqual(["a"]);
    expect(mux.onChunk(2, band(7, 40)).deliver).toEqual(["a"]);
    expect(mux.needsFull("a")).toBe(false); // three 20-row bands from y=0 reach 60 rows
    expect(mux.onViewAck("a", 7).ackHelper).toBe(7);
    // the next update starts at seq 0 again
    expect(mux.onChunk(0, part(8)).deliver).toEqual(["a"]);
  });

  it("flags a stream that is out of step", () => {
    const mux = new RdpViewMux();
    mux.attach("a");
    expect(mux.onChunk(1, full(1))).toMatchObject({ violation: "seq", deliver: [] }); // first chunk of an update must be seq 0
    mux.onChunk(0, full(4));
    expect(mux.onChunk(2, full(4))).toMatchObject({ violation: "seq" }); // skipped chunk 1
    expect(mux.onChunk(0, full(4))).toMatchObject({ violation: "seq" }); // repeated chunk 0 of the same frame
    expect(mux.onChunk(0, full(3))).toMatchObject({ violation: "frame_regressed" });
  });

  it("an explicit resync keeps the in-flight frame, needs a full frame again, and asks once", () => {
    const mux = new RdpViewMux();
    mux.attach("a");
    mux.onChunk(0, full(1));
    expect(mux.needsFull("a")).toBe(false);
    // Frame 1 is held un-acked: the resync releases it at the helper so the refresh can flow.
    expect(mux.resync("a")).toEqual({ refresh: true, ackHelper: 1 });
    expect(mux.inFlight("a")).toBe(1); // it still holds frame 1
    expect(mux.needsFull("a")).toBe(true);
    expect(mux.resync("a")).toEqual({ refresh: false, ackHelper: null }); // one request outstanding, frame 1 already released
    expect(mux.resync("nobody")).toEqual({ refresh: false, ackHelper: null });
    // the late ack for frame 1 does not ack the helper a second time
    expect(mux.onViewAck("a", 1).ackHelper).toBeNull();
  });

  it("a healthy view that attaches while a silent view holds the frame gets a full frame (L1)", () => {
    const mux = new RdpViewMux();
    mux.attach("silent");
    expect(mux.onChunk(0, full(1)).deliver).toEqual(["silent"]); // frame 1 held, never acked
    // The newcomer asks for a refresh, which the helper queues BEHIND frame 1: frame 1 is released now.
    expect(mux.attach("healthy")).toEqual({ refresh: true, ackHelper: 1 });
    // The refreshed full frame (a NEW frame id) reaches the healthy view only.
    const out = mux.onChunk(0, full(2));
    expect(out.deliver).toEqual(["healthy"]);
    expect(mux.needsFull("healthy")).toBe(false);
    expect(mux.needsFull("silent")).toBe(true);
    expect(mux.onViewAck("healthy", 2)).toEqual({ ackHelper: 2, refresh: false });
    // and it keeps receiving updates afterwards, the silent view stays at frame 1
    expect(mux.onChunk(0, part(3)).deliver).toEqual(["healthy"]);
    expect(mux.inFlight("silent")).toBe(1);
  });

  it("the frame is released only once: a later ack by the holder does not ack the helper again", () => {
    const mux = new RdpViewMux();
    mux.attach("silent");
    mux.onChunk(0, full(1));
    expect(mux.attach("healthy").ackHelper).toBe(1);
    expect(mux.attach("another").ackHelper).toBeNull();
    expect(mux.onViewAck("silent", 1).ackHelper).toBeNull();
  });

  it("an ack for a frame the view does not hold changes nothing", () => {
    const mux = new RdpViewMux();
    mux.attach("a");
    mux.onChunk(0, full(1));
    expect(mux.onViewAck("a", 99)).toEqual({ ackHelper: null, refresh: false });
    expect(mux.onViewAck("nobody", 1)).toEqual({ ackHelper: null, refresh: false });
    expect(mux.inFlight("a")).toBe(1);
  });
});
