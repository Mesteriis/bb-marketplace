import { describe, expect, it } from "vitest";
import { PHRASES_MAX, buildPhrases, completion, ownText } from "./phrases.ts";

describe("ownText", () => {
  it("keeps what the owner wrote above a quote, a forwarded header or a signature", () => {
    expect(ownText("Thanks, that works.\n\nOn Mon, 2 Nov 2026 at 10:00, Ada <ada@example.com> wrote:\n> Does Tuesday work?\n> Ada")).toBe("Thanks, that works.");
    expect(ownText("See below.\n\n---------- Forwarded message ---------\nFrom: Ada\nSecret plan")).toBe("See below.");
    expect(ownText("Will do.\n-- \nOwner Name\nExample Org")).toBe("Will do.");
    expect(ownText("Хорошо.\n\nпн, 2 нояб. 2026 г. в 10:00, Ada <ada@example.com> пишет:\n> Текст")).toBe("Хорошо.");
    expect(ownText("Line one\n> quoted at once")).toBe("Line one");
    expect(ownText("-----Original Message-----\nFrom: Ada")).toBe("");
  });
});

describe("buildPhrases", () => {
  const thrice = (text: string) => [text, text, text];

  it("keeps a phrase written three times and drops one written twice", () => {
    const texts = [...thrice("Let me know if you have any questions."), "Happy to help with this.", "Happy to help with this."];
    expect(buildPhrases(texts, [])).toEqual(["Let me know if you have any questions."]);
  });

  it("counts a message once, however often it repeats itself", () => {
    expect(buildPhrases(["Sounds good to me. Sounds good to me. Sounds good to me."], [])).toEqual([]);
  });

  it("never takes a phrase from quoted text or from under the signature mark", () => {
    const quoted = "Agreed.\n\nOn Mon, Ada wrote:\n> Their private phrase goes here.";
    const signed = "Agreed.\n-- \nOwner of the example org";
    expect(buildPhrases([...thrice(quoted), ...thrice(signed)], [])).toEqual([]);
  });

  it("takes phrases of three to twelve words, without numbers, addresses or links", () => {
    const texts = [
      ...thrice("Thank you."),
      ...thrice("One two three four five six seven eight nine ten eleven twelve thirteen."),
      ...thrice("Call me at 555 0100 today."),
      ...thrice("Write to ada@example.com about it."),
      ...thrice("See https://example.com for the details."),
      ...thrice("Thanks for the update!"),
    ];
    expect(buildPhrases(texts, [])).toEqual(["Thanks for the update!"]);
  });

  it("counts a template's sentences as written often, and puts the most frequent first", () => {
    const texts = [...thrice("Talk soon, and thanks again."), "Talk soon, and thanks again.", ...thrice("Sounds good to me.")];
    expect(buildPhrases(texts, ["Please find the invoice attached.\nSounds good to me."])).toEqual([
      "Sounds good to me.",
      "Talk soon, and thanks again.",
      "Please find the invoice attached.",
    ]);
  });

  it("keeps the spelling written most often, and at most 500 phrases", () => {
    expect(buildPhrases(["let me check and come back", "Let me check and come back", "Let me check and come back"], [])).toEqual(["Let me check and come back"]);
    const many = Array.from({ length: 510 }, (_, i) => `Unique phrase number ${"x".repeat(i + 1)} here.`);
    expect(buildPhrases([], many)).toHaveLength(500);
    expect(PHRASES_MAX).toBe(500);
  });
});

describe("completion", () => {
  const phrases = ["Let me know if you have any questions.", "Let me check and come back"];

  it("offers the rest of the first phrase the sentence begins, whatever the case", () => {
    expect(completion(phrases, "Let me know if")).toBe(" you have any questions.");
    expect(completion(phrases, "let me know if ")).toBe("you have any questions.");
    expect(completion(phrases, "Let me ch")).toBe("eck and come back");
  });

  it("offers nothing for one word, for under eight characters, for a whole phrase or for no match", () => {
    expect(completion(phrases, "Let")).toBeNull();
    expect(completion(phrases, "Let me")).toBeNull();
    expect(completion(phrases, "Let me check and come back")).toBeNull();
    expect(completion(phrases, "Something else entirely")).toBeNull();
    expect(completion([], "Let me know if")).toBeNull();
  });
});
