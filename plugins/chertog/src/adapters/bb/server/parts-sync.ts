// Until Navigation and the thread list are absorbed into Chertog, the
// switches «Навигация» and «Список тредов» enable and disable the plugins
// that still provide them (makosh-navigation, makosh-sidebar) through
// `bb.sdk.plugins`. The rule is `decidePartAction` in the core; this file
// only gathers the facts and makes the calls.
//
// BB tells the server about a settings write through the handle's
// `onChange`. A switch acts only when its own value changes: nothing runs at
// start or for another key, so a plugin the owner switched by hand is never
// put back. A failure never reaches the plugin factory; it is logged once.
import type { BbPluginApi, PluginLogger, PluginSettingValue } from "@get-bb/plugin-sdk";
import { decidePartAction, isPartTransition, type PluginState } from "../../../core/parts/index.ts";

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
    onChange(listener: (next: Values, prev: Values) => void): void;
  };
  /** Read when a change arrives, not when the plugin loads: the SDK is bound late. */
  readonly plugins: () => Pick<BbPluginApi["sdk"]["plugins"], "list" | "enable" | "disable">;
  readonly log: Pick<PluginLogger, "info" | "warn">;
}

export interface PartSync {
  /** Resolves when every change seen so far has been handled. It never rejects. */
  idle(): Promise<void>;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const asBoolean = (value: PluginSettingValue | undefined): boolean | undefined => (typeof value === "boolean" ? value : undefined);

export function startPartSync({ settings, plugins, log }: PartSyncDeps): PartSync {
  let tail: Promise<void> = Promise.resolve();

  async function handle(next: Values, prev: Values): Promise<void> {
    const moved = PART_TOGGLES.filter(({ key }) => isPartTransition(asBoolean(prev[key]), asBoolean(next[key])));
    if (moved.length === 0) return;
    let inventory: Awaited<ReturnType<ReturnType<PartSyncDeps["plugins"]>["list"]>>;
    try {
      inventory = await plugins().list();
    } catch (error) {
      log.warn("parts: the plugin inventory could not be read: " + describe(error));
      return;
    }
    for (const { key, pluginId } of moved) {
      const entry = inventory.plugins.find((plugin) => plugin.id === pluginId);
      const state: PluginState = entry === undefined ? "not-installed" : entry.enabled ? "enabled" : "disabled";
      const action = decidePartAction(asBoolean(prev[key]), asBoolean(next[key]), state);
      if (action === "not-installed") {
        log.info(`parts: ${pluginId} is not installed; the switch ${key} has nothing to control`);
      } else if (action !== "nothing") {
        try {
          await (action === "enable" ? plugins().enable({ pluginId }) : plugins().disable({ pluginId }));
        } catch (error) {
          log.warn(`parts: could not ${action} ${pluginId}: ${describe(error)}`);
        }
      }
    }
  }

  settings.onChange((next, prev) => {
    tail = tail.then(() => handle(next, prev)).catch((error) => log.warn("parts: " + describe(error)));
  });
  return { idle: () => tail };
}
