/** Settings the catalog cannot work without; both are empty by default (ruling R11). */
export const SETTING_NAMES = ["marketplaceRepoPath", "marketplaceProjectId"] as const;
export type SettingName = (typeof SETTING_NAMES)[number];

/** Settings left empty (blank counts as empty), in a stable order. */
export function missingSettings(values: Record<SettingName, string | undefined>): SettingName[] {
  return SETTING_NAMES.filter((name) => (values[name] ?? "").trim() === "");
}

/** The error an action raises when a setting it needs is empty. */
export function settingMissingError(pluginId: string, name: SettingName): Error {
  return new Error(`не задана настройка ${name}: bb plugin config ${pluginId} set ${name} <значение>`);
}
