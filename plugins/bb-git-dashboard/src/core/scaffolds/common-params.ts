import type { TemplateParam } from "../templating/engine.ts";

/** Parameters every scaffold has; a scaffold may not define these names again. */
export const commonParams: TemplateParam[] = [
  {name: "name", label: "Project name (folder and package)", kind: "text", default: "my-project"},
  {name: "description", label: "One-line description", kind: "line", default: ""},
  {name: "author", label: "Author or copyright holder", kind: "line", default: ""},
  {name: "license", label: "License", kind: "choice", default: "MIT", choices: ["MIT", "Apache-2.0", "none"]},
  {name: "year", label: "Copyright year", kind: "text", default: "2026"},
  {name: "contributing", label: "Add CONTRIBUTING.md", kind: "flag", default: false},
  {name: "codeOfConduct", label: "Add CODE_OF_CONDUCT.md", kind: "flag", default: false},
];
/** Values derived from the common ones, not asked for: the copyright holder is the author, else the project's contributors. */
export const derivedParams: TemplateParam[] = [{name: "holder", label: "Copyright holder", kind: "line", default: ""}];
