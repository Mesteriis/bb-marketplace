import { describe, expect, it } from "vitest";
import { Scrollback } from "./scrollback.ts";

const bytes = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array) => new TextDecoder().decode(b);

describe("Scrollback offsets (stage 4a)", () => {
  it("counts every byte ever appended, even after old bytes were dropped", () => {
    const s = new Scrollback(10);
    s.append(bytes("0123456789"));
    s.append(bytes("abcde"));
    expect(s.endOffset).toBe(15);
    expect(s.startOffset).toBe(5);
    expect(s.size).toBe(10);
  });

  it("reads from an offset in order, and reports where the next read starts", () => {
    const s = new Scrollback(100);
    s.append(bytes("hello "));
    s.append(bytes("world"));
    expect(s.read(0, 100)).toEqual({ start: 0, end: 11, bytes: bytes("hello world"), gap: false });
    expect(text(s.read(6, 100).bytes)).toBe("world");
    const part = s.read(2, 3);
    expect(text(part.bytes)).toBe("llo");
    expect(part).toMatchObject({ start: 2, end: 5, gap: false });
    // Nothing new: an empty read that keeps the offset.
    expect(s.read(11, 100)).toEqual({ start: 11, end: 11, bytes: new Uint8Array(0), gap: false });
  });

  it("a read from an offset that was already dropped starts at the oldest byte and says there is a gap", () => {
    const s = new Scrollback(4);
    s.append(bytes("abcdefgh"));
    const r = s.read(1, 100);
    expect(text(r.bytes)).toBe("efgh");
    expect(r).toMatchObject({ start: 4, end: 8, gap: true });
  });

  it("an offset beyond the end reads nothing and is clamped to the end", () => {
    const s = new Scrollback(100);
    s.append(bytes("abc"));
    expect(s.read(99, 10)).toEqual({ start: 3, end: 3, bytes: new Uint8Array(0), gap: false });
  });

  it("a tail read takes the newest bytes", () => {
    const s = new Scrollback(100);
    s.append(bytes("0123456789"));
    const r = s.tail(4);
    expect(text(r.bytes)).toBe("6789");
    expect(r).toMatchObject({ start: 6, end: 10, gap: false });
  });
});
