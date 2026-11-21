// The settings Chertog declares on the BB server. Both are plain switches:
// BB stores them with the plugin's settings and sends them to the windows,
// which read them through `useSettings()`.
import type { BbPluginApi, PluginSettingDescriptor } from "@get-bb/plugin-sdk";

/** The declared settings by key. The keys are the names the windows read. */
export const chertogSettingDescriptors = {
  homeRedirect: {
    type: "boolean",
    label: "Открывать Чертог вместо штатного Домой",
    // The limits in one sentence; docs/home-redirect.md lists them all.
    description:
      "Перенаправляет только корневой экран нового треда: штатная команда нового треда без проекта и «Домой» в новой вкладке тоже откроют Чертог, а перед переходом может мелькнуть штатный экран.",
    default: true,
  },
  acceptanceFixture: {
    type: "boolean",
    label: "Тестовая панель для приёмки",
    default: false,
  },
} satisfies Record<string, PluginSettingDescriptor>;

/** Declares the settings to the host. The server reads none of them itself. */
export function registerChertogSettings(settings: BbPluginApi["settings"]): void {
  settings.define(chertogSettingDescriptors);
}
