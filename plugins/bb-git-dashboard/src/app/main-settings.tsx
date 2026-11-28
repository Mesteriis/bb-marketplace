import { useRpc, useSettings } from "@get-bb/plugin-sdk/app";
import { useCallback } from "react";
import type { rpc } from "../adapters/bb/rpc.ts";
import type { MainSettings } from "../core/settings/main.ts";
import { format } from "../core/i18n/language.ts";
import { useLanguage } from "../ui/i18n/use-t.tsx";
import { SettingsPanel, type SettingValues } from "../ui/settings/settings-panel.tsx";

/** The plugin's settings section: the saved values from BB, written through the plugin's own settingsSet. */
export function MainSettingsSection() {
  const client = useRpc<typeof rpc>();
  const {language} = useLanguage();
  const raw = useSettings().values as Record<string, unknown> | undefined;
  const values: SettingValues | null = raw ? {
    projectsRoot: String(raw.projectsRoot ?? ""),
    uiLanguage: raw.uiLanguage === "ru" || raw.uiLanguage === "en" ? raw.uiLanguage : "auto",
    overviewView: raw.overviewView === "board" ? "board" : "list",
    inboxNotifyCi: raw.inboxNotifyCi !== false,
    inboxNotifyComments: raw.inboxNotifyComments !== false,
    aiPermissionMode: raw.aiPermissionMode === "accept-edits" ? "accept-edits" : "auto",
    ciTemplatesFolder: String(raw.ciTemplatesFolder ?? ""),
  } : null;
  const onSet = useCallback(async (change: MainSettings) => {
    const answer = await client.call("settingsSet", change);
    return answer.ok ? null : format(language, "st.refused", {code: answer.code});
  }, [client, language]);
  const onTest = useCallback(async () => {
    const answer = await client.call("inboxTest", {});
    return answer.ok ? answer.push.message + " " + format(language, "st.test-in-inbox") : format(language, "st.test-refused", {code: answer.code});
  }, [client, language]);
  return <div className="git-ws"><SettingsPanel values={values} onSet={onSet} onTest={onTest}/></div>;
}
