import { z } from "zod";
import { CodedError } from "../workspace.ts";
import { stackIds, type StackValues } from "./stack.ts";

/** One line of safe characters: substituted into YAML it cannot start a key, a comment, a quote or a new line. */
const word = z.string().regex(/^[A-Za-z0-9._\/@+-]{1,100}$/);
const name = z.string().regex(/^[a-z][A-Za-z0-9]{0,39}$/);
export const ciParam = z.discriminatedUnion("kind", [
  z.object({name, label: z.string().min(1).max(80), kind: z.literal("text"), default: word}),
  z.object({name, label: z.string().min(1).max(80), kind: z.literal("choice"), default: word, choices: z.array(word).min(1).max(20)}),
  z.object({name, label: z.string().min(1).max(80), kind: z.literal("flag"), default: z.boolean()}),
]);
export type CiParam = z.infer<typeof ciParam>;
export const ciForge = z.enum(["github", "gitea", "gitlab", "azure"]);
export type CiForge = z.infer<typeof ciForge>;
/** A CI template: the forge it runs on, the stacks it suits, the file it writes and its parameters. */
export const ciTemplate = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/), title: z.string().min(1).max(100), description: z.string().max(300).optional(),
  forge: ciForge, stacks: z.array(z.enum(stackIds)).max(stackIds.length), path: z.string().min(1).max(200),
  params: z.array(ciParam).max(20), body: z.string().min(1).max(64 * 1024),
});
export type CiTemplate = z.infer<typeof ciTemplate>;
export type CiValues = Record<string, string | boolean>;

const invalid = (detail: string) => new CodedError("TEMPLATE_INVALID", detail);
const fits = (param: CiParam, value: unknown) => param.kind === "flag" ? typeof value === "boolean"
  : typeof value === "string" && word.safeParse(value).success && (param.kind === "text" || param.choices.includes(value));

/**
 * The values a template renders with: the ones given, else the stack's suggestion when it fits the parameter, else the
 * template's default. A given value that does not fit, or names no parameter, is refused.
 */
export function resolveValues(template: CiTemplate, given: CiValues, stack: StackValues): CiValues {
  for (const key of Object.keys(given)) if (!template.params.some(param => param.name === key)) throw invalid("unknown parameter " + key);
  const values: CiValues = {};
  for (const param of template.params) {
    if (Object.hasOwn(given, param.name)) {
      if (!fits(param, given[param.name])) throw invalid("value of " + param.name + " does not fit the parameter");
      values[param.name] = given[param.name];
    } else values[param.name] = Object.hasOwn(stack, param.name) && fits(param, stack[param.name]) ? stack[param.name] : param.default;
  }
  return values;
}

const open = /^\{\{([#^])([A-Za-z][A-Za-z0-9]*)(?:=([A-Za-z0-9._\/@+-]+))?\}\}$/;
const close = /^\{\{\/([A-Za-z][A-Za-z0-9]*)\}\}$/;
// `${{ … }}` is a GitHub, Gitea or Azure expression and passes through.
const placeholder = /(?<!\$)\{\{([A-Za-z][A-Za-z0-9]*)\}\}/g;

function substitute(line: string, params: Map<string, CiParam>, values: CiValues) {
  if (/(?<!\$)\{\{[#^/]/.test(line)) throw invalid("a section tag must stand on its own line");
  return line.replace(placeholder, (_, key: string) => {
    const param = params.get(key);
    if (!param) throw invalid("unknown name " + key);
    if (param.kind === "flag") throw invalid("flag " + key + " used as text");
    return String(values[key]);
  });
}

function safePath(path: string) {
  const parts = path.split("/");
  if (!/\.ya?ml$/.test(path) || parts[0] === ".git" || parts.some(part => !/^[A-Za-z0-9._-]+$/.test(part) || part === "." || part === "..")
    || /^\.env/.test(parts.at(-1)!)) throw invalid("unsafe file path " + path);
  return path;
}

/**
 * Renders a template with resolved values. `{{name}}` takes a text or choice value; a line holding only `{{#flag}}`,
 * `{{^flag}}`, `{{#choice=value}}` or `{{^choice=value}}` opens a section that `{{/name}}` closes, and the tag lines
 * themselves are dropped.
 */
export function renderTemplate(template: CiTemplate, values: CiValues): {path: string; text: string} {
  const params = new Map(template.params.map(param => [param.name, param]));
  const stack: {name: string; keep: boolean}[] = [];
  const out: string[] = [];
  for (const line of template.body.split("\n")) {
    const tag = line.trim();
    const opening = open.exec(tag);
    const closing = close.exec(tag);
    if (opening) {
      const [, sign, key, expected] = opening;
      const param = params.get(key);
      if (!param || param.kind === "text" || (param.kind === "flag") !== (expected === undefined)
        || (param.kind === "choice" && !param.choices.includes(expected!))) throw invalid("section " + key + " needs a flag, or a choice and one of its values");
      const truth = param.kind === "flag" ? values[key] === true : values[key] === expected;
      stack.push({name: key, keep: sign === "#" ? truth : !truth});
    } else if (closing) {
      if (stack.pop()?.name !== closing[1]) throw invalid("section " + closing[1] + " closes no open section");
    } else if (stack.every(section => section.keep)) out.push(substitute(line, params, values));
  }
  if (stack.length) throw invalid("section " + stack.at(-1)!.name + " is not closed");
  return {path: safePath(substitute(template.path, params, values)), text: out.join("\n")};
}

const secretRules: [string, RegExp][] = [
  ["a private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["a forge or cloud token", /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|xox[abposr]-[A-Za-z0-9-]{10,})/],
  ["credentials in an address", /[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i],
  ["an IP address", /\b(?:\d{1,3}\.){3}\d{1,3}\b/],
];
/** What in a text looks like a secret or a machine's address, which a template must not carry. */
export const secretIssues = (text: string) => secretRules.filter(([, rule]) => rule.test(text)).map(([label]) => label);

/** Why a template cannot be offered: its format, a render with its own defaults, and secret-like content. */
export function templateIssues(raw: unknown): string[] {
  const parsed = ciTemplate.safeParse(raw);
  if (!parsed.success) return ["The template does not match the template format."];
  try {
    const rendered = renderTemplate(parsed.data, resolveValues(parsed.data, {}, {}));
    return secretIssues(rendered.path + "\n" + parsed.data.body).map(issue => "The template has " + issue + ".");
  } catch (error) {
    return ["The template does not render: " + (error instanceof CodedError ? error.detail : "unknown error") + "."];
  }
}
