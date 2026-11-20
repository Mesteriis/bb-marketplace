import { Bell, CircleCheck } from "lucide-react";
import { useState } from "react";
import { defaultTranslationLanguage, telegramInterfaceLanguage, type DefaultTranslationLanguage, type TelegramInterfaceLanguage } from "../core/contract.ts";
import { useTelegramLocale } from "./i18n/index.tsx";
import { translationLanguages } from "./message-translation.tsx";

export type LanguagePreference =
  | { kind: "interface"; value: TelegramInterfaceLanguage }
  | { kind: "translation"; value: DefaultTranslationLanguage };

export function LanguageSettings({ interfaceLanguage, translationLanguage, save }: {
  interfaceLanguage: TelegramInterfaceLanguage;
  translationLanguage: DefaultTranslationLanguage;
  save: (preference: LanguagePreference) => Promise<void>;
}) {
  const { t: tr, locale } = useTelegramLocale();
  const [pending, setPending] = useState<LanguagePreference>();
  const [failed, setFailed] = useState(false);
  const names = new Intl.DisplayNames([locale], { type: "language" });
  const orderedLanguages = translationLanguages.map(({ value, label }) => ({ value, label: names.of(value) ?? label }))
    .sort((a, b) => a.label.localeCompare(b.label, locale));

  async function update(preference: LanguagePreference) {
    setPending(preference);
    setFailed(false);
    try { await save(preference); }
    catch { setFailed(true); }
    finally { setPending(undefined); }
  }

  return <>
    <h3>{tr("Language and translation")}</h3>
    <label className="mtg-settings-row">
      <span>{tr("Telegram interface language")}</span>
      <select disabled={!!pending} value={pending?.kind === "interface" ? pending.value : interfaceLanguage}
        onChange={(event) => {
          const result = telegramInterfaceLanguage.safeParse(event.currentTarget.value);
          if (result.success) void update({ kind: "interface", value: result.data });
        }}>
        <option value="auto">{tr("System language")}</option>
        <option value="ru" lang="ru">Русский</option>
        <option value="en" lang="en">English</option>
      </select>
    </label>
    <label className="mtg-settings-row">
      <span>{tr("Default translation language")}<small>{tr("You can choose another language for any message or chat.")}</small></span>
      <select disabled={!!pending} value={pending?.kind === "translation" ? pending.value : translationLanguage}
        onChange={(event) => {
          const result = defaultTranslationLanguage.safeParse(event.currentTarget.value);
          if (result.success) void update({ kind: "translation", value: result.data });
        }}>
        <option value="auto">{tr("Same as interface")}</option>
        {orderedLanguages.map(({ value, label }) => <option value={value} key={value}>{label}</option>)}
      </select>
    </label>
    {failed && <p role="alert">{tr("Could not save the language preference.")}</p>}
  </>;
}

const permissionLabels: Record<NotificationPermission | "unsupported", string> = {
  granted: "Allowed",
  denied: "Blocked in browser settings",
  default: "Permission required",
  unsupported: "Unavailable on this device",
};

export function DesktopNotificationSettings({ permission, request }: {
  permission: NotificationPermission | "unsupported";
  request: () => Promise<void>;
}) {
  const { t: tr } = useTelegramLocale();
  return <>
    <h3>{tr("On this device")}</h3>
    <div className="mtg-settings-row">
      <span>{tr("BB system notifications")}</span>
      {permission === "default"
        ? <button type="button" className="mtg-action" onClick={() => void request()}><Bell size={16} aria-hidden="true" />{tr("Enable system notifications")}</button>
        : <span className="mtg-settings-permission" data-permission={permission}>
          {permission === "granted" && <CircleCheck size={18} aria-hidden="true" />}{tr(permissionLabels[permission])}
        </span>}
    </div>
  </>;
}
