// The settings Chertog declares on the BB server. All are plain switches:
// BB stores them with the plugin's settings and sends them to the windows,
// which read them through `useSettings()`. The server itself reads only the
// two part switches (see `parts-sync.ts`).
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
  tileSpace: {
    type: "boolean",
    label: "Тайловое пространство",
    description: "Страница Чертога с тайлами. Выключите, чтобы Чертог не работал в окне.",
    default: true,
  },
  navigationPart: {
    type: "boolean",
    label: "Навигация",
    description: "Makosh Navigation: группы и разделы навигации BB. Выключите, чтобы вернуть штатную навигацию.",
    default: true,
  },
  threadListPart: {
    type: "boolean",
    label: "Список тредов",
    description: "Makosh Sidebar: список «Сейчас / Проекты» и прогресс планов. Выключите, чтобы вернуть штатный список.",
    default: true,
  },
} satisfies Record<string, PluginSettingDescriptor>;

/** Declares the settings to the host and returns their handle. */
export function registerChertogSettings(settings: BbPluginApi["settings"]) {
  return settings.define(chertogSettingDescriptors);
}
