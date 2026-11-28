import { mainSettings, type MainSettings } from "../../core/settings/main.ts";
import { failureFor } from "../../core/workspace.ts";

type Caller = {experimental_caller: {kind: string}};
type Writer = (values: Record<string, unknown>) => Promise<unknown>;

/**
 * Who writes which setting. BB lets a settings handle write only the fields it declared, so each module that declares
 * a main setting adds its own writer here.
 */
export function settingsRegistry() {
  const writers: {name: string; keys: readonly string[]; write: Writer}[] = [];
  return {
    add(name: string, keys: readonly string[], write: Writer) { writers.push({name, keys, write}); },
    async set(values: Record<string, unknown>) {
      for (const writer of writers) {
        const own = Object.fromEntries(Object.entries(values).filter(([key]) => writer.keys.includes(key)));
        if (Object.keys(own).length) await writer.write(own);
      }
    },
  };
}
export type SettingsRegistry = ReturnType<typeof settingsRegistry>;

/** The settings section's write: the app only, the main settings only, each through its owner. */
export function settingsHandlers(registry: SettingsRegistry) {
  return {
    settingsSet: async (input: MainSettings, context: Caller) => {
      if (context.experimental_caller.kind !== "client") return failureFor(undefined, "ACCESS_DENIED");
      const parsed = mainSettings.safeParse(input);
      if (!parsed.success) return failureFor(undefined, "INVALID_INPUT");
      try { await registry.set(parsed.data); } catch (error) { return failureFor(error, "INVALID_INPUT"); }
      return {ok: true as const};
    },
  };
}
