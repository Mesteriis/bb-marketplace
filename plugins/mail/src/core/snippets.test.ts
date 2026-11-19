import { describe, expect, it } from "vitest";
import { ComposeError } from "./compose.ts";
import { NO_EXTRAS, fillBlocks, fillVariables, firstNameOf, hasVariable, mergeRecipients, normalizeExtras } from "./snippets.ts";

describe("firstNameOf", () => {
  it.each([
    [{ name: "Ada Lovelace", address: "al@example.com" }, "Ada"],
    [{ name: "  grace   hopper ", address: "g@example.com" }, "Grace"],
    [{ name: null, address: "ada.lovelace@example.com" }, "Ada"],
    [{ name: "", address: "linus_t@example.com" }, "Linus"],
    [{ name: "ada@example.com", address: "ada@example.com" }, "Ada"],
    [{ name: null, address: "info@example.com" }, null],
    [{ name: null, address: "x1@example.com" }, null],
    [undefined, null],
  ])("%j -> %s", (recipient, expected) => {
    expect(firstNameOf(recipient)).toBe(expected);
  });
});

describe("variables", () => {
  it("replaces {first_name} when a name is known and leaves it otherwise", () => {
    expect(fillVariables("Hi {first_name}, thanks {First_Name}!", "Ada")).toBe("Hi Ada, thanks Ada!");
    expect(fillVariables("Hi {first_name},", null)).toBe("Hi {first_name},");
    expect(hasVariable("Hi {first_name},")).toBe(true);
    expect(hasVariable("Hi {name},")).toBe(false);
  });

  it("fills the text of a document's blocks without touching the original", () => {
    const blocks = [{ type: "paragraph", content: [{ type: "text", text: "Hi {first_name}," }, { type: "hardBreak" }, { type: "text", text: "bye", marks: [{ type: "bold" }] }] }];
    expect(fillBlocks(blocks, "Ada")).toEqual([
      { type: "paragraph", content: [{ type: "text", text: "Hi Ada," }, { type: "hardBreak" }, { type: "text", text: "bye", marks: [{ type: "bold" }] }] },
    ]);
    expect(blocks[0]!.content[0]).toEqual({ type: "text", text: "Hi {first_name}," });
  });
});

describe("normalizeExtras", () => {
  it("keeps a one-line subject and valid addresses, once each, lower-cased for comparison", () => {
    expect(normalizeExtras({ subject: "  Invoice  ", to: ["Ada <ada@example.com>", "ADA@example.com"], cc: [], bcc: ["boss@example.org"] })).toEqual({
      subject: "Invoice",
      to: ["Ada <ada@example.com>"],
      cc: [],
      bcc: ["boss@example.org"],
    });
    expect(normalizeExtras(undefined)).toEqual(NO_EXTRAS);
    expect(normalizeExtras({ subject: "   " })).toEqual(NO_EXTRAS);
  });

  it("refuses a long or broken subject, a bad address and more than 20 recipients", () => {
    expect(() => normalizeExtras({ subject: "x".repeat(201) })).toThrow(ComposeError);
    expect(() => normalizeExtras({ subject: "a\nb" })).toThrow(ComposeError);
    expect(() => normalizeExtras({ to: ["not an address"] })).toThrow(ComposeError);
    const many = Array.from({ length: 21 }, (_, i) => `p${i}@example.com`);
    expect(() => normalizeExtras({ to: many.slice(0, 10), cc: many.slice(10) })).toThrow(ComposeError);
    expect(normalizeExtras({ to: many.slice(0, 20) }).to).toHaveLength(20);
  });
});

describe("mergeRecipients", () => {
  it("adds only addresses the draft does not have in any field", () => {
    expect(mergeRecipients(["Ada <ada@example.com>"], ["ADA@example.com", "Bob <bob@example.com>", "carol@example.com"], ["Carol <CAROL@example.com>"])).toEqual([
      "Ada <ada@example.com>",
      "Bob <bob@example.com>",
    ]);
  });
});
