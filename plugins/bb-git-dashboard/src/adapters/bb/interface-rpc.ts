import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { failureFor } from "../../core/workspace.ts";

type Caller = {experimental_caller: {kind: string}};

/** The interface language: declared for BB's settings page and written by the switch in the plugin's side column. */
export function interfaceHandlers(bb: BbPluginApi) {
  const settings = bb.settings.define({
    uiLanguage: {type: "select", label: "Interface language", options: ["auto", "ru", "en"], default: "auto",
      experimental_optionLabels: {auto: "As in BB", ru: "Русский", en: "English"},
      description: "Language of the plugin's strings. Sections still being redesigned keep their present strings until then."},
  });
  return {
    interfaceSet: async (input: {uiLanguage: "auto" | "ru" | "en"}, context: Caller) => {
      if (context.experimental_caller.kind !== "client") return failureFor(undefined, "ACCESS_DENIED");
      await settings.experimental_set({uiLanguage: input.uiLanguage});
      return {ok: true as const};
    },
  };
}
