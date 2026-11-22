// What to do with the plugin behind a Chertog part switch. A pure rule over
// facts the host adapter gathers; it calls nothing itself.
//
// The switch acts only when it changes. A plugin the owner enabled or
// disabled by hand is never touched until the switch itself moves.

/** Where the plugin stands in the host's inventory. */
export type PluginState = "enabled" | "disabled" | "not-installed";

export type PartAction = "enable" | "disable" | "nothing" | "not-installed";

/** A missing key (`undefined`) reads as on. */
const isOn = (setting: boolean | undefined): boolean => setting !== false;

/** Whether the switch went from on to off or from off to on. */
export function isPartTransition(prev: boolean | undefined, next: boolean | undefined): boolean {
  return isOn(prev) !== isOn(next);
}

/**
 * What to do when a switch moves from `prev` to `next`. No transition: nothing.
 * A plugin that is not installed is never touched.
 */
export function decidePartAction(prev: boolean | undefined, next: boolean | undefined, plugin: PluginState): PartAction {
  if (!isPartTransition(prev, next)) return "nothing";
  if (plugin === "not-installed") return "not-installed";
  if (isOn(next) && plugin === "disabled") return "enable";
  if (!isOn(next) && plugin === "enabled") return "disable";
  return "nothing";
}
