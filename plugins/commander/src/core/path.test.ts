import { expect, it } from "vitest";
import {
  NameSegment,
  displayPath,
  isAncestorOrSelf,
  join,
  parent,
  parsePosix,
  samePath,
} from "./path.ts";

it("parses Unicode text into separate POSIX segments", () => {
  expect(parsePosix("/home/Привет/😀.txt")).toEqual({
    segments: [{ t: "home" }, { t: "Привет" }, { t: "😀.txt" }],
  });
});

it.each(["a", "/a/../b", "/a/./b", "/a\0b", "/a//b", "/a/"])(
  "returns invalid_path for %j",
  (text) => {
    expect(() => parsePosix(text)).toThrow(expect.objectContaining({ code: "invalid_path" }));
  },
);

it("does not include the invalid input in the error message", () => {
  expect(() => parsePosix("private-name")).toThrow(/^Invalid resource path$/);
});

it("displays each raw byte as an escape", () => {
  expect(displayPath({ segments: [{ b: "/w==" }] })).toBe("/\\xff");
  expect(displayPath({ segments: [{ b: "gP8=" }] })).toBe("/\\x80\\xff");
});

it.each(["Lw==", "AA==", "Lg==", "Li4=", "A", "/y8=", "/wA="])(
  "rejects malformed or unsafe byte segment %s",
  (b) => {
    expect(NameSegment.safeParse({ b }).success).toBe(false);
  },
);

it("requires the text representation for valid UTF-8 names", () => {
  expect(NameSegment.safeParse({ b: "YQ==" }).success).toBe(false);
});

it("compares ancestor paths by whole segments under the requested case policy", () => {
  expect(isAncestorOrSelf(parsePosix("/A"), parsePosix("/a/b"), false)).toBe(true);
  expect(isAncestorOrSelf(parsePosix("/A"), parsePosix("/a/b"), true)).toBe(false);
  expect(isAncestorOrSelf(parsePosix("/a"), parsePosix("/ab/c"), false)).toBe(false);
  expect(isAncestorOrSelf(parsePosix("/"), parsePosix("/a/b"), true)).toBe(true);
  expect(isAncestorOrSelf(parsePosix("/a/b"), parsePosix("/a"), true)).toBe(false);
});

it("uses NFC only when comparing case-insensitively", () => {
  const decomposed = parsePosix("/E\u0301");
  const composed = parsePosix("/é");
  expect(decomposed).toEqual({ segments: [{ t: "E\u0301" }] });
  expect(samePath(decomposed, composed, false)).toBe(true);
  expect(samePath(decomposed, composed, true)).toBe(false);
});

it("compares raw names by decoded bytes under either case policy", () => {
  const padded = { segments: [{ b: "/w==" }] };
  const unpadded = { segments: [{ b: "/w" }] };
  expect(samePath(padded, unpadded, true)).toBe(true);
  expect(samePath(padded, { segments: [{ b: "/g==" }] }, false)).toBe(false);
  expect(samePath(padded, { segments: [{ t: "\\xff" }] }, false)).toBe(false);
});

it("requires equal path lengths for equality", () => {
  expect(samePath(parsePosix("/a"), parsePosix("/a/b"), true)).toBe(false);
});

it("represents root as an empty path with no parent", () => {
  const root = parsePosix("/");
  expect(root).toEqual({ segments: [] });
  expect(parent(root)).toBeNull();
  expect(displayPath(root)).toBe("/");
});

it("joins and drops segments without mutating the original path", () => {
  const directory = parsePosix("/home");
  expect(join(directory, { b: "/w==" })).toEqual({ segments: [{ t: "home" }, { b: "/w==" }] });
  expect(parent(directory)).toEqual({ segments: [] });
  expect(directory).toEqual({ segments: [{ t: "home" }] });
});

it("rejects a join beyond the path segment limit", () => {
  const directory = { segments: Array.from({ length: 4096 }, () => ({ t: "a" })) };
  expect(() => join(directory, { t: "b" })).toThrow(expect.objectContaining({ code: "invalid_path" }));
});
