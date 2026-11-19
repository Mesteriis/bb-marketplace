import { describe, expect, it } from "vitest";
import { toneOf } from "./desk-status.ts";

describe("toneOf", () => {
  it("is ok for a connected session the owner drives and agent for one an agent drives", () => {
    expect(toneOf({ state: "active", owner: "human" })).toBe("ok");
    expect(toneOf({ state: "active", owner: "agent" })).toBe("agent");
  });

  it("is warn while something is still being established", () => {
    expect(toneOf({ state: "connecting", owner: "human" })).toBe("warn");
    expect(toneOf({ state: "waiting", owner: "human" })).toBe("warn");
    expect(toneOf({ state: "reconnecting", owner: "agent" })).toBe("warn");
  });

  it("is bad for a lost or failed session and idle for one that is simply not connected", () => {
    expect(toneOf({ state: "lost", owner: "human" })).toBe("bad");
    expect(toneOf({ state: "error", owner: "human" })).toBe("bad");
    expect(toneOf({ state: "disconnected", owner: "human" })).toBe("idle");
    expect(toneOf({ state: "not_connected", owner: "agent" })).toBe("idle");
  });
});
