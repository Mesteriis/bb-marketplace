import { describe, expect, it } from "vitest";
import { decidePartAction, isPartTransition, type PartAction, type PluginState } from "../../../src/core/parts/index.ts";

type Setting = boolean | undefined;

// prev x next x plugin. A key that is not there reads as on.
const rows: [Setting, Setting, PluginState, PartAction][] = [];
const states: PluginState[] = ["enabled", "disabled", "not-installed"];
const values: Setting[] = [true, false, undefined];
for (const prev of values)
  for (const next of values)
    for (const plugin of states) {
      const was = prev !== false;
      const now = next !== false;
      let expected: PartAction = "nothing";
      if (was !== now) {
        if (plugin === "not-installed") expected = "not-installed";
        else if (!now && plugin === "enabled") expected = "disable";
        else if (now && plugin === "disabled") expected = "enable";
      }
      rows.push([prev, next, plugin, expected]);
    }

describe("decidePartAction", () => {
  it.each(rows)("from %s to %s with the plugin %s: %s", (prev, next, plugin, expected) => {
    expect(decidePartAction(prev, next, plugin)).toBe(expected);
  });

  it("names the cases that matter", () => {
    expect(decidePartAction(true, false, "enabled")).toBe("disable");
    expect(decidePartAction(false, true, "disabled")).toBe("enable");
    expect(decidePartAction(undefined, false, "enabled")).toBe("disable");
    // No transition: a plugin the owner switched by hand is never touched.
    expect(decidePartAction(true, true, "disabled")).toBe("nothing");
    expect(decidePartAction(false, false, "enabled")).toBe("nothing");
    expect(decidePartAction(undefined, undefined, "disabled")).toBe("nothing");
  });

  it("covers every combination", () => {
    expect(rows).toHaveLength(27);
  });
});

describe("isPartTransition", () => {
  it("is true only when the on or off reading changes", () => {
    expect(isPartTransition(true, false)).toBe(true);
    expect(isPartTransition(false, undefined)).toBe(true);
    expect(isPartTransition(true, true)).toBe(false);
    expect(isPartTransition(true, undefined)).toBe(false);
    expect(isPartTransition(false, false)).toBe(false);
  });
});
