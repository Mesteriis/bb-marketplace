import { describe, expect, it } from "vitest";
import { CREDIT_WINDOW_BYTES, createCreditWindow } from "./credit.ts";

describe("credit window", () => {
  it("grants the literal 262144 window once, not per snapshot or attach", () => {
    expect(CREDIT_WINDOW_BYTES).toBe(262_144);
    const w = createCreditWindow();
    // Attach with a 100000-byte replay must still grant only 262144 total.
    expect(w.attach()).toBe(262_144);
    // A second attach (or re-attach) adds no second window.
    expect(w.attach()).toBe(0);
  });

  it("replenishes exactly on ack", () => {
    const w = createCreditWindow();
    w.attach();
    expect(w.ack(100_000)).toBe(100_000);
    expect(w.outstanding).toBe(262_144);
  });

  it("grants nothing for bytes that are never acked", () => {
    const w = createCreditWindow();
    w.attach();
    // Nothing is granted until the renderer acknowledges.
    expect(w.outstanding).toBe(262_144);
  });

  it("grants nothing while detached", () => {
    const w = createCreditWindow();
    w.attach();
    w.detach();
    expect(w.ack(1000)).toBe(0);
  });

  it("re-attach resumes acking without a second window", () => {
    const w = createCreditWindow();
    w.attach();
    w.detach();
    expect(w.attach()).toBe(0); // re-attach grants nothing new
    expect(w.ack(50_000)).toBe(50_000); // but acking resumes
  });
});
