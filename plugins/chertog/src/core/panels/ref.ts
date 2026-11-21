// The long-lived panel reference: what a saved layout keeps about a panel.
// It names the provider type and the parameters the provider needs to find
// the panel again after a restart. It never carries a live handle (process,
// DOM node, WebContents, instance id) and never carries credentials, message
// text, tokens or links with a password.
import { z } from "zod";

/** Value of one restore parameter. */
export type PanelParam = string | number | boolean;

export interface PanelRef {
  /** Provider type, a lowercase slug such as `bb-thread`. */
  readonly provider: string;
  /** Identifiers the provider resolves the panel from. */
  readonly params: Readonly<Record<string, PanelParam>>;
}

const MAX_NAME_LENGTH = 64;
const MAX_VALUE_LENGTH = 512;

const PROVIDER_TYPE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** Parameter names that hold a credential, anywhere in the name. */
const SECRET_NAME = /password|passcode|passwd|passphrase|pwd|secret|token|credential|cookie|api[-_]?key|authorization/i;

/** Parameter names that hold correspondence rather than an identifier. */
const CONTENT_NAME = /^(?:text|draft|body|message|content|caption)$/i;

/** Query and fragment parameters that carry a secret inside a link. */
const SECRET_LINK_PARAM = /^(?:tk|sig|signature|key|auth|code)$/i;

const LINK_USER_INFO = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*@/i;
const LINK_PARAM = /[?&#;]([^=&#;]*)=/g;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

function hasSecretInLink(value: string): boolean {
  if (LINK_USER_INFO.test(value)) return true;
  for (const match of value.matchAll(LINK_PARAM)) {
    const name = match[1] ?? "";
    if (SECRET_NAME.test(name) || SECRET_LINK_PARAM.test(name)) return true;
  }
  return false;
}

const paramNameSchema = z
  .string()
  .min(1)
  .max(MAX_NAME_LENGTH)
  .refine((name) => !SECRET_NAME.test(name), "A panel reference must not carry credentials")
  .refine((name) => !CONTENT_NAME.test(name), "A panel reference must not carry correspondence");

const paramTextSchema = z
  .string()
  .max(MAX_VALUE_LENGTH)
  .refine((value) => !CONTROL_CHARACTER.test(value), "A panel reference value must be a single line")
  .refine((value) => !hasSecretInLink(value), "A panel reference must not carry a link with a secret");

/**
 * Validates a panel reference read from storage or built by a caller.
 * Unknown top-level fields are refused, so a live handle cannot ride along.
 */
export const panelRefSchema: z.ZodType<PanelRef> = z.strictObject({
  provider: z.string().max(MAX_NAME_LENGTH).regex(PROVIDER_TYPE),
  params: z.record(paramNameSchema, z.union([paramTextSchema, z.number(), z.boolean()])),
});

/**
 * Identity of a reference: equal for two references with the same provider
 * and the same parameters, whatever the order the parameters are listed in.
 */
export function panelRefKey(ref: PanelRef): string {
  const names = Object.keys(ref.params).sort();
  return JSON.stringify([ref.provider, names.map((name) => [name, ref.params[name]])]);
}
