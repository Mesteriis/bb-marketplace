import { describe, expect, it } from "vitest";
import { CREDIT_WINDOW_BYTES, createCreditController } from "./credit.ts";

describe("credit controller", () => {
  it("grants the literal 262144 window on attach", () => {
    expect(CREDIT_WINDOW_BYTES).toBe(262_144);
    expect(createCreditController().attach()).toBe(262_144);
  });

  it("replenishes exactly the consumed bytes while attached", () => {
    const c = createCreditController();
    c.attach();
    expect(c.consumed(100_000)).toBe(100_000);
    expect(c.consumed(0)).toBe(0);
    expect(c.consumed(-5)).toBe(0);
  });

  it("grants nothing while detached", () => {
    const c = createCreditController();
    c.attach();
    c.detach();
    expect(c.consumed(1000)).toBe(0);
  });
});
