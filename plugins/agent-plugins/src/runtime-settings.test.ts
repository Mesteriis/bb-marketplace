import { describe, expect, it } from "vitest";
import { connectTimeoutMsFromSetting, idleStopMsFromSetting } from "./runtime-settings.js";

describe("idle stop setting", () => {
  it("defaults to 10 minutes", () => {
    expect(idleStopMsFromSetting(undefined)).toBe(600_000);
    expect(idleStopMsFromSetting("")).toBe(600_000);
    expect(idleStopMsFromSetting("   ")).toBe(600_000);
  });

  it("reads whole and fractional minutes", () => {
    expect(idleStopMsFromSetting("10")).toBe(600_000);
    expect(idleStopMsFromSetting(" 30 ")).toBe(1_800_000);
    expect(idleStopMsFromSetting("0.5")).toBe(30_000);
    expect(idleStopMsFromSetting("1")).toBe(60_000);
  });

  it("turns stopping off at 0", () => {
    expect(idleStopMsFromSetting("0")).toBe(0);
  });

  it("falls back to the default for values that are not a duration", () => {
    expect(idleStopMsFromSetting("soon")).toBe(600_000);
    expect(idleStopMsFromSetting("-5")).toBe(600_000);
    expect(idleStopMsFromSetting("Infinity")).toBe(600_000);
    expect(idleStopMsFromSetting("10m")).toBe(600_000);
  });

  it("caps the idle time at 24 hours", () => {
    expect(idleStopMsFromSetting("1440")).toBe(86_400_000);
    expect(idleStopMsFromSetting("100000")).toBe(86_400_000);
  });
});

describe("connect timeout setting", () => {
  it("defaults to 60 seconds", () => {
    expect(connectTimeoutMsFromSetting(undefined)).toBe(60_000);
    expect(connectTimeoutMsFromSetting("")).toBe(60_000);
  });

  it("reads seconds", () => {
    expect(connectTimeoutMsFromSetting("15")).toBe(15_000);
    expect(connectTimeoutMsFromSetting("120")).toBe(120_000);
  });

  it("keeps the limit between 5 seconds and 10 minutes", () => {
    expect(connectTimeoutMsFromSetting("1")).toBe(5_000);
    expect(connectTimeoutMsFromSetting("5")).toBe(5_000);
    expect(connectTimeoutMsFromSetting("600")).toBe(600_000);
    expect(connectTimeoutMsFromSetting("3600")).toBe(600_000);
  });

  it("falls back to the default for values that are not a duration", () => {
    expect(connectTimeoutMsFromSetting("0")).toBe(60_000);
    expect(connectTimeoutMsFromSetting("-3")).toBe(60_000);
    expect(connectTimeoutMsFromSetting("fast")).toBe(60_000);
  });
});
