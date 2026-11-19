import { describe, expect, it } from "vitest";
import { PAIRS_MAX, correctWord, parsePairs, type Correction } from "./autocorrect.ts";

const fix = (word: string, over: { sentenceStart?: boolean; pairs?: Correction[]; skip?: string[] } = {}) =>
  correctWord(word, { sentenceStart: over.sentenceStart ?? false, pairs: over.pairs ?? [], skip: new Set(over.skip ?? []) });

describe("correctWord", () => {
  it.each([
    ["teh", "the"],
    ["Teh", "The"],
    ["recieve", "receive"],
    ["definately", "definitely"],
    ["seperate", "separate"],
    ["i", "I"],
    ["i'm", "I'm"],
    ["i'll", "I'll"],
    ["THe", "The"],
    ["HEllo", "Hello"],
    ["сдесь", "здесь"],
    ["Сделай", null],
    ["вообщем", "в общем"],
    ["ПРивет", "Привет"],
  ])("%s -> %s", (word, expected) => {
    expect(fix(word)).toBe(expected);
  });

  it.each(["the", "iOS", "eBay", "USA", "IDs", "PRs", "don't", "McDonald", "example.com", "x2", "ok", "и", "привет"])(
    "leaves %s alone in the middle of a sentence",
    (word) => {
      expect(fix(word)).toBeNull();
    },
  );

  it("capitalizes a plain word at a sentence start, in English and Russian, and nothing else", () => {
    expect(fix("hello", { sentenceStart: true })).toBe("Hello");
    expect(fix("привет", { sentenceStart: true })).toBe("Привет");
    expect(fix("teh", { sentenceStart: true })).toBe("The");
    expect(fix("iOS", { sentenceStart: true })).toBeNull();
    expect(fix("example.com", { sentenceStart: true })).toBeNull();
    expect(fix("Hello", { sentenceStart: true })).toBeNull();
    expect(fix("x2", { sentenceStart: true })).toBeNull();
  });

  it("applies the owner's replacements first, any case, keeping a capital", () => {
    const pairs = [{ from: "brb", to: "be right back" }, { from: "teh", to: "TEH!" }];
    expect(fix("brb", { pairs })).toBe("be right back");
    expect(fix("Brb", { pairs })).toBe("Be right back");
    expect(fix("teh", { pairs })).toBe("TEH!");
    expect(fix("brb", { pairs, sentenceStart: true })).toBe("Be right back");
  });

  it("never fixes a word the owner restored", () => {
    expect(fix("teh", { skip: ["teh"] })).toBeNull();
    expect(fix("hello", { skip: ["hello"], sentenceStart: true })).toBeNull();
  });
});

describe("parsePairs", () => {
  it("reads one replacement a line and skips what is not one", () => {
    expect(parsePairs("brb => be right back\n\n  omw=>on my way  ;not a pair\n => empty\nx => ; teh => the")).toEqual([
      { from: "brb", to: "be right back" },
      { from: "omw", to: "on my way" },
      { from: "teh", to: "the" },
    ]);
  });

  it("keeps a word once (the first) and at most 200", () => {
    expect(parsePairs("a1 => one\nA1 => two")).toEqual([{ from: "a1", to: "one" }]);
    const many = Array.from({ length: 201 }, (_, i) => `w${i} => v${i}`).join("\n");
    expect(parsePairs(many)).toHaveLength(200);
    expect(PAIRS_MAX).toBe(200);
  });

  it("takes one word on the left only", () => {
    expect(parsePairs("two words => x")).toEqual([]);
  });
});
