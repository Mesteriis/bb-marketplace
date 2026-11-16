import { describe, expect, it } from "vitest";
import { CREDIT_WINDOW_BYTES, createCreditState } from "./credit.ts";

describe("credit state (X1)", () => {
  it("first attach grants 262144, later attaches grant 0", () => {
    const s = createCreditState();
    expect(s.attach("a")).toBe(262_144);
    expect(s.attach("b")).toBe(0);
    expect(s.attach("a")).toBe(0);
  });

  it("acks are clamped to sentLive - acked and only the owner grants", () => {
    const s = createCreditState();
    s.attach("a"); // owner, grant 262144
    s.onConsumed(100_000);
    s.onLiveSent("a", 100_000);
    expect(s.ack("a", 100_000)).toBe(100_000);
    // Oversized ack with no further data: clamped to 0, no grant.
    expect(s.ack("a", 2_147_483_647)).toBe(0);
    expect(s.ack("a", 2_147_483_647)).toBe(0);
  });

  it("non-owner ack advances only its own acked and never grants", () => {
    const s = createCreditState();
    s.attach("a"); // owner
    s.attach("b");
    s.onLiveSent("b", 500);
    expect(s.ack("b", 500)).toBe(0);
    expect(s.outstanding("b")).toBe(0);
  });

  it("owner detach promotes oldest remaining and grants the remaining window", () => {
    const s = createCreditState();
    s.attach("a"); // grant 262144
    s.attach("b");
    s.onConsumed(200_000);
    // a detaches; b becomes owner. b has no outstanding, so grant the remaining
    // window: 262144 - (262144 - 200000) = 200000.
    expect(s.detach("a")).toBe(200_000);
    expect(s.owner()).toBe("b");
  });

  it("invariant granted - consumed + owner.outstanding never exceeds window", () => {
    const s = createCreditState();
    s.attach("a");
    s.onConsumed(150_000);
    s.onLiveSent("a", 150_000);
    s.ack("a", 100_000); // grant 100000
    const granted = s.granted();
    const consumed = s.consumed();
    const outstanding = s.outstanding("a");
    expect(granted - consumed + outstanding).toBeLessThanOrEqual(CREDIT_WINDOW_BYTES);
    expect(granted - consumed + outstanding).toBe(262_144);
  });
});
