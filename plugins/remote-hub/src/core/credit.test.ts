import { describe, expect, it } from "vitest";
import { CREDIT_WINDOW_BYTES, createCreditState } from "./credit.ts";

describe("credit state invariant fuzz (Y3)", () => {
  it("keeps granted-consumed >= 0 and the owner invariant <= 262144", () => {
    let seed = 12345;
    const rnd = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    for (let run = 0; run < 3000; run++) {
      const c = createCreditState();
      const attached: string[] = [];
      let next = 0;
      for (let step = 0; step < 60; step++) {
        const op = rnd(6);
        if (op === 0 || attached.length === 0) {
          const id = "v" + next++;
          c.attach(id);
          attached.push(id);
        } else if (op === 1) {
          const i = rnd(attached.length);
          c.detach(attached[i]);
          attached.splice(i, 1);
        } else if (op === 2) {
          const avail = c.granted() - c.consumed();
          const n = avail > 0 ? 1 + rnd(avail) : 0;
          if (n > 0) {
            c.onConsumed(n);
            for (const v of attached) c.onLiveSent(v, n);
          }
        } else if (op === 3) {
          const v = attached[rnd(attached.length)];
          c.ack(v, 1 + rnd(CREDIT_WINDOW_BYTES * 2));
        } else if (op === 4) {
          const v = attached[rnd(attached.length)];
          c.ack(v, c.outstanding(v));
        } else {
          c.ack("ghost" + rnd(3), 1 + rnd(1000));
        }
        const avail = c.granted() - c.consumed();
        if (avail < 0) throw new Error("helper overspent: granted-consumed < 0");
        if (avail > CREDIT_WINDOW_BYTES) {
          throw new Error("helper unconsumed credit exceeds window: " + avail);
        }
      }
    }
  });
});

describe("credit state promoted slow non-owner (Y3)", () => {
  it("a promoted slow non-owner's ack keeps unconsumed credit <= window", () => {
    const c = createCreditState();
    c.attach("a"); // owner, grants W
    c.attach("b"); // non-owner
    for (let i = 0; i < 10; i++) {
      c.onConsumed(CREDIT_WINDOW_BYTES);
      c.onLiveSent("a", CREDIT_WINDOW_BYTES);
      c.onLiveSent("b", CREDIT_WINDOW_BYTES);
      c.ack("a", CREDIT_WINDOW_BYTES);
    }
    c.detach("a");
    c.ack("b", c.outstanding("b"));
    expect(c.granted() - c.consumed()).toBeLessThanOrEqual(CREDIT_WINDOW_BYTES);
  });
});

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
