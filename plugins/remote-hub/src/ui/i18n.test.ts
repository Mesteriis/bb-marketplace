import { describe, expect, it } from "vitest";
import { plural, tx } from "./i18n.ts";

describe("tx", () => {
  it("returns the Russian text of a key", () => {
    expect(tx("session.disconnect")).toBe("Отключить");
  });

  it("fills named placeholders", () => {
    expect(tx("session.reconnecting", { attempt: 2, max: 5 })).toBe("переподключение 2 из 5");
  });

  it("leaves an unknown placeholder visible instead of printing undefined", () => {
    expect(tx("session.reconnecting", { attempt: 2 })).toBe("переподключение 2 из {max}");
  });
});

describe("plural", () => {
  it("picks the Russian form by number", () => {
    const forms = ["гость", "гостя", "гостей"] as const;
    expect(plural(1, forms)).toBe("1 гость");
    expect(plural(2, forms)).toBe("2 гостя");
    expect(plural(5, forms)).toBe("5 гостей");
    expect(plural(11, forms)).toBe("11 гостей");
    expect(plural(21, forms)).toBe("21 гость");
    expect(plural(34, forms)).toBe("34 гостя");
    expect(plural(112, forms)).toBe("112 гостей");
  });
});
