import { describe, expect, it } from "vitest";
import { createNewThreadPass, NEW_THREAD_PASS_TTL_MS } from "../../../src/core/home/index.ts";

describe("new thread pass", () => {
  it("lives five seconds", () => {
    expect(NEW_THREAD_PASS_TTL_MS).toBe(5000);
  });

  it("is absent until granted", () => {
    expect(createNewThreadPass().consume(1000)).toBe(false);
  });

  it("is spent by the first arrival and absent for the second", () => {
    const pass = createNewThreadPass();
    pass.grant(1000);
    expect(pass.consume(1001)).toBe(true);
    expect(pass.consume(1002)).toBe(false);
  });

  it("granted twice still lets one arrival through", () => {
    const pass = createNewThreadPass();
    pass.grant(1000);
    pass.grant(1010);
    expect(pass.consume(1020)).toBe(true);
    expect(pass.consume(1030)).toBe(false);
  });

  it("is valid at the grant instant and at the last millisecond of its life", () => {
    const atGrant = createNewThreadPass();
    atGrant.grant(1000);
    expect(atGrant.consume(1000)).toBe(true);

    const atLimit = createNewThreadPass();
    atLimit.grant(1000);
    expect(atLimit.consume(6000)).toBe(true);
  });

  it("expires one millisecond past its life, and the expired pass is gone", () => {
    const pass = createNewThreadPass();
    pass.grant(1000);
    expect(pass.consume(6001)).toBe(false);
    expect(pass.consume(1500)).toBe(false);
  });

  it("is refused when the clock reads earlier than the grant", () => {
    const pass = createNewThreadPass();
    pass.grant(1000);
    expect(pass.consume(999)).toBe(false);
    expect(pass.consume(1001)).toBe(false);
  });

  it("honours a custom lifetime", () => {
    const pass = createNewThreadPass(10);
    pass.grant(0);
    expect(pass.consume(11)).toBe(false);
    pass.grant(0);
    expect(pass.consume(10)).toBe(true);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])("refuses a lifetime of %s", (ttl) => {
    expect(() => createNewThreadPass(ttl)).toThrow(RangeError);
  });
});
