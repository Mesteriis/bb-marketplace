import { experimental_Icon, useRpc, useSettings } from "@get-bb/plugin-sdk/app";
import { useCallback, useEffect, useSyncExternalStore, type ComponentType, type FunctionComponent } from "react";
import type { rpc } from "../adapters/bb/rpc.ts";
import { resolveLanguage, type Language, type LanguageSetting } from "../core/i18n/language.ts";
import { LanguageProvider } from "../ui/i18n/use-t.tsx";
import { IconProvider } from "../ui/system/icon.tsx";

/** BB's own language: the page's lang, else the browser's. */
function bbLanguage(): string | undefined {
  if (typeof document !== "undefined" && document.documentElement.lang) return document.documentElement.lang;
  return typeof navigator === "undefined" ? undefined : navigator.language;
}

// The language just chosen, shared by every root of the app (the side column and the panel are separate React roots),
// until the saved setting catches up. Only the latest choice counts: an earlier write answering late changes nothing.
const cacheKey = "makosh-git.uiLanguage";
let chosen: LanguageSetting | null = null;
let latest = 0;
const listeners = new Set<() => void>();
const publish = (next: LanguageSetting | null) => { chosen = next; for (const listener of listeners) listener(); };
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const isSetting = (value: unknown): value is LanguageSetting => value === "auto" || value === "ru" || value === "en";
function cached(): LanguageSetting {
  try { const value = localStorage.getItem(cacheKey); return isSetting(value) ? value : "auto"; } catch { return "auto"; }
}

/**
 * The interface language outside a slot component's tree (a thread header button's `useData`): the same choice
 * withInterface makes, from the uiLanguage setting, the language just chosen, and BB's own.
 */
export function useInterfaceLanguage(): Language {
  const settings = useSettings();
  const now = useSyncExternalStore(subscribe, () => chosen);
  const stored: LanguageSetting = settings.values ? (isSetting(settings.values.uiLanguage) ? settings.values.uiLanguage : "auto") : cached();
  return resolveLanguage(now ?? stored, bbLanguage());
}

/** Accounts were added or changed in this window (the Connections count of the side column reads them again). */
const accountListeners = new Set<() => void>();
export const accountsChanged = () => { for (const listener of accountListeners) listener(); };
export function onAccountsChanged(listener: () => void) { accountListeners.add(listener); return () => { accountListeners.delete(listener); }; }

/**
 * A slot component with the plugin's interface around it: the language from the uiLanguage setting ("As in BB"
 * follows BB's language) and BB's lucide icons. A choice shows at once in every root and is saved for every window;
 * a refused write goes back to the saved setting.
 */
export function withInterface<P extends object>(Component: ComponentType<P>): FunctionComponent<P> {
  return function Interfaced(props: P) {
    const client = useRpc<typeof rpc>();
    const settings = useSettings();
    const now = useSyncExternalStore(subscribe, () => chosen);
    // While the settings load, the last language this browser showed stands in, so a saved choice does not flicker.
    const stored: LanguageSetting = settings.values ? (isSetting(settings.values.uiLanguage) ? settings.values.uiLanguage : "auto") : cached();
    useEffect(() => {
      if (!settings.values) return;
      try { localStorage.setItem(cacheKey, stored); } catch { /* No storage: the setting still decides. */ }
      if (chosen === stored) publish(null);
    }, [settings.values, stored]);
    const choose = useCallback((next: LanguageSetting) => {
      const call = ++latest;
      publish(next);
      const undo = () => { if (call === latest) publish(null); };
      client.call("interfaceSet", {uiLanguage: next}).then(result => { if (!result.ok) undo(); }, undo);
    }, [client]);
    const setting = now ?? stored;
    return <LanguageProvider language={resolveLanguage(setting, bbLanguage())} choose={choose}>
      <IconProvider value={experimental_Icon}><Component {...props}/></IconProvider>
    </LanguageProvider>;
  };
}
