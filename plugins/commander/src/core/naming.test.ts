import { expect, it } from "vitest";
import { CommanderError } from "./errors.ts";
import { nextFreeName } from "./naming.ts";
import type { NameSegment } from "./path.ts";

const none = () => false;

function takenBy(names: string[]) {
  const set = new Set(names);
  return (n: NameSegment) => "t" in n && set.has(n.t);
}

it.each([
  ["a.txt", ["a.txt"], "a (2).txt"],
  ["a.txt", ["a.txt", "a (2).txt"], "a (3).txt"],
  ["archive.tar.gz", ["archive.tar.gz"], "archive (2).tar.gz"],
  [".bashrc", [".bashrc"], ".bashrc (2)"],
  ["dir", ["dir"], "dir (2)"],
])("nextFreeName(%j) with %j taken is %j", (name, taken, expected) => {
  expect(nextFreeName({ t: name }, takenBy(taken))).toEqual({ t: expected });
});

it("starts at (2) even when no candidate is taken; the caller checks the original name", () => {
  expect(nextFreeName({ t: "a.txt" }, none)).toEqual({ t: "a (2).txt" });
});

it("returns limit_exceeded when no free name exists within the limit", () => {
  const everything = () => true;
  expect(() => nextFreeName({ t: "a.txt" }, everything, 3)).toThrow(
    expect.objectContaining({ code: "limit_exceeded" }),
  );
  expect(() => nextFreeName({ t: "a.txt" }, everything, 3)).toThrow(CommanderError);
});

it("accepts the candidate exactly at the limit", () => {
  const takenUpToTwo = (n: NameSegment) => "t" in n && (n.t === "a.txt" || n.t === "a (2).txt");
  expect(nextFreeName({ t: "a.txt" }, takenUpToTwo, 3)).toEqual({ t: "a (3).txt" });
});

it("uses the default limit of 100000", () => {
  const takenAll = (n: NameSegment) => "t" in n && n.t.startsWith("a (");
  expect(() => nextFreeName({ t: "a.txt" }, takenAll)).toThrow(
    expect.objectContaining({ code: "limit_exceeded" }),
  );
});

it("suffixes raw byte names in bytes and keeps them raw", () => {
  // "a\xff.txt": 0xFF is not valid UTF-8, so the name stays a raw byte segment.
  const raw: NameSegment = { b: btoa("aÿ.txt") };
  const result = nextFreeName(raw, () => false);
  expect(result).toEqual({ b: btoa("aÿ (2).txt") });
});

it("returns invalid_name when the suffixed candidate exceeds the 1024-character name limit", () => {
  // 1024 characters with no extension: "aaaa (2)" is 1029 and no longer a valid NameSegment.
  expect(() => nextFreeName({ t: "a".repeat(1024) }, none)).toThrow(
    expect.objectContaining({ code: "invalid_name" }),
  );
});

it("skips a taken raw byte candidate", () => {
  const raw: NameSegment = { b: btoa("aÿ.txt") };
  const taken = new Set([btoa("aÿ (2).txt")]);
  const result = nextFreeName(raw, (n) => "b" in n && taken.has(n.b));
  expect(result).toEqual({ b: btoa("aÿ (3).txt") });
});
