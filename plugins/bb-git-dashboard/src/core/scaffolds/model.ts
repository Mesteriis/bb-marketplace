import { z } from "zod";
import { CodedError } from "../workspace.ts";
import { invalid, renderText, resolveParams, secretIssues, substitute, templateParam, type TemplateParam, type TemplateValues } from "../templating/engine.ts";
import { commonParams, derivedParams, overlayFiles } from "./overlay.ts";

const condition = z.string().regex(/^!?[a-z][A-Za-z0-9]*(?:!?=[A-Za-z0-9._\/@+-]+)?$/);
export const scaffoldFile = z.object({
  path: z.string().max(200), body: z.string().max(256 * 1024),
  /** `flag`, `!flag`, `choice=value` or `choice!=value`: the file is written only then. */
  when: condition.optional(),
  executable: z.boolean().optional(),
});
/** A project skeleton: its parameters, its files (path and body are templates) and its additions to the common files. */
export const scaffold = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/), title: z.string().min(1).max(100), description: z.string().max(400),
  params: z.array(templateParam).max(30), files: z.array(scaffoldFile).max(300),
  /** Lines added to the common `.gitignore`. */
  ignore: z.array(z.string().max(200)).max(100).optional(),
  /** Sections added to the common `.editorconfig`. */
  editorconfig: z.string().max(4000).optional(),
  /** Values for the CI template of the created project, over those its files suggest. */
  ci: z.record(z.string(), z.union([z.string(), z.boolean()])).optional(),
});
export type Scaffold = z.infer<typeof scaffold>;
export type ScaffoldOutput = {path: string; text: string; executable: boolean};

/** A file whose text is prose, where free text goes as it is; every other file is code or configuration. */
const prose = (path: string) => /\.(md|txt)$/i.test(path) || /(^|\/)(LICENSE|NOTICE)$/.test(path);
const folderName = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/;
/** Found secret-like text: named apart from a template that does not render. */
class SecretFound extends CodedError {}

function holds(when: string | undefined, values: TemplateValues, params: Map<string, TemplateParam>) {
  if (!when) return true;
  const [, not, key, op, expected] = /^(!?)([a-z][A-Za-z0-9]*)(?:(!?=)(.+))?$/.exec(when)!;
  const param = params.get(key!);
  if (!param || (op ? param.kind !== "choice" || !param.choices.includes(expected!) : param.kind !== "flag"))
    throw invalid("condition " + when + " needs a flag, or a choice and one of its values");
  return op ? (values[key!] === expected) === (op === "=") : (values[key!] === true) !== (not === "!");
}

function safePath(path: string) {
  const parts = path.split("/");
  const file = parts.at(-1)!;
  if (!path || parts.some(part => !/^[A-Za-z0-9_.@+-]+$/.test(part) || part === "." || part === "..") || parts[0] === ".git"
    || (/^\.env(\.|$)/.test(file) && file !== ".env.example")) throw invalid("unsafe file path " + JSON.stringify(path));
  return path;
}

/**
 * The files of a scaffold for the given values: the common files first, then the scaffold's own, a file of the same path
 * replacing the common one. Free text is checked to fit its file, paths to stay inside the project and away from
 * `.git` and `.env`, and every file to carry nothing secret-like.
 */
export function buildScaffold(source: Scaffold, given: TemplateValues, suggested: Record<string, string | boolean>):
  {values: TemplateValues; files: ScaffoldOutput[]} {
  const list = [...commonParams, ...source.params];
  const values = resolveParams(list, given, suggested);
  if (!folderName.test(String(values.name))) throw invalid("the project name must be a folder name: letters, digits, '.', '_' and '-'");
  const author = String(values.author).trim();
  const params = new Map([...list, ...derivedParams].map(param => [param.name, param]));
  const all = {...values, holder: author || values.name + " contributors"};
  const render = (files: {path: string; body: string; when?: string; executable?: boolean}[]) => {
    const out = new Map<string, ScaffoldOutput>();
    for (const file of files) {
      if (!holds(file.when, all, params)) continue;
      const path = safePath(substitute(file.path, params, all, false));
      if (out.has(path)) throw invalid("two files have the path " + path);
      const text = renderText(file.body, [...params.values()], all, {raw: prose(path)});
      const found = secretIssues(text, {addresses: false});
      if (found.length) throw new SecretFound("TEMPLATE_INVALID", path + " has " + found.join(", "));
      out.set(path, {path, text, executable: file.executable === true});
    }
    return out;
  };
  const files = new Map([...render(overlayFiles(source)), ...render(source.files)]);
  const size = [...files.values()].reduce((sum, file) => sum + file.text.length, 0);
  if (size > 2 * 1024 * 1024) throw invalid("the project's files are over 2 MB together");
  return {values, files: [...files.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)};
}

/** Every value of every choice and flag, one parameter at a time from the defaults. */
export function variants(params: TemplateParam[]): TemplateValues[] {
  const defaults = Object.fromEntries(params.map(param => [param.name, param.default]));
  const out: TemplateValues[] = [defaults];
  for (const param of params) {
    if (param.kind === "choice") for (const choice of param.choices) out.push({...defaults, [param.name]: choice});
    if (param.kind === "flag") out.push({...defaults, [param.name]: !param.default});
  }
  return out;
}

/** Why a scaffold cannot be offered: its format, the common names, a render with every choice and flag, secret-like text. */
export function scaffoldIssues(raw: unknown): string[] {
  const parsed = scaffold.safeParse(raw);
  if (!parsed.success) return ["The scaffold does not match the scaffold format."];
  const taken = parsed.data.params.map(param => param.name).filter(name => [...commonParams, ...derivedParams].some(param => param.name === name));
  if (taken.length) return taken.map(name => "The scaffold redefines the common parameter " + name + ".");
  try {
    for (const values of variants([...commonParams, ...parsed.data.params])) buildScaffold(parsed.data, values, {});
    return [];
  } catch (error) {
    if (error instanceof SecretFound) return [error.detail + "."];
    return ["The scaffold does not render: " + (error instanceof CodedError ? error.detail : "unknown error") + "."];
  }
}
