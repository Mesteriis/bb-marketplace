import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { failureFor } from "../../core/workspace.ts";

type Caller = {experimental_caller: {kind: string}};

/** Interface settings: the language (the side column's switch) and the overview's view, declared for BB's settings page too. */
export function interfaceHandlers(bb: BbPluginApi) {
  const settings = bb.settings.define({
    uiLanguage: {type: "select", label: "Interface language", options: ["auto", "ru", "en"], default: "auto",
      experimental_optionLabels: {auto: "As in BB", ru: "Русский", en: "English"},
      description: "Language of the plugin's strings. Sections still being redesigned keep their present strings until then."},
    overviewView: {type: "select", label: "Overview opens as", options: ["list", "board"], default: "list",
      experimental_optionLabels: {list: "List", board: "Board"}, description: "The overview's view when it opens: a list of what needs you, or a board by stage."},
  });
  return {
    interfaceSet: async (input: {uiLanguage?: "auto" | "ru" | "en" | undefined; overviewView?: "list" | "board" | undefined}, context: Caller) => {
      if (context.experimental_caller.kind !== "client") return failureFor(undefined, "ACCESS_DENIED");
      await settings.experimental_set({...(input.uiLanguage ? {uiLanguage: input.uiLanguage} : {}), ...(input.overviewView ? {overviewView: input.overviewView} : {})});
      return {ok: true as const};
    },
  };
}
