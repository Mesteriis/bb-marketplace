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
    // "Surname, Name" and a Russian surname written first.
    [{ name: "Smith, John", address: "js@example.com" }, "John"],
    [{ name: "\u0418\u0432\u0430\u043d\u043e\u0432 \u0418\u0432\u0430\u043d", address: "ii@example.com" }, "\u0418\u0432\u0430\u043d"],
    [{ name: "\u041f\u0435\u0442\u0440\u043e\u0432\u0430 \u0410\u043d\u043d\u0430 \u0421\u0435\u0440\u0433\u0435\u0435\u0432\u043d\u0430", address: "pa@example.com" }, "\u0410\u043d\u043d\u0430"],
    [{ name: "\u0418\u0432\u0430\u043d \u0418\u0432\u0430\u043d\u043e\u0432", address: "ii@example.com" }, "\u0418\u0432\u0430\u043d"],
    [{ name: "\u041a\u043e\u043d\u0441\u0442\u0430\u043d\u0442\u0438\u043d \u041f\u0435\u0442\u0440\u043e\u0432", address: "kp@example.com" }, "\u041a\u043e\u043d\u0441\u0442\u0430\u043d\u0442\u0438\u043d"],
    // Given names that end like a surname stay given names; a degree or a company after a comma is not a name.
    [{ name: "\u0418\u0440\u0438\u043d\u0430 \u041a\u0438\u043c", address: "ik@example.com" }, "\u0418\u0440\u0438\u043d\u0430"],
    [{ name: "\u041a\u043e\u043d\u0441\u0442\u0430\u043d\u0442\u0438\u043d \u0428\u043e\u0439\u0433\u0443", address: "ks@example.com" }, "\u041a\u043e\u043d\u0441\u0442\u0430\u043d\u0442\u0438\u043d"],
    [{ name: "\u0415\u0432\u0430 \u0411\u0440\u0430\u0443\u043d", address: "eb@example.com" }, "\u0415\u0432\u0430"],
    [{ name: "\u041b\u0435\u0432 \u0422\u043e\u043b\u0441\u0442\u043e\u0439", address: "lt@example.com" }, "\u041b\u0435\u0432"],
    [{ name: "John Smith, PhD", address: "js@example.com" }, "John"],
    [{ name: "Jane Doe, MD", address: "jd@example.com" }, "Jane"],
    [{ name: "\u0418\u0432\u0430\u043d\u043e\u0432 \u0418\u0432\u0430\u043d, \u041e\u041e\u041e \u0420\u043e\u043c\u0430\u0448\u043a\u0430", address: "ii@example.com" }, "\u0418\u0432\u0430\u043d"],
    // A name's own capitals are kept.
    [{ name: "McKenzie Lee", address: "ml@example.com" }, "McKenzie"],
    [{ name: "ANNA SMITH", address: "as@example.com" }, "Anna"],
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
