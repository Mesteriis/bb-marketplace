import { z } from "zod";
import { CodedError } from "../workspace.ts";
import { invalid, renderText, resolveParams, secretIssues, substitute, templateParam, type TemplateParam, type TemplateValues } from "../templating/engine.ts";
import { stackIds, type StackValues } from "./stack.ts";

export { secretIssues };

export const ciParam = templateParam;
export type CiParam = TemplateParam;
export const ciForge = z.enum(["github", "gitea", "gitlab", "azure"]);
export type CiForge = z.infer<typeof ciForge>;
/** A CI template: the forge it runs on, the stacks it suits, the file it writes and its parameters. */
export const ciTemplate = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/), title: z.string().min(1).max(100), description: z.string().max(300).optional(),
  forge: ciForge, stacks: z.array(z.enum(stackIds)).max(stackIds.length), path: z.string().min(1).max(200),
  params: z.array(ciParam).max(20), body: z.string().min(1).max(64 * 1024),
});
export type CiTemplate = z.infer<typeof ciTemplate>;
export type CiValues = TemplateValues;

/**
 * The values a template renders with: the ones given, else the stack's suggestion when it fits the parameter, else the
 * template's default. A given value that does not fit, or names no parameter, is refused.
 */
export const resolveValues = (template: CiTemplate, given: CiValues, stack: StackValues): CiValues => resolveParams(template.params, given, stack);

/** Where each forge reads its CI files from: a template writes nowhere else. */
const ciLocations: Record<CiForge, RegExp> = {
  github: /^\.github\/workflows\/[A-Za-z0-9_][A-Za-z0-9._-]*\.ya?ml$/,
  gitea: /^\.(?:gitea|github)\/workflows\/[A-Za-z0-9_][A-Za-z0-9._-]*\.ya?ml$/,
  gitlab: /^(?:\.gitlab-ci\.yml|\.gitlab\/ci\/[A-Za-z0-9_][A-Za-z0-9._-]*\.ya?ml)$/,
  azure: /^(?:azure-pipelines[A-Za-z0-9._-]*|\.azure-pipelines\/[A-Za-z0-9_][A-Za-z0-9._-]*)\.ya?ml$/,
};

function safePath(path: string, forge: CiForge) {
  if (!ciLocations[forge].test(path) || path.split("/").some(part => part === "." || part === "..")) throw invalid("file path " + path + " is not a " + forge + " CI file");
  return path;
}

/** Renders a CI template (a YAML file: free text only through |json) and its path. */
export function renderTemplate(template: CiTemplate, values: CiValues): {path: string; text: string} {
  const text = renderText(template.body, template.params, values, {raw: false});
  return {path: safePath(substitute(template.path, new Map(template.params.map(param => [param.name, param])), values, false), template.forge), text};
}

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
