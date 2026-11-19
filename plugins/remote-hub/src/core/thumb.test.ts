import { describe, expect, it } from "vitest";
import { sameThumb, thumbLines, thumbSize } from "./thumb.ts";

describe("thumbLines", () => {
  it("keeps the last non-empty lines in order, without trailing spaces", () => {
    expect(thumbLines(["login: tester   ", "", "$ uptime", " 10:02 up 3 days", "$ ", "", ""], 3)).toEqual(["$ uptime", " 10:02 up 3 days", "$"]);
  });

  it("cuts a long line to the width", () => {
    expect(thumbLines(["abcdefghij"], 5, 4)).toEqual(["abcd"]);
  });

  it("an empty screen has no lines", () => {
    expect(thumbLines(["", "   "])).toEqual([]);
  });
});

describe("thumbSize", () => {
  it("scales a desktop down to fit, keeping its proportions", () => {
    expect(thumbSize(1280, 800)).toEqual({ width: 240, height: 150 });
    expect(thumbSize(1920, 1080)).toEqual({ width: 240, height: 135 });
    expect(thumbSize(800, 1000)).toEqual({ width: 120, height: 150 });
  });

  it("never enlarges a small frame and refuses an empty one", () => {
    expect(thumbSize(100, 50)).toEqual({ width: 100, height: 50 });
    expect(thumbSize(0, 600)).toBeNull();
  });
});

describe("sameThumb", () => {
  it("compares text by its lines and images by their data", () => {
    expect(sameThumb({ type: "text", lines: ["a", "b"] }, { type: "text", lines: ["a", "b"] })).toBe(true);
    expect(sameThumb({ type: "text", lines: ["a", "b"] }, { type: "text", lines: ["a", "c"] })).toBe(false);
    expect(sameThumb({ type: "image", url: "data:x" }, { type: "image", url: "data:x" })).toBe(true);
    expect(sameThumb({ type: "image", url: "data:x" }, { type: "text", lines: [] })).toBe(false);
    expect(sameThumb(undefined, undefined)).toBe(true);
    expect(sameThumb(undefined, { type: "text", lines: [] })).toBe(false);
  });
});
