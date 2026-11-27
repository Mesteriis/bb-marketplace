import { z } from "zod";
import { answer } from "../answer.ts";

/** Interface settings the app changes itself (the language switch, the overview's view); BB's settings page shows the same. */
export const languageSetting = z.enum(["auto", "ru", "en"]);
export const overviewView = z.enum(["list", "board"]);
export const interfaceContract = {
  interfaceSet: {input: z.object({uiLanguage: languageSetting.optional(), overviewView: overviewView.optional()}), output: answer({})},
};
