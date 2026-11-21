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
const MAX_PARAMS = 8;

const PROVIDER_TYPE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** Parameter names that hold a credential, anywhere in the name. */
const SECRET_NAME = /password|passcode|passwd|passphrase|pwd|secret|token|credential|cookie|api[-_]?key|authorization/i;

/** Words that mark a parameter as correspondence wherever they stand in its name. */
const CONTENT_WORDS = new Set(["text", "draft", "body", "content", "caption", "snippet", "quote", "transcript", "subject"]);

/** Words that mark correspondence only as the last word: `lastMessage`, but not `messageId`. */
const CONTENT_LAST_WORDS = new Set(["message", "messages"]);

/** Splits `messageText`, `draft_text` or `reply-body` into lowercase words. */
function nameWords(name: string): string[] {
  return name
    .split(/[^A-Za-z0-9]+|(?<=[a-z0-9])(?=[A-Z])/)
    .filter((word) => word !== "")
    .map((word) => word.toLowerCase());
}

/** Whether a parameter name says it holds correspondence rather than an identifier. */
function isContentName(name: string): boolean {
  const words = nameWords(name);
  const last = words[words.length - 1];
  return words.some((word) => CONTENT_WORDS.has(word)) || (last !== undefined && CONTENT_LAST_WORDS.has(last));
}

/** Query and fragment parameters that carry a secret inside a link. */
const SECRET_LINK_PARAM = /^(?:tk|sig|signature|key|auth|code)$/i;

/**
 * User name or password before a host: `//user:pass@host`, wherever it
 * stands in the value, since a link may be nested in the path, a parameter
 * or the fragment of another one. A link reader takes `\` for `/`.
 */
const LINK_USER_INFO = /[/\\]{2}[^/\\?#]*@/;
const LINK_PARAM = /[?&#;]([^=&#;]*)=/g;
/**
 * An identifier, a path or a link has no whitespace; prose does. A path with
 * spaces is stored percent-encoded.
 */
const WHITESPACE_OR_CONTROL = /[\s\u0000-\u001f\u007f]/;

/** A parameter name is a plain identifier, so nothing can hide in it behind an encoding. */
const PARAM_NAME = /^[A-Za-z][A-Za-z0-9_-]*$/;

const PERCENT_ESCAPE = /%([0-9a-f]{2})/gi;
const MAX_DECODE_ROUNDS = 5;

/**
 * The value as written and after each round of percent-decoding, since a
 * link reader decodes names and values and a link may be encoded again
 * inside another one. Null when the value is still encoded after the last
 * round: it cannot be checked, so it is refused.
 */
function decodedForms(value: string): string[] | null {
  const forms = [value];
  let current = value;
  for (let round = 0; round <= MAX_DECODE_ROUNDS; round += 1) {
    const next = current.replace(PERCENT_ESCAPE, (_escape, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
    if (next === current) return forms;
    if (round === MAX_DECODE_ROUNDS) return null;
    forms.push(next);
    current = next;
  }
  return null;
}

function hasSecretInPlainLink(value: string): boolean {
  if (LINK_USER_INFO.test(value)) return true;
  for (const match of value.matchAll(LINK_PARAM)) {
    const name = (match[1] ?? "").trim();
    if (SECRET_NAME.test(name) || SECRET_LINK_PARAM.test(name)) return true;
  }
  return false;
}

function hasSecretInLink(value: string): boolean {
  const forms = decodedForms(value);
  return forms === null || forms.some(hasSecretInPlainLink);
}

const paramNameSchema = z
  .string()
  .min(1)
  .max(MAX_NAME_LENGTH)
  .regex(PARAM_NAME)
  .refine((name) => !SECRET_NAME.test(name), "A panel reference must not carry credentials")
  .refine((name) => !isContentName(name), "A panel reference must not carry correspondence");

const paramTextSchema = z
  .string()
  .max(MAX_VALUE_LENGTH)
  .refine((value) => !WHITESPACE_OR_CONTROL.test(value), "A panel reference value must be an identifier without whitespace")
  .refine((value) => !hasSecretInLink(value), "A panel reference must not carry a link with a secret");

/**
 * Validates a panel reference read from storage or built by a caller.
 * Unknown top-level fields are refused, so a live handle cannot ride along.
 * This schema does not know which parameters a provider uses: it bounds
 * their number, names and shape. The provider's own `paramsSchema` refuses
 * every parameter the provider does not declare; the registry applies it
 * before it hands a reference to the provider.
 */
export const panelRefSchema: z.ZodType<PanelRef> = z.strictObject({
  provider: z.string().max(MAX_NAME_LENGTH).regex(PROVIDER_TYPE),
  params: z
    .record(paramNameSchema, z.union([paramTextSchema, z.number(), z.boolean()]))
    .refine((params) => Object.keys(params).length <= MAX_PARAMS, "A panel reference has too many parameters"),
});

/**
 * Identity of a reference: equal for two references with the same provider
 * and the same parameters, whatever the order the parameters are listed in.
 */
export function panelRefKey(ref: PanelRef): string {
  const names = Object.keys(ref.params).sort();
  return JSON.stringify([ref.provider, names.map((name) => [name, ref.params[name]])]);
}
