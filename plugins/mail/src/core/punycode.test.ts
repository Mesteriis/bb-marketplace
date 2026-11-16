import { describe, expect, it } from "vitest";
import { decodePunycodeLabel, toUnicodeDomain } from "./punycode.ts";

// RFC 3492 section 7.1 samples. The Unicode side is built from its code
// points so the test source stays ASCII.
const cp = (...points: number[]) => String.fromCodePoint(...points);

describe("decodePunycodeLabel (RFC 3492 section 7.1)", () => {
  const samples: [string, string, string][] = [
    ["A Arabic (Egyptian)", "egbpdaj6bu4bxfgehfvwxn", cp(0x644, 0x64a, 0x647, 0x645, 0x627, 0x628, 0x62a, 0x643, 0x644, 0x645, 0x648, 0x634, 0x639, 0x631, 0x628, 0x64a, 0x61f)],
    ["B Chinese (simplified)", "ihqwcrb4cv8a8dqg056pqjye", cp(0x4ed6, 0x4eec, 0x4e3a, 0x4ec0, 0x4e48, 0x4e0d, 0x8bf4, 0x4e2d, 0x6587)],
    ["C Chinese (traditional)", "ihqwctvzc91f659drss3x8bo0yb", cp(0x4ed6, 0x5011, 0x7232, 0x4ec0, 0x9ebd, 0x4e0d, 0x8aaa, 0x4e2d, 0x6587)],
    [
      "D Czech",
      "Proprostnemluvesky-uyb24dma41a",
      cp(0x50, 0x72, 0x6f, 0x10d, 0x70, 0x72, 0x6f, 0x73, 0x74, 0x11b, 0x6e, 0x65, 0x6d, 0x6c, 0x75, 0x76, 0xed, 0x10d, 0x65, 0x73, 0x6b, 0x79),
    ],
    [
      "I Russian",
      "b1abfaaepdrnnbgefbadotcwatmq2g4l",
      cp(0x43f, 0x43e, 0x447, 0x435, 0x43c, 0x443, 0x436, 0x435, 0x43e, 0x43d, 0x438, 0x43d, 0x435, 0x433, 0x43e, 0x432, 0x43e, 0x440, 0x44f, 0x442, 0x43f, 0x43e, 0x440, 0x443, 0x441, 0x441, 0x43a, 0x438),
    ],
    ["L 3<nen>B<gumi><kinpachi><sensei>", "3B-ww4c5e180e575a65lsy2b", cp(0x33, 0x5e74, 0x42, 0x7d44, 0x91d1, 0x516b, 0x5148, 0x751f)],
    [
      "M <amuro><namie>-with-SUPER-MONKEYS",
      "-with-SUPER-MONKEYS-pc58ag80a8qai00g7n9n",
      cp(0x5b89, 0x5ba4, 0x5948, 0x7f8e, 0x6075) + "-with-SUPER-MONKEYS",
    ],
    ["R <sono><supiido><de>", "d9juau41awczczp", cp(0x305d, 0x306e, 0x30b9, 0x30d4, 0x30fc, 0x30c9, 0x3067)],
    ["S -> $1.00 <-", "-> $1.00 <--", "-> $1.00 <-"],
  ];

  for (const [name, encoded, decoded] of samples) {
    it(name, () => {
      expect(decodePunycodeLabel(encoded)).toBe(decoded);
    });
  }

  it("refuses bad digits, truncated input, non-ASCII and overflow", () => {
    expect(decodePunycodeLabel("ab!c")).toBeNull();
    expect(decodePunycodeLabel("egbpdaj6bu4bxfgehfvwx9")).not.toBe(samples[0]?.[2]);
    expect(decodePunycodeLabel("a-" + cp(0x430))).toBeNull();
    expect(decodePunycodeLabel("99999999999")).toBeNull();
    // Ends in the middle of a variable-length integer.
    expect(decodePunycodeLabel("zz")).toBeNull();
  });

  it("refuses input over 63 characters", () => {
    expect(decodePunycodeLabel("a".repeat(62) + "-")).toBe("a".repeat(62));
    expect(decodePunycodeLabel("a".repeat(64) + "-")).toBeNull();
  });
});

describe("toUnicodeDomain", () => {
  it("decodes xn-- labels and keeps the others", () => {
    expect(toUnicodeDomain("mail.xn--e1afmkfd.xn--p1ai")).toBe(`mail.${cp(0x43f, 0x440, 0x438, 0x43c, 0x435, 0x440)}.${cp(0x440, 0x444)}`);
    expect(toUnicodeDomain("Example.COM")).toBe("example.com");
    expect(toUnicodeDomain("XN--e1afmkfd.example")).toBe(`${cp(0x43f, 0x440, 0x438, 0x43c, 0x435, 0x440)}.example`);
  });

  it("is null when a label does not decode", () => {
    expect(toUnicodeDomain("xn--ab!c.example")).toBeNull();
    expect(toUnicodeDomain("")).toBeNull();
  });
});
