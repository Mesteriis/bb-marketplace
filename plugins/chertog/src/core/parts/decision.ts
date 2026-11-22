// What to do with the plugin behind a Chertog part switch. A pure rule over
// two facts the host adapter gathers; it calls nothing itself.

/** Where the plugin stands in the host's inventory. */
export type PluginState = "enabled" | "disabled" | "not-installed";

export type PartAction = "enable" | "disable" | "nothing" | "not-installed";

/**
 * `setting` is the switch's value; `undefined` (no key) reads as on, so an
 * installation that never saw the switch keeps its plugin. A plugin that is
 * not installed is never touched.
 */
export function decidePartAction(setting: boolean | undefined, plugin: PluginState): PartAction {
  if (plugin === "not-installed") return "not-installed";
  const wanted = setting !== false;
  if (wanted && plugin === "disabled") return "enable";
  if (!wanted && plugin === "enabled") return "disable";
  return "nothing";
}
