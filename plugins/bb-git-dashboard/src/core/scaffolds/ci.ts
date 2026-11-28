import { builtinTemplates } from "../ci-templates/builtin.ts";
import { templateDefaults } from "../ci-templates/catalog.ts";
import { renderTemplate, resolveValues, type CiForge } from "../ci-templates/render.ts";
import { appFile, detectStacks, makeCheck, manifestPaths } from "../ci-templates/stack.ts";
import type { Scaffold, ScaffoldOutput } from "./model.ts";

/** A project's CI file, as written into it. */
export type ScaffoldCiFile = {path: string; text: string; template: string};

/**
 * The CI file of a project made from a scaffold: the stack is found in the generated files as in an existing copy
 * (0.12), the forge's built-in template for that stack renders with the scaffold's own CI values on top of what the
 * files suggest. A web UI (web/, or src/frontend/ beside another application in src/) is checked by `make web-check`
 * rather than taken for the stack; src/frontend/ alone is the project's stack. Null without a forge or when no template
 * fits the stack; a reason, and no file, when src/ holds more than one application besides the frontend, as no one CI
 * template checks them all.
 */
export function scaffoldCi(files: ScaffoldOutput[], scaffold: Scaffold, forge: CiForge | null, repo: {name: string; branch: string}):
  ScaffoldCiFile | {reason: string} | null {
  if (!forge) return null;
  const paths = files.map(file => file.path);
  const root = [...new Set(paths.map(path => path.split("/")[0]!)), ...paths.filter(path => appFile.test(path))];
  const manifests = Object.fromEntries(manifestPaths(root).flatMap(path => {
    const text = files.find(file => file.path === path)?.text;
    return text === undefined ? [] : [[path, text]];
  }));
  const input = {paths: root, manifests};
  let stacks = detectStacks(input);
  let web = paths.includes("web/package.json");
  if (stacks.length && stacks.every(stack => stack.dir)) {
    const others = stacks.filter(stack => stack.dir !== "src/frontend");
    const dirs = [...new Set(others.map(stack => stack.dir!))];
    if (dirs.length > 1) return {reason: "src/ holds more than one application (" + dirs.map(dir => dir + ": "
      + others.filter(stack => stack.dir === dir).map(stack => stack.id).join("+")).join(", ") + "): choose their CI template in CI/CD → Templates"};
    if (dirs.length === 1 && others.length < stacks.length) { stacks = others; web = true; }
  }
  const first = stacks[0];
  const template = first && builtinTemplates.find(item => item.forge === forge && item.stacks.includes(first.id));
  if (!template) return null;
  const own = Object.fromEntries(Object.entries(scaffold.ci ?? {}).filter(([key]) => template.params.some(param => param.name === key)));
  const values = resolveValues(template, {}, {...templateDefaults(template, stacks, {...repo, make: makeCheck(input)}), web, ...own});
  return {...renderTemplate(template, values), template: template.id};
}
