import { describe, expect, it } from "vitest";
import { AgentSettings, type AgentSettingsStore } from "./agent-settings.ts";

function memory(initial: boolean | null = null): AgentSettingsStore & { saved: boolean[] } {
  let value = initial;
  const saved: boolean[] = [];
  return { saved, loadRequireWatching: () => value, saveRequireWatching: (v) => void (value = v, saved.push(v)) };
}

describe("AgentSettings: the one setting the owner can change about how agents act", () => {
  it("requires watching by default, when nothing was ever saved", () => {
    expect(new AgentSettings(memory()).requireWatching()).toBe(true);
  });

  it("reads the saved choice, and a change is stored and announced once, only when it really changes", () => {
    const store = memory(false);
    const settings = new AgentSettings(store);
    expect(settings.requireWatching()).toBe(false);
    const told: boolean[] = [];
    settings.onChange((v) => told.push(v));
    expect(settings.setRequireWatching(false)).toBe(false); // no change
    expect(settings.setRequireWatching(true)).toBe(true);
    expect(settings.setRequireWatching(true)).toBe(false);
    expect(settings.requireWatching()).toBe(true);
    expect(store.saved).toEqual([true]);
    expect(told).toEqual([true]);
  });

  it("an unreadable store means the strict default, never the permissive one", () => {
    const settings = new AgentSettings({ loadRequireWatching: () => { throw new Error("db"); }, saveRequireWatching: () => undefined });
    expect(settings.requireWatching()).toBe(true);
  });

  it("a store that cannot save refuses the change instead of pretending", () => {
    const settings = new AgentSettings({ loadRequireWatching: () => null, saveRequireWatching: () => { throw new Error("disk"); } });
    expect(() => settings.setRequireWatching(false)).toThrow("disk");
    expect(settings.requireWatching()).toBe(true);
  });
});
