import { describe, expect, it } from "vitest";
import { introLine, looksLikeIntro, moveSenderToBcc } from "./intro.ts";

describe("looksLikeIntro", () => {
  it.each([
    ["Intro: Ada <> Bob", ""],
    ["Introduction", ""],
    ["Introducing you two", ""],
    ["Hello", "I'd like you to meet Bob, who runs the example team."],
    ["Hello", "Please meet Ada from the example team."],
    ["Hello", "Connecting you with Ada."],
    ["Знакомство", ""],
    ["Привет", "Знакомьтесь, это Ада."],
    ["Привет", "Представляю вам Боба."],
  ])("%s / %s is an introduction", (subject, text) => {
    expect(looksLikeIntro({ subject, text })).toBe(true);
  });

  it.each([
    ["Invoice", "Please find the invoice."],
    ["Meeting notes", "The meeting went well."],
    ["Lunch", "Can we meet on Tuesday? Or join https://meet.example.com/abc"],
    ["Отчёт", "Это представляет интерес."],
    ["Introspection", "Thoughts on introspective tools."],
    ["Hello", `${"x".repeat(700)} intro`],
  ])("%s is not", (subject, text) => {
    expect(looksLikeIntro({ subject, text })).toBe(false);
  });
});

describe("moveSenderToBcc", () => {
  const draft = { to: ["Ada <ada@example.com>", "bob@example.com"], cc: [], bcc: [] };

  it("moves the sender, whatever the case of the address, and keeps everyone else", () => {
    expect(moveSenderToBcc(draft, "ADA@example.com")).toEqual({ to: ["bob@example.com"], cc: [], bcc: ["Ada <ada@example.com>"] });
    expect(moveSenderToBcc({ to: ["ada@example.com"], cc: ["bob@example.com"], bcc: ["boss@example.org"] }, "ada@example.com")).toEqual({
      to: [],
      cc: ["bob@example.com"],
      bcc: ["boss@example.org", "ada@example.com"],
    });
  });

  it("takes the sender out of Cc too, and writes the line in the mail's language", () => {
    expect(moveSenderToBcc({ to: ["ada@example.com", "bob@example.com"], cc: ["Ada <ADA@example.com>"], bcc: [] }, "ada@example.com")).toEqual({
      to: ["bob@example.com"],
      cc: [],
      bcc: ["ada@example.com"],
    });
    expect(introLine("Ada", "Re: Intro: Ada <> Bob")).toBe("Thank you, Ada! (Moving you to Bcc.)");
    expect(introLine(null, "Intro")).toBe("Thank you! (Moving you to Bcc.)");
    expect(introLine("Ада", "Re: Знакомство")).toBe("Спасибо, Ада! (Переношу вас в скрытую копию.)");
  });

  it("does nothing a second time, for a sender who is not in To, or when nobody else is left", () => {
    const once = moveSenderToBcc(draft, "ada@example.com")!;
    expect(moveSenderToBcc(once, "ada@example.com")).toBeNull();
    expect(moveSenderToBcc(draft, "carol@example.com")).toBeNull();
    expect(moveSenderToBcc({ to: ["ada@example.com"], cc: [], bcc: [] }, "ada@example.com")).toBeNull();
  });
});
