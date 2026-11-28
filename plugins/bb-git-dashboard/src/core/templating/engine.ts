import { z } from "zod";
import { CodedError } from "../workspace.ts";

/**
 * The template language of CI templates and scaffolds. `{{name}}` takes a value, `{{name|json}}` the value as a quoted
 * and escaped string; a line holding only `{{#flag}}`, `{{^flag}}`, `{{#choice=value}}` or `{{^choice=value}}` opens a
 * section that `{{/name}}` closes, and the tag lines themselves are dropped. `${{ … }}` (an Actions or Azure expression)
 * passes through.
 */

/**
 * One line of safe characters that starts with a letter, digit or underscore: substituted into YAML it cannot start a
 * key, a comment, a quote, an indicator or a new line.
 */
export const word = z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9._\/@+-]{0,99}$/);
/** One line of free text: no control characters and no template braces. */
export const line = z.string().max(200).regex(/^[^\u0000-\u001f\u007f]*$/).refine(value => !/\{\{|\}\}/.test(value));
const name = z.string().regex(/^[a-z][A-Za-z0-9]{0,39}$/);
const group = String.raw`\((?:[^()\\]|\\.)*`;
const nested = new RegExp(group + String.raw`(?:[+*|]|\{\d)(?:[^()\\]|\\.)*\)(?:[+*]|\{\d)`);
const label = z.string().min(1).max(80);
export const templateParam = z.discriminatedUnion("kind", [
  /**
   * `pattern` narrows the values further (a package or module name), as a regular expression source. A quantified
   * group holding a quantifier or an alternation is refused: such a pattern can take exponential time on one value.
   */
  z.object({name, label, kind: z.literal("text"), default: word,
    pattern: z.string().max(200).refine(source => { try { new RegExp(source, "u"); return !nested.test(source); } catch { return false; } }).optional()}),
  z.object({name, label, kind: z.literal("choice"), default: word, choices: z.array(word).min(1).max(20)}),
  z.object({name, label, kind: z.literal("flag"), default: z.boolean()}),
  /** Free text such as a description or an author: as it is only in raw text (Markdown, plain), elsewhere through |json. */
  z.object({name, label, kind: z.literal("line"), default: line}),
]);
export type TemplateParam = z.infer<typeof templateParam>;
export type TemplateValues = Record<string, string | boolean>;

export const invalid = (detail: string) => new CodedError("TEMPLATE_INVALID", detail);
const fits = (param: TemplateParam, value: unknown) => param.kind === "flag" ? typeof value === "boolean"
  : param.kind === "line" ? typeof value === "string" && line.safeParse(value).success
  : typeof value === "string" && word.safeParse(value).success
    && (param.kind === "text" ? !param.pattern || new RegExp(param.pattern, "u").test(value) : param.choices.includes(value));

/**
 * The values to render with: the ones given, else a suggestion when it fits the parameter, else the default. A given
 * value that does not fit, or names no parameter, is refused.
 */
export function resolveParams(params: TemplateParam[], given: TemplateValues, suggested: Record<string, string | boolean>): TemplateValues {
  for (const key of Object.keys(given)) if (!params.some(param => param.name === key)) throw invalid("unknown parameter " + key);
  const values: TemplateValues = {};
  for (const param of params) {
    if (Object.hasOwn(given, param.name)) {
      if (!fits(param, given[param.name])) throw invalid("value of " + param.name + " does not fit the parameter");
      values[param.name] = given[param.name]!;
    } else if (Object.hasOwn(suggested, param.name) && fits(param, suggested[param.name])) values[param.name] = suggested[param.name]!;
    else if (fits(param, param.default)) values[param.name] = param.default;
    else throw invalid("the default of " + param.name + " does not fit the parameter");
  }
  return values;
}

const open = /^\{\{([#^])([A-Za-z][A-Za-z0-9]*)(?:=([A-Za-z0-9._\/@+-]+))?\}\}$/;
const close = /^\{\{\/([A-Za-z][A-Za-z0-9]*)\}\}$/;
const placeholder = /(?<!\$)\{\{([A-Za-z][A-Za-z0-9]*)(?:\|([a-z]+))?\}\}/g;

/** Substitutes one line; `raw` allows free text without |json (Markdown and plain text). */
export function substitute(text: string, params: Map<string, TemplateParam>, values: TemplateValues, raw: boolean) {
  if (/(?<!\$)\{\{[#^/]/.test(text)) throw invalid("a section tag must stand on its own line");
  // Any other {{ is someone else's syntax (Vue, Jinja, Handlebars): refused, not passed through silently.
  for (const match of text.matchAll(/(?<!\$)\{\{/g)) {
    if (!/^\{\{[A-Za-z][A-Za-z0-9]*(?:\|[a-z]+)?\}\}/.test(text.slice(match.index))) {
      const shown = /^\{\{[^\n]{0,40}?\}\}/.exec(text.slice(match.index))?.[0] ?? text.slice(match.index, match.index + 20);
      throw invalid(JSON.stringify(shown) + " is no template value; list the file under verbatim, or write ${{ for an expression");
    }
  }
  return text.replace(placeholder, (_, key: string, filter: string | undefined) => {
    const param = params.get(key);
    if (!param) throw invalid("unknown name " + key);
    if (param.kind === "flag") throw invalid("flag " + key + " used as text");
    if (filter !== undefined && filter !== "json") throw invalid("unknown filter " + filter);
    if (filter === "json") return JSON.stringify(String(values[key]));
    if (param.kind === "line" && !raw) throw invalid("free text " + key + " needs |json here");
    return String(values[key]);
  });
}

/** Renders a text with resolved values; every line is checked whether its section is kept or not. */
export function renderText(text: string, list: TemplateParam[], values: TemplateValues, {raw}: {raw: boolean}): string {
  const params = new Map(list.map(param => [param.name, param]));
  const stack: {name: string; keep: boolean}[] = [];
  const out: string[] = [];
  // Prose: a line that is only a value, left empty (an empty description), goes with the blank line after it, so no
  // empty paragraph stays behind.
  let dropBlank = false;
  for (const current of text.split("\n")) {
    const tag = current.trim();
    const opening = open.exec(tag);
    const closing = close.exec(tag);
    if (opening) {
      const [, sign, key, expected] = opening;
      const param = params.get(key!);
      if (!param || param.kind === "text" || param.kind === "line" || (param.kind === "flag") !== (expected === undefined)
        || (param.kind === "choice" && !param.choices.includes(expected!))) throw invalid("section " + key + " needs a flag, or a choice and one of its values");
      const truth = param.kind === "flag" ? values[key!] === true : values[key!] === expected;
      stack.push({name: key!, keep: sign === "#" ? truth : !truth});
    } else if (closing) {
      if (stack.pop()?.name !== closing[1]) throw invalid("section " + closing[1] + " closes no open section");
    } else {
      const done = substitute(current, params, values, raw);
      if (!stack.every(section => section.keep)) continue;
      if (raw && /^\{\{[a-z][A-Za-z0-9]*\}\}$/.test(tag) && done.trim() === "") { dropBlank = true; continue; }
      if (dropBlank && done.trim() === "" && out.at(-1)?.trim() === "") { dropBlank = false; continue; }
      dropBlank = false;
      out.push(done);
    }
  }
  if (stack.length) throw invalid("section " + stack.at(-1)!.name + " is not closed");
  return out.join("\n");
}

const secretRules: [string, RegExp][] = [
  ["a private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["a forge or cloud token", /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|xox[abposr]-[A-Za-z0-9-]{10,})/],
  ["credentials in an address", /[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i],
  // Loopback (127.x) and the any-address (0.0.0.0) name no machine.
  ["an IP address", /\b(?!127\.|0\.0\.0\.0\b)(?:\d{1,3}\.){3}\d{1,3}\b/],
];
const addressRules: [string, RegExp][] = [
  // A pipeline that names a server can send what it builds, or its secrets, there: CI templates name none.
  ["an address", /\b[a-z][a-z0-9+.-]*:\/\//i],
  ["a .env file", /(?:^|[\s/"'=:])\.env(?:\.[A-Za-z0-9_-]+)?(?=$|[\s"';&|)])/m],
];
/**
 * What in a text looks like a secret or a machine's address. With `addresses` (CI templates) any address and any
 * `.env` reference count too; scaffolds name public documentation and ignore `.env` files, so they leave it off.
 */
export const secretIssues = (text: string, {addresses = true}: {addresses?: boolean} = {}) =>
  [...secretRules, ...(addresses ? addressRules : [])].filter(([, rule]) => rule.test(text)).map(([label]) => label);
