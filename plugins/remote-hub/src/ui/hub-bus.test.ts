import { describe, expect, it } from "vitest";
import { createHubBus, type HubCommand } from "./hub-bus.ts";

describe("hub bus", () => {
  it("delivers a command to the page", () => {
    const bus = createHubBus();
    const got: HubCommand[] = [];
    bus.subscribe((c) => got.push(c));
    bus.send({ type: "connect", profileId: "p1" });
    expect(got).toEqual([{ type: "connect", profileId: "p1" }]);
  });

  it("keeps commands sent before a page subscribed and hands them over once, in order", () => {
    const bus = createHubBus();
    bus.send({ type: "credentials" });
    bus.send({ type: "edit", profileId: null });
    const first: HubCommand[] = [];
    bus.subscribe((c) => first.push(c));
    const second: HubCommand[] = [];
    bus.subscribe((c) => second.push(c));
    expect(first).toEqual([{ type: "credentials" }, { type: "edit", profileId: null }]);
    expect(second).toEqual([]);
  });

  it("stops delivering after unsubscribe and tells change listeners", () => {
    const bus = createHubBus();
    const got: HubCommand[] = [];
    const stop = bus.subscribe((c) => got.push(c));
    stop();
    let changes = 0;
    bus.onChanged(() => changes++);
    bus.changed();
    expect(changes).toBe(1);
    bus.send({ type: "desk" });
    expect(got).toEqual([]);
  });
});
