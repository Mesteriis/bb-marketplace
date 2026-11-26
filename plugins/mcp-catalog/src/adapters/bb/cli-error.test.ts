import { describe, expect, it } from "vitest";
import { cliErrorMessage } from "./cli-error";

describe("cliErrorMessage", () => {
  it("keeps a short stderr as it is, trimmed", () => {
    expect(cliErrorMessage("  плагин не найден\n", "exit 1", {})).toBe("плагин не найден");
  });

  it("falls back to the process error message when stderr is empty", () => {
    expect(cliErrorMessage(" \n", "Command failed: bb", {})).toBe("Command failed: bb");
  });

  it("keeps only the last 20 lines", () => {
    const stderr = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n");
    const lines = cliErrorMessage(stderr, "x", {}).split("\n");
    expect(lines).toHaveLength(21);
    expect(lines[0]).toBe("…");
    expect(lines[1]).toBe("line 81");
    expect(lines.at(-1)).toBe("line 100");
  });

  it("keeps at most 2000 characters, from the end", () => {
    const stderr = `${"a".repeat(5000)}\nfinal failure`;
    const text = cliErrorMessage(stderr, "x", {});
    expect(text.length).toBeLessThanOrEqual(2000);
    expect(text.endsWith("final failure")).toBe(true);
    expect(text.startsWith("…")).toBe(true);
  });

  it("drops blank lines before counting", () => {
    const stderr = ["one", "", "", "two"].join("\n");
    expect(cliErrorMessage(stderr, "x", {})).toBe("one\ntwo");
  });

  it("never shows the value of a secret-looking environment variable", () => {
    const text = cliErrorMessage("auth failed with tok-12345678 for user\ntoken tok-12345678", "x", {
      API_TOKEN: "tok-12345678",
      LANG: "en_US.UTF-8",
    });
    expect(text).not.toContain("tok-12345678");
    expect(text).toBe("auth failed with *** for user\ntoken ***");
  });

  it("leaves harmless environment values alone", () => {
    expect(cliErrorMessage("locale en_US.UTF-8 missing", "x", { LANG: "en_US.UTF-8" })).toBe("locale en_US.UTF-8 missing");
  });
});
