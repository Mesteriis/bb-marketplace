import { describe, expect, it } from "vitest";
import { DICTATION_CHARS, dictatedParagraphs, dictationFile } from "./dictation-text.ts";

describe("dictatedParagraphs", () => {
  it("splits on blank lines, joins the lines of a paragraph and trims", () => {
    expect(dictatedParagraphs("  Hello Ann,\r\n\r\nTuesday works\nfor me.  \n\n\n See you. ")).toEqual(["Hello Ann,", "Tuesday works for me.", "See you."]);
  });

  it("removes what cannot be seen and gives nothing for silence", () => {
    const tag = String.fromCodePoint(0xe0041);
    expect(dictatedParagraphs(`Pay\u200b at${tag} once\u0007`)).toEqual(["Pay at once"]);
    expect(dictatedParagraphs("  \n\n \u200b ")).toEqual([]);
  });

  it("keeps 20 000 characters at most", () => {
    const parts = dictatedParagraphs(`${"a".repeat(19_990)}\n\n${"b".repeat(100)}`);
    expect(DICTATION_CHARS).toBe(20_000);
    expect(parts.join("").length).toBeLessThanOrEqual(20_000);
    expect(parts[0]).toBe("a".repeat(19_990));
    expect(parts[1]).toBe("b".repeat(8));
  });

  it("never cuts a character in half at the limit", () => {
    const parts = dictatedParagraphs(`${"a".repeat(19_999)}\u{1F600}tail`);
    expect(parts).toEqual(["a".repeat(19_999)]);
  });

  it("names the recording by its format, without codec parameters", () => {
    expect(dictationFile("audio/webm;codecs=opus")).toEqual({ name: "dictation.webm", type: "audio/webm" });
    expect(dictationFile("audio/mp4")).toEqual({ name: "dictation.m4a", type: "audio/mp4" });
    expect(dictationFile("audio/ogg; codecs=opus")).toEqual({ name: "dictation.ogg", type: "audio/ogg" });
    expect(dictationFile("")).toEqual({ name: "dictation.webm", type: "audio/webm" });
    expect(dictationFile("text/html")).toEqual({ name: "dictation.webm", type: "audio/webm" });
  });
});
