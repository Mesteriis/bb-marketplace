import { z } from "zod";
import { answer } from "../answer.ts";

/** Interface settings the app changes itself (the switch in the side column); BB's settings page shows the same. */
export const languageSetting = z.enum(["auto", "ru", "en"]);
export const interfaceContract = {
  interfaceSet: {input: z.object({uiLanguage: languageSetting}), output: answer({})},
};
