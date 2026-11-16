import { describe, expect, it } from "vitest";
import { WORD_DIFF_MAX, wordDiff, type DiffOp } from "./text-diff.ts";

const join = (ops: DiffOp[], kinds: DiffOp["kind"][]) => ops.filter((op) => kinds.includes(op.kind)).map((op) => op.text).join("");

describe("wordDiff", () => {
  it("answers one same op for unchanged text", () => {
    expect(wordDiff("Hello there", "Hello there")).toEqual([{ kind: "same", text: "Hello there" }]);
    expect(wordDiff("", "")).toEqual([]);
  });

  it("marks a replaced word", () => {
    expect(wordDiff("Thanks for teh call", "Thanks for the call")).toEqual([
      { kind: "same", text: "Thanks for " },
      { kind: "delete", text: "teh " },
      { kind: "insert", text: "the " },
      { kind: "same", text: "call" },
    ]);
  });

  it("marks inserted and deleted words", () => {
    expect(wordDiff("a b c", "a x b c")).toEqual([
      { kind: "same", text: "a " },
      { kind: "insert", text: "x " },
      { kind: "same", text: "b c" },
    ]);
    expect(wordDiff("a b c d", "a d")).toEqual([
      { kind: "same", text: "a " },
      { kind: "delete", text: "b c " },
      { kind: "same", text: "d" },
    ]);
  });

  it("reconstructs both texts", () => {
    const before = "We met on Monday.\nThe report is late, sorry.";
    const after = "We met Monday.\nThe report is late; apologies for that.";
    const ops = wordDiff(before, after);
    expect(join(ops, ["same", "delete"])).toBe(before);
    expect(join(ops, ["same", "insert"])).toBe(after);
  });

  it("replaces the whole text over the word cap", () => {
    const before = "w ".repeat(WORD_DIFF_MAX + 1);
    expect(wordDiff(before, "short")).toEqual([
      { kind: "delete", text: before },
      { kind: "insert", text: "short" },
    ]);
  });
});
