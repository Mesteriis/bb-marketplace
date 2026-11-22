import { describe, expect, it } from "vitest";
import { decidePartAction, type PartAction, type PluginState } from "../../../src/core/parts/index.ts";

type Setting = boolean | undefined;

// Setting x plugin: every combination. A key that is not there reads as on.
const table: [Setting, PluginState, PartAction][] = [
  [true, "enabled", "nothing"],
  [true, "disabled", "enable"],
  [true, "not-installed", "not-installed"],
  [false, "enabled", "disable"],
  [false, "disabled", "nothing"],
  [false, "not-installed", "not-installed"],
  [undefined, "enabled", "nothing"],
  [undefined, "disabled", "enable"],
  [undefined, "not-installed", "not-installed"],
];

describe("decidePartAction", () => {
  it.each(table)("setting %s with the plugin %s: %s", (setting, plugin, expected) => {
    expect(decidePartAction(setting, plugin)).toBe(expected);
  });

  it("covers every combination of three setting states and three plugin states", () => {
    expect(table).toHaveLength(9);
  });
});
