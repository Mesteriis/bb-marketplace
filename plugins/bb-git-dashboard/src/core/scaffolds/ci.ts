import { builtinTemplates } from "../ci-templates/builtin.ts";
import { templateDefaults } from "../ci-templates/catalog.ts";
import { renderTemplate, resolveValues, type CiForge } from "../ci-templates/render.ts";
import { appFile, detectStacks, makeCheck, manifestPaths } from "../ci-templates/stack.ts";
import type { Scaffold, ScaffoldOutput } from "./model.ts";

/**
 * The CI file of a project made from a scaffold: the stack is found in the generated files as in an existing copy
 * (0.12), the forge's built-in template for that stack renders with the scaffold's own CI values on top of what the
 * files suggest. Null without a forge, or when no template fits the stack.
 */
export function scaffoldCi(files: ScaffoldOutput[], scaffold: Scaffold, forge: CiForge | null, repo: {name: string; branch: string}):
  {path: string; text: string; template: string} | null {
  if (!forge) return null;
  const paths = files.map(file => file.path);
  // A web UI with its own package.json (web/, or src/frontend/ beside a Go service) is checked by `make web-check`, not
  // taken for the project's stack.
  const webDir = ["web", "src/frontend"].find(dir => paths.includes(dir + "/package.json"));
  const root = [...new Set(paths.map(path => path.split("/")[0]!)),
    ...paths.filter(path => appFile.test(path) && !(webDir && path.startsWith(webDir + "/")))];
  const manifests = Object.fromEntries(manifestPaths(root).flatMap(path => {
    const text = files.find(file => file.path === path)?.text;
    return text === undefined ? [] : [[path, text]];
  }));
  const input = {paths: root, manifests};
  const stacks = detectStacks(input);
  const first = stacks[0];
  const template = first && builtinTemplates.find(item => item.forge === forge && item.stacks.includes(first.id));
  if (!template) return null;
  const own = Object.fromEntries(Object.entries(scaffold.ci ?? {}).filter(([key]) => template.params.some(param => param.name === key)));
  const web = webDir !== undefined;
  const values = resolveValues(template, {}, {...templateDefaults(template, stacks, {...repo, make: makeCheck(input)}), web, ...own});
  return {...renderTemplate(template, values), template: template.id};
}
