// Until Navigation and the thread list are absorbed into Chertog, the
// switches «Навигация» and «Список тредов» enable and disable the plugins
// that still provide them (makosh-navigation, makosh-sidebar) through
// `bb.sdk.plugins`. The rule is `decidePartAction` in the core; this file
// only gathers the facts and makes the calls.
//
// BB tells the server about a settings write through the handle's
// `onChange`; the check also runs once at start. A failure never reaches the
// plugin factory: it is logged once per new state and tried again at the next
// settings write.
import type { BbPluginApi, PluginLogger, PluginSettingValue } from "@get-bb/plugin-sdk";
import { decidePartAction, type PluginState } from "../../../core/parts/index.ts";

export interface PartToggle {
  /** The settings key of the switch. */
  readonly key: string;
  /** The plugin the switch controls. */
  readonly pluginId: string;
}

export const PART_TOGGLES: readonly PartToggle[] = [
  { key: "navigationPart", pluginId: "makosh-navigation" },
  { key: "threadListPart", pluginId: "makosh-sidebar" },
];

type Values = Readonly<Record<string, PluginSettingValue | undefined>>;

export interface PartSyncDeps {
  readonly settings: {
    get(): Promise<Values>;
    onChange(listener: (next: Values, prev: Values) => void): void;
  };
  /** Read when a check runs, not when the plugin loads: the SDK is bound late. */
  readonly plugins: () => Pick<BbPluginApi["sdk"]["plugins"], "list" | "enable" | "disable">;
  readonly log: Pick<PluginLogger, "info" | "warn">;
}

export interface PartSync {
  /** Resolves when every check asked for so far has ended. It never rejects. */
  idle(): Promise<void>;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function startPartSync({ settings, plugins, log }: PartSyncDeps): PartSync {
  let tail: Promise<void> = Promise.resolve();
  // What was last reported for a plugin (or for the inventory), so a repeat is not logged again.
  const reported = new Map<string, string>();

  function report(subject: string, signature: string, line: () => void): void {
    if (reported.get(subject) === signature) return;
    reported.set(subject, signature);
    line();
  }

  async function check(values: Values): Promise<void> {
    let inventory: Awaited<ReturnType<ReturnType<PartSyncDeps["plugins"]>["list"]>>;
    try {
      inventory = await plugins().list();
    } catch (error) {
      report("*", "list:" + describe(error), () => log.warn("parts: the plugin inventory could not be read: " + describe(error)));
      return;
    }
    reported.delete("*");
    for (const { key, pluginId } of PART_TOGGLES) {
      const entry = inventory.plugins.find((plugin) => plugin.id === pluginId);
      const state: PluginState = entry === undefined ? "not-installed" : entry.enabled ? "enabled" : "disabled";
      const setting = values[key];
      const action = decidePartAction(typeof setting === "boolean" ? setting : undefined, state);
      if (action === "not-installed") {
        report(pluginId, "not-installed", () => log.info(`parts: ${pluginId} is not installed; the switch ${key} has nothing to control`));
        continue;
      }
      if (action === "nothing") {
        reported.delete(pluginId);
        continue;
      }
      try {
        await (action === "enable" ? plugins().enable({ pluginId }) : plugins().disable({ pluginId }));
        reported.delete(pluginId);
      } catch (error) {
        report(pluginId, `${action}:${describe(error)}`, () => log.warn(`parts: could not ${action} ${pluginId}: ${describe(error)}`));
      }
    }
  }

  function queue(read: () => Promise<Values>): void {
    tail = tail.then(async () => {
      try {
        await check(await read());
      } catch (error) {
        report("*", "read:" + describe(error), () => log.warn("parts: the settings could not be read: " + describe(error)));
      }
    });
  }

  settings.onChange((next) => queue(async () => next));
  queue(() => settings.get());
  return { idle: () => tail };
}
