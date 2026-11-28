import { en, type MessageKey } from "../i18n/dictionary.ts";

/**
 * The dictionary key of a scaffold parameter's label, `sc.<scaffold>.<parameter>`, when the plugin has one (its own
 * scaffolds); null for a scaffold of the owner's, whose label is shown as written.
 */
export function scaffoldLabelKey(scaffoldId: string, param: string): MessageKey | null {
  const key = "sc." + scaffoldId + "." + param;
  return Object.hasOwn(en, key) ? key as MessageKey : null;
}
