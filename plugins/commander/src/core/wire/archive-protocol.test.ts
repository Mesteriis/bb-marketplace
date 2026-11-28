import { describe, expect, it } from "vitest";
import {
  FrameDecoder, ProtocolError, encodeControl, encodeData, encodeSecret, FRAME_LIMITS, PROTOCOL_VERSION,
  HelloMessage, OpenRequest,
} from "./archive-protocol.ts";

const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
const bytes = (...values: number[]) => Uint8Array.from(values);

describe("frame encoding", () => {
  it("encodes control, data and secret frames with literal bytes", () => {
    expect(hex(encodeControl({}))).toBe("030000000" + "17b7d");
    expect(hex(encodeData(1, bytes(9)))).toBe("06000000" + "02" + "01000000" + "09");
    expect(hex(encodeSecret(2, bytes(0x61)))).toBe("06000000" + "03" + "02000000" + "61");
  });
  it("refuses empty secrets, oversized control and oversized data when encoding", () => {
    expect(() => encodeSecret(1, new Uint8Array(0))).toThrow(ProtocolError);
    expect(() => encodeSecret(1, new Uint8Array(1025))).toThrow(ProtocolError);
    expect(() => encodeData(1, new Uint8Array(4 * 1024 * 1024 + 1))).toThrow(ProtocolError);
    expect(() => encodeControl({ pad: "a".repeat(FRAME_LIMITS.controlMax) })).toThrow(ProtocolError);
  });
});

describe("FrameDecoder from the helper side (adapter receiving)", () => {
  const fromHelper = () => new FrameDecoder("from-helper");
  it("decodes frames split across chunks", () => {
    const decoder = fromHelper();
    const frame = encodeControl({ t: "hello" });
    expect(decoder.push(frame.subarray(0, 3))).toEqual([]);
    expect(decoder.push(frame.subarray(3, 9))).toEqual([]);
    expect(decoder.push(frame.subarray(9))).toEqual([{ kind: "control", json: { t: "hello" } }]);
  });
  it("decodes a stream of 300 KiB frames delivered in 64 KiB pieces, with frame edges inside pieces", () => {
    const payload = new Uint8Array(300 * 1024);
    for (let i = 0; i < payload.length; i++) payload[i] = i % 251;
    const data = encodeData(9, payload);
    const parts = [encodeControl({ t: "hello" }), ...Array.from({ length: 3 }, () => data), encodeData(9, new Uint8Array(0))];
    const stream = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    parts.reduce((at, part) => (stream.set(part, at), at + part.length), 0);
    const decoder = fromHelper();
    const frames: ReturnType<FrameDecoder["push"]> = [];
    for (let at = 0; at < stream.length; at += 65_531) frames.push(...decoder.push(stream.subarray(at, at + 65_531)));
    expect(frames.map((f) => f.kind)).toEqual(["control", ...Array(4).fill("data")]);
    expect(Buffer.compare((frames[1] as { bytes: Uint8Array }).bytes, payload)).toBe(0);
    expect(Buffer.compare((frames[3] as { bytes: Uint8Array }).bytes, payload)).toBe(0);
    expect((frames[4] as { bytes: Uint8Array }).bytes.length).toBe(0);
  });
  it("finds a frame header split across tiny pieces and the next frame after it", () => {
    const decoder = fromHelper();
    const stream = new Uint8Array([...encodeData(1, bytes(1, 2, 3)), ...encodeData(2, bytes(4))]);
    const frames: ReturnType<FrameDecoder["push"]> = [];
    for (let at = 0; at < stream.length; at++) frames.push(...decoder.push(stream.subarray(at, at + 1)));
    expect(frames).toHaveLength(2);
    expect([...(frames[1] as { bytes: Uint8Array }).bytes]).toEqual([4]);
  });
  it("decodes data frames with reqId and payload", () => {
    const frames = fromHelper().push(encodeData(7, bytes(1, 2, 3)));
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ kind: "data", reqId: 7 });
    expect([...(frames[0] as { bytes: Uint8Array }).bytes]).toEqual([1, 2, 3]);
  });
  it("accepts an empty data payload (end of stream)", () => {
    const frames = fromHelper().push(encodeData(7, new Uint8Array(0)));
    expect((frames[0] as { bytes: Uint8Array }).bytes.length).toBe(0);
  });
  it("fails on every protocol violation", () => {
    const cases: Array<[string, Uint8Array]> = [
      ["zero length", bytes(0, 0, 0, 0)],
      ["unknown kind", bytes(2, 0, 0, 0, 9, 0x7b)],
      ["control shorter than 2", bytes(1, 0, 0, 0, 1)],
      ["data shorter than 5", bytes(4, 0, 0, 0, 2, 1, 0, 0)],
      ["secret from helper", encodeSecret(1, bytes(0x61))],
      ["invalid json", bytes(5, 0, 0, 0, 1, 0x7b, 0x7b, 0x7b, 0x7b)],
      ["json not an object", bytes(3, 0, 0, 0, 1, 0x31, 0x32)],
      ["invalid utf-8", bytes(4, 0, 0, 0, 1, 0xff, 0xfe, 0xfd)],
      ["control over 1 MiB", bytes(0x02, 0x00, 0x10, 0x00, 1, 0x7b)],
      ["data over 4 MiB + 5", bytes(0x06, 0x00, 0x40, 0x00, 2, 1, 0, 0, 0)],
    ];
    for (const [name, input] of cases) {
      expect(() => fromHelper().push(input), name).toThrow(ProtocolError);
    }
  });
  it("fails for good after the first violation", () => {
    const decoder = fromHelper();
    expect(() => decoder.push(bytes(0, 0, 0, 0))).toThrow(ProtocolError);
    expect(() => decoder.push(encodeControl({}))).toThrow(ProtocolError);
  });
});

describe("FrameDecoder from the adapter side (helper-side rules in tests)", () => {
  it("accepts secret frames only toward the helper", () => {
    const frames = new FrameDecoder("from-adapter").push(encodeSecret(3, bytes(0x70, 0x77)));
    expect(frames[0]).toMatchObject({ kind: "secret", reqId: 3 });
  });
  it("redacts the secret payload in any printed form", () => {
    const [frame] = new FrameDecoder("from-adapter").push(encodeSecret(3, bytes(0x70, 0x77)));
    expect(JSON.stringify(frame)).not.toContain("pw");
    expect(String(frame)).not.toContain("pw");
    expect(JSON.stringify(frame)).toBe('{"kind":"secret","reqId":3,"length":2}');
  });
  it("rejects a secret over 1 KiB and a secret without a byte", () => {
    expect(() => new FrameDecoder("from-adapter").push(bytes(5, 0, 0, 0, 3, 1, 0, 0, 0))).toThrow(ProtocolError);
  });
});

describe("messages", () => {
  it("pins the protocol version", () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });
  it("parses a hello and rejects a wrong shape", () => {
    expect(HelloMessage.parse({ t: "hello", protocol: 1, helper: "0.1.0", zip: "8.6.0", tar: "0.4.46", rlimit_as: "not_enforced" }))
      .toEqual({ t: "hello", protocol: 1, helper: "0.1.0", zip: "8.6.0", tar: "0.4.46", rlimit_as: "not_enforced" });
    expect(HelloMessage.safeParse({ t: "hello", protocol: 1 }).success).toBe(false);
  });
  it("requires an absolute-looking root, canonical base64 segments and the full expect in open", () => {
    const open = {
      t: "open", req: 1, rootB64: "L3RtcA==", segmentsB64: ["YS56aXA="], format: "auto",
      limits: { maxTotalBytes: 10737418240, maxEntries: 100000, maxRatio: 100 },
      expect: { size: "5", mtimeNs: "7", dev: "1", ino: "2" },
    };
    expect(OpenRequest.safeParse(open).success).toBe(true);
    expect(OpenRequest.safeParse({ ...open, expect: undefined }).success).toBe(false);
    expect(OpenRequest.safeParse({ ...open, expect: { size: "5", mtimeNs: "7" } }).success).toBe(false);
    expect(OpenRequest.safeParse({ ...open, segmentsB64: ["not base64!"] }).success).toBe(false);
  });
});
