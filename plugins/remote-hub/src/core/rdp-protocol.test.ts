import { describe, expect, it } from "vitest";
import { decodeFrame, encodeControlFrame, FRAME_KIND_CONTROL } from "./protocol.ts";
import { parseUpdateChunk, RDP_CLOSED_REASONS, rdpInputEventSchema, UPDATE_HEADER_BYTES } from "./rdp-protocol.ts";

function controlFrameOf(json: string): Uint8Array {
  const body = new Uint8Array(1 + json.length);
  body[0] = FRAME_KIND_CONTROL;
  body.set(new TextEncoder().encode(json), 1);
  const frame = new Uint8Array(4 + body.length);
  new DataView(frame.buffer).setUint32(0, body.length, true);
  frame.set(body, 4);
  return frame;
}

function decoded(json: string) {
  const result = decodeFrame(controlFrameOf(json));
  if (result.status !== "frame" || result.frame.kind !== "control") throw new Error("not a control frame: " + JSON.stringify(result));
  return result.frame.message;
}

describe("RDP control messages as the helper writes them", () => {
  it("decodes every helper response literal", () => {
    expect(decoded('{"type":"rdp.state","sessionId":3,"state":"tls"}')).toEqual({ type: "rdp.state", sessionId: 3, state: "tls" });
    expect(decoded('{"type":"rdp.ack","id":9,"sessionId":3}')).toEqual({ type: "rdp.ack", id: 9, sessionId: 3 });
    expect(
      decoded(
        '{"type":"rdp.cert_prompt","sessionId":3,"host":"h","port":3389,"fingerprint":"AA","subject":"CN=a","issuer":"CN=b","notBefore":"2026-01-01T00:00:00Z","notAfter":"2027-01-01T00:00:00Z","reason":"untrusted_root","detail":null}',
      ),
    ).toMatchObject({ type: "rdp.cert_prompt", fingerprint: "AA", reason: "untrusted_root", detail: null });
    expect(decoded('{"type":"rdp.certificate","sessionId":3,"fingerprint":"AA","validated":false}')).toMatchObject({ validated: false });
    expect(decoded('{"type":"rdp.input_rejected","sessionId":3,"applied":1,"rejected":[{"index":1,"code":"stale_geometry"}]}')).toMatchObject({
      applied: 1,
      rejected: [{ index: 1, code: "stale_geometry" }],
    });
    expect(decoded('{"type":"rdp.desktop","sessionId":3,"frameId":1,"width":800,"height":600,"timestamp":12}')).toMatchObject({
      width: 800,
      height: 600,
    });
    expect(
      decoded('{"type":"rdp.screenshot","id":4,"sessionId":3,"frameId":2,"width":3840,"height":2160,"timestamp":5,"png":"","chunks":59}'),
    ).toMatchObject({ chunks: 59, png: "" });
    expect(decoded('{"type":"rdp.screenshot","id":4,"sessionId":3,"frameId":2,"width":8,"height":8,"timestamp":5,"png":"QQ=="}')).not.toHaveProperty(
      "chunks",
    );
    expect(decoded('{"type":"rdp.screenshot_chunk","id":4,"sessionId":3,"index":0,"count":59,"data":"AAAA"}')).toMatchObject({ index: 0, count: 59 });
  });

  it("accepts the session.opened an RDP open produces (0 x 0 grid, pid, kind rdp)", () => {
    expect(decoded('{"type":"session.opened","id":2,"sessionId":5,"cols":0,"rows":0,"pid":4242,"kind":"rdp"}')).toMatchObject({
      type: "session.opened",
      sessionId: 5,
      cols: 0,
      rows: 0,
      kind: "rdp",
    });
  });

  it("refuses a screenshot answer with an impossible chunk count or an oversized desktop", () => {
    const bad = (json: string) => decodeFrame(controlFrameOf(json)).status;
    expect(bad('{"type":"rdp.screenshot","id":4,"sessionId":3,"frameId":2,"width":8,"height":8,"timestamp":5,"png":"","chunks":1}')).toBe("error");
    expect(bad('{"type":"rdp.screenshot","id":4,"sessionId":3,"frameId":2,"width":8,"height":8,"timestamp":5,"png":"","chunks":65}')).toBe("error");
    expect(bad('{"type":"rdp.desktop","sessionId":3,"frameId":1,"width":3841,"height":600,"timestamp":12}')).toBe("error");
  });

  it("encodes the requests with the field names the helper reads", () => {
    const frame = encodeControlFrame({
      type: "session.open_rdp",
      id: 5,
      host: "h",
      port: 3389,
      username: "u",
      password: "p",
      domain: null,
      width: 800,
      height: 600,
      expectedFingerprint: null,
    });
    const json = new TextDecoder().decode(frame.subarray(5));
    expect(JSON.parse(json)).toEqual({
      type: "session.open_rdp",
      id: 5,
      host: "h",
      port: 3389,
      username: "u",
      password: "p",
      domain: null,
      width: 800,
      height: 600,
      expectedFingerprint: null,
    });
    const ack = new TextDecoder().decode(encodeControlFrame({ type: "rdp.update_ack", id: 6, sessionId: 2, frameId: 77 }).subarray(5));
    expect(JSON.parse(ack)).toEqual({ type: "rdp.update_ack", id: 6, sessionId: 2, frameId: 77 });
    const refresh = new TextDecoder().decode(encodeControlFrame({ type: "rdp.refresh", id: 7, sessionId: 2 }).subarray(5));
    expect(JSON.parse(refresh)).toEqual({ type: "rdp.refresh", id: 7, sessionId: 2 });
  });
});

describe("RDP input events", () => {
  const geom = { x: 10, y: 20, geom_width: 800, geom_height: 600 };
  it("accepts the six event kinds", () => {
    for (const event of [
      { kind: "mouse_move", ...geom },
      { kind: "mouse_button", button: "left", down: true, ...geom },
      { kind: "mouse_wheel", vertical: -120 / 120, horizontal: 0, ...geom },
      { kind: "key", scancode: 0x1e, extended: false, down: true },
      { kind: "ctrl_alt_del" },
      { kind: "unicode", text: "é" },
    ]) {
      expect(rdpInputEventSchema.safeParse(event).success, JSON.stringify(event)).toBe(true);
    }
  });
  it("rejects a button the helper does not know, zero geometry and a wheel above 255", () => {
    expect(rdpInputEventSchema.safeParse({ kind: "mouse_button", button: "back", down: true, ...geom }).success).toBe(false);
    expect(rdpInputEventSchema.safeParse({ kind: "mouse_move", x: 1, y: 1, geom_width: 0, geom_height: 600 }).success).toBe(false);
    expect(rdpInputEventSchema.safeParse({ kind: "mouse_wheel", vertical: 256, horizontal: 0, ...geom }).success).toBe(false);
    expect(rdpInputEventSchema.safeParse({ kind: "unicode", text: "" }).success).toBe(false);
  });
});

function updateFrame(opts: { frameId: bigint; fbW: number; fbH: number; x: number; y: number; w: number; h: number; chunks?: number; pixels: number }): Uint8Array {
  const out = new Uint8Array(UPDATE_HEADER_BYTES + opts.pixels);
  const view = new DataView(out.buffer);
  view.setBigUint64(0, opts.frameId, true);
  view.setUint32(8, opts.fbW, true);
  view.setUint32(12, opts.fbH, true);
  view.setUint32(16, opts.x, true);
  view.setUint32(20, opts.y, true);
  view.setUint32(24, opts.w, true);
  view.setUint32(28, opts.h, true);
  view.setUint32(32, opts.chunks ?? 1, true);
  return out;
}

describe("parseUpdateChunk", () => {
  it("reads the 36-byte header and the pixel rows", () => {
    const payload = updateFrame({ frameId: 258n, fbW: 4, fbH: 4, x: 1, y: 2, w: 2, h: 1, pixels: 8 });
    payload.set([9, 8, 7, 255], UPDATE_HEADER_BYTES);
    const chunk = parseUpdateChunk(payload)!;
    expect(chunk).toMatchObject({ frameId: 258, fbWidth: 4, fbHeight: 4, x: 1, y: 2, w: 2, h: 1, chunks: 1 });
    expect(Array.from(chunk.pixels.subarray(0, 4))).toEqual([9, 8, 7, 255]);
    expect(chunk.pixels.byteLength).toBe(8);
  });
  it("returns null for every malformed header", () => {
    expect(parseUpdateChunk(new Uint8Array(35))).toBeNull(); // short header
    expect(parseUpdateChunk(updateFrame({ frameId: 1n, fbW: 4, fbH: 4, x: 0, y: 0, w: 2, h: 2, pixels: 15 }))).toBeNull(); // short pixels
    expect(parseUpdateChunk(updateFrame({ frameId: 1n, fbW: 4, fbH: 4, x: 0, y: 0, w: 2, h: 2, pixels: 17 }))).toBeNull(); // long pixels
    expect(parseUpdateChunk(updateFrame({ frameId: 1n, fbW: 4, fbH: 4, x: 3, y: 0, w: 2, h: 1, pixels: 8 }))).toBeNull(); // x+w = 5
    expect(parseUpdateChunk(updateFrame({ frameId: 1n, fbW: 4, fbH: 4, x: 0, y: 4, w: 1, h: 1, pixels: 4 }))).toBeNull(); // y+h = 5
    expect(parseUpdateChunk(updateFrame({ frameId: 1n, fbW: 0, fbH: 4, x: 0, y: 0, w: 1, h: 1, pixels: 4 }))).toBeNull();
    expect(parseUpdateChunk(updateFrame({ frameId: 1n, fbW: 3841, fbH: 4, x: 0, y: 0, w: 1, h: 1, pixels: 4 }))).toBeNull();
    expect(parseUpdateChunk(updateFrame({ frameId: 1n, fbW: 4, fbH: 4, x: 0, y: 0, w: 0, h: 1, pixels: 0 }))).toBeNull();
    expect(parseUpdateChunk(updateFrame({ frameId: 1n, fbW: 4, fbH: 4, x: 0, y: 0, w: 1, h: 1, chunks: 0, pixels: 4 }))).toBeNull(); // no bands
    expect(parseUpdateChunk(updateFrame({ frameId: 1n, fbW: 4, fbH: 4, x: 0, y: 0, w: 1, h: 1, chunks: 5, pixels: 4 }))).toBeNull(); // more bands than rows
    expect(parseUpdateChunk(updateFrame({ frameId: 2n ** 53n, fbW: 4, fbH: 4, x: 0, y: 0, w: 1, h: 1, pixels: 4 }))).toBeNull();
  });
});

describe("closed reasons", () => {
  it("are exactly the contract's list plus server_disconnected", () => {
    expect([...RDP_CLOSED_REASONS].sort()).toEqual(
      [
        "auth_failed",
        "cert_changed",
        "cert_rejected",
        "engine_exited",
        "helper_shutdown",
        "killed_by_close",
        "network_error",
        "protocol_error",
        "server_disconnected",
        "timeout",
        "tls_error",
      ].sort(),
    );
  });
});
