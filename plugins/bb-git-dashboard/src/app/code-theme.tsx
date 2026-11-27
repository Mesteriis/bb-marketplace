import { experimental_useCodeTheme, experimental_usePluginId } from "@get-bb/plugin-sdk/app";
import { useMemo, type ComponentType, type FunctionComponent } from "react";
import { CodeThemeContext, type Highlighting } from "../ui/highlight/use-highlight.tsx";

/**
 * A slot component that paints its diffs in BB's live code theme: the theme follows palette and light/dark switches,
 * and nothing is painted before the first theme document resolves. Grammars come from the plugin's /grammar route.
 */
export function withCodeTheme<P extends object>(Component: ComponentType<P>): FunctionComponent<P> {
  return function Themed(props: P) {
    const {theme} = experimental_useCodeTheme();
    const pluginId = experimental_usePluginId();
    const value = useMemo<Highlighting>(() => ({theme, grammar: async id => {
      const response = await fetch("/api/v1/plugins/" + encodeURIComponent(pluginId) + "/http/grammar?id=" + encodeURIComponent(id));
      if (!response.ok) throw new Error("GRAMMAR_UNAVAILABLE");
      return response.json();
    }}), [theme, pluginId]);
    return <CodeThemeContext.Provider value={value}><Component {...props}/></CodeThemeContext.Provider>;
  };
}
