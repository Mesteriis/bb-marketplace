import { describe, expect, it } from "vitest";
import {
  decodeFrame,
  encodeControlFrame,
  encodeStreamFrame,
  MAX_FRAME_BODY_BYTES,
  type ControlMessage,
} from "./protocol.ts";

describe("frame codec", () => {
  it("round-trips a control frame", () => {
    const message: ControlMessage = { type: "ping", id: 7 };
    const decoded = decodeFrame(encodeControlFrame(message));
    expect(decoded.status).toBe("frame");
    if (decoded.status !== "frame") return;
    expect(decoded.frame).toEqual({ kind: "control", message: { type: "ping", id: 7 } });
    expect(decoded.remaining.byteLength).toBe(0);
  });

  it("returns need_more_data for a truncated buffer, not an exception", () => {
    const full = encodeControlFrame({ type: "ping", id: 7 });
    const result = decodeFrame(full.subarray(0, full.byteLength - 1));
    expect(result.status).toBe("need_more_data");
  });

  it("rejects a frame whose declared length exceeds the limit", () => {
    const buffer = new Uint8Array(4);
    new DataView(buffer.buffer).setUint32(0, MAX_FRAME_BODY_BYTES + 1, true);
    const result = decodeFrame(buffer);
    expect(result).toMatchObject({ status: "error", code: "frame_too_large" });
  });

  it("round-trips a binary stream frame", () => {
    const data = new TextEncoder().encode("héllo\n");
    const decoded = decodeFrame(encodeStreamFrame({ sessionId: 3, seq: 12 }, data));
    expect(decoded.status).toBe("frame");
    if (decoded.status !== "frame") return;
    expect(decoded.frame).toEqual({
      kind: "stream",
      header: { sessionId: 3, seq: 12 },
      data,
    });
  });
});

  it("returns an error (not an exception) for a zero-length frame", () => {
    const result = decodeFrame(new Uint8Array([0, 0, 0, 0]));
    expect(result).toMatchObject({ status: "error", code: "invalid_frame" });
  });
