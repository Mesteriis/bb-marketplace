// What a template carries beside its text (typing speed): a subject and
// recipients, and the `{first_name}` variable filled on insert. Pure.
import { ComposeError } from "./compose.ts";
import { parseAddress } from "./compose-address.ts";

export const TEMPLATE_SUBJECT_MAX = 200;
/** To, Cc and Bcc of one template together. */
export const TEMPLATE_RECIPIENTS_MAX = 20;
/** Files of one template: how many, and their bytes together. */
export const TEMPLATE_FILES_MAX = 5;
export const TEMPLATE_FILES_MAX_BYTES = 10 * 1024 * 1024;

export type TemplateExtras = { subject: string | null; to: string[]; cc: string[]; bcc: string[] };
export const NO_EXTRAS: TemplateExtras = { subject: null, to: [], cc: [], bcc: [] };

const LINE_BREAKS = /[\r\n\u0000\u0085\u2028\u2029]/;

const addressKey = (text: string): string | null => {
  const parsed = parseAddress(text);
  return parsed.ok ? parsed.value.address.toLowerCase() : null;
};

/** A template's subject and recipients as stored. Throws `ComposeError("invalid")`. */
export function normalizeExtras(input: Partial<Record<keyof TemplateExtras, unknown>> | undefined): TemplateExtras {
  if (input === undefined) return NO_EXTRAS;
  let subject: string | null = null;
  if (input.subject !== undefined && input.subject !== null) {
    if (typeof input.subject !== "string" || LINE_BREAKS.test(input.subject)) throw new ComposeError("invalid");
    const text = input.subject.trim();
    if ([...text].length > TEMPLATE_SUBJECT_MAX) throw new ComposeError("invalid");
    subject = text === "" ? null : text;
  }
  const seen = new Set<string>();
  const list = (value: unknown): string[] => {
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw new ComposeError("invalid");
    const out: string[] = [];
    for (const item of value) {
      if (typeof item !== "string" || LINE_BREAKS.test(item)) throw new ComposeError("invalid");
      const key = addressKey(item);
      if (key === null) throw new ComposeError("invalid", "A template's recipient is not a valid address");
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(item.trim());
    }
    return out;
  };
  const extras = { subject, to: list(input.to), cc: list(input.cc), bcc: list(input.bcc) };
  if (seen.size > TEMPLATE_RECIPIENTS_MAX) throw new ComposeError("invalid", "A template holds at most 20 recipients");
  return extras;
}

/** Local parts that name a role, not a person. */
const ROLES = new Set(["info", "hello", "hi", "contact", "sales", "support", "team", "admin", "office", "mail", "noreply", "no-reply", "billing", "help"]);

const capital = (word: string) => word[0]!.toLocaleUpperCase() + word.slice(1).toLocaleLowerCase();

/** A recipient's first name: the display name's first word, else the local part up to a dot or underscore; null for a role or a code. */
export function firstNameOf(recipient: { name: string | null; address: string } | undefined): string | null {
  if (recipient === undefined) return null;
  const name = (recipient.name ?? "").trim();
  const fromName = name !== "" && !name.includes("@") ? name.split(/\s+/)[0]! : null;
  const word = fromName ?? recipient.address.split("@")[0]!.split(/[._+-]/)[0]!;
  if (!/^\p{L}{2,}$/u.test(word) || (fromName === null && ROLES.has(word.toLowerCase()))) return null;
  return capital(word);
}

const VARIABLE = /\{first_name\}/gi;

export function hasVariable(text: string): boolean {
  return /\{first_name\}/i.test(text);
}

/** `{first_name}` filled where a name is known; left as typed otherwise. */
export function fillVariables(text: string, firstName: string | null): string {
  return firstName === null ? text : text.replace(VARIABLE, firstName);
}

type Node = { type: string; text?: string; content?: Node[]; [key: string]: unknown };

/** A copy of a document's blocks with the variables of every text filled. */
export function fillBlocks<T extends { type: string }>(blocks: readonly T[], firstName: string | null): T[] {
  const fill = (node: Node): Node => ({
    ...node,
    ...(typeof node.text === "string" ? { text: fillVariables(node.text, firstName) } : {}),
    ...(Array.isArray(node.content) ? { content: node.content.map(fill) } : {}),
  });
  return blocks.map((block) => fill(block as unknown as Node) as unknown as T);
}

/** `field` plus the template's addresses that the draft has in none of its fields. */
export function mergeRecipients(field: readonly string[], add: readonly string[], elsewhere: readonly string[]): string[] {
  const have = new Set([...field, ...elsewhere].map(addressKey).filter((key): key is string => key !== null));
  const out = [...field];
  for (const address of add) {
    const key = addressKey(address);
    if (key === null || have.has(key)) continue;
    have.add(key);
    out.push(address);
  }
  return out;
}
