import { describe, expect, it } from "vitest";
import { ScreenshotAssembler, SCREENSHOT_CHUNK_BASE64_MAX } from "./rdp-screenshot.ts";

const header = { id: 9, frameId: 4, width: 3840, height: 2160, timestamp: 77, chunks: 3 };
const chunk = (index: number, data: string, count = 3, id = 9) => ({ id, index, count, data });

describe("ScreenshotAssembler", () => {
  it("joins ordered chunks into the base64 PNG and carries the header fields", () => {
    const a = new ScreenshotAssembler(header);
    expect(a.add(chunk(0, "AAAA"))).toEqual({ status: "more" });
    expect(a.add(chunk(1, "BBBBCCCC"))).toEqual({ status: "more" });
    expect(a.add(chunk(2, "DD=="))).toEqual({
      status: "done",
      result: { frameId: 4, width: 3840, height: 2160, timestamp: 77, png: "AAAABBBBCCCCDD==" },
    });
  });

  it("refuses a skipped, repeated, mis-counted, foreign, empty, unaligned or oversized chunk", () => {
    const cases: Array<[string, ReturnType<typeof chunk>]> = [
      ["skipped", chunk(1, "AAAA")],
      ["foreign id", chunk(0, "AAAA", 3, 8)],
      ["wrong count", chunk(0, "AAAA", 4)],
      ["empty", chunk(0, "")],
      ["unaligned", chunk(0, "AAAAA")],
      ["oversized", chunk(0, "A".repeat(SCREENSHOT_CHUNK_BASE64_MAX + 4))],
    ];
    for (const [name, c] of cases) {
      expect(new ScreenshotAssembler(header).add(c), name).toEqual({ status: "error", code: "bad_chunk" });
    }
    const a = new ScreenshotAssembler(header);
    a.add(chunk(0, "AAAA"));
    expect(a.add(chunk(0, "AAAA"))).toEqual({ status: "error", code: "bad_chunk" }); // repeated
  });

  it("accepts a header only for 2..64 chunks", () => {
    expect(ScreenshotAssembler.valid({ ...header, chunks: 1 })).toBe(false);
    expect(ScreenshotAssembler.valid({ ...header, chunks: 2 })).toBe(true);
    expect(ScreenshotAssembler.valid({ ...header, chunks: 64 })).toBe(true);
    expect(ScreenshotAssembler.valid({ ...header, chunks: 65 })).toBe(false);
  });
});
