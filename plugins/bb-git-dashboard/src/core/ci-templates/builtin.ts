import type { CiForge, CiParam, CiTemplate } from "./render.ts";
import type { StackId } from "./stack.ts";
import { versions } from "../scaffolds/versions.ts";

/*
 * The plugin's own CI templates: one per stack and forge. They hold only the pipeline's skeleton and its parameters,
 * use no secrets and push nothing anywhere; a project adds deployment itself.
 */

const branch: CiParam = {name: "branch", label: "Branch to build on push", kind: "text", default: "main"};
const make: CiParam = {name: "make", label: "Run make check instead of the steps", kind: "flag", default: false};
const workflow: CiParam = {name: "workflow", label: "Workflow file name", kind: "text", default: "ci"};
// An application in src/<role>/ (the layout of the owner's templates): its install and checks run there, make check at the root.
const app: CiParam[] = [
  // Used only with inApp; its default is a sample, as a text value starts with a letter or digit.
  {name: "appDir", label: "Application folder (src/<role>)", kind: "text", default: "src/app", pattern: "^src/[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$"},
  {name: "inApp", label: "Install and check in the application folder", kind: "flag", default: false},
];
const params: Record<StackId, CiParam[]> = {
  node: [
    {name: "packageManager", label: "Package manager", kind: "choice", default: "npm", choices: ["npm", "pnpm", "yarn", "bun"]},
    {name: "nodeVersion", label: "Node.js version", kind: "text", default: "22"},
    {name: "lockfile", label: "Install from the committed lockfile", kind: "flag", default: true},
    make,
    {name: "lint", label: "Run the lint script", kind: "flag", default: false},
    {name: "build", label: "Run the build script", kind: "flag", default: true},
    {name: "test", label: "Run the test script", kind: "flag", default: true},
    ...app,
  ],
  python: [
    {name: "pythonTool", label: "Install dependencies with", kind: "choice", default: "pip", choices: ["uv", "poetry", "pip", "pyproject"]},
    {name: "pythonVersion", label: "Python version", kind: "text", default: "3.12"},
    {name: "lockfile", label: "Install from the committed uv.lock (uv)", kind: "flag", default: true},
    make,
    {name: "test", label: "Run pytest", kind: "flag", default: true},
    ...app,
  ],
  go: [{name: "goVersion", label: "Go version", kind: "text", default: "1.23"}, make,
    {name: "web", label: "Also check web/ with Node.js (make web-check)", kind: "flag", default: false},
    {name: "webNode", label: "Node.js version for web/", kind: "text", default: "24"}, ...app],
  rust: [make, {name: "clippy", label: "Run clippy", kind: "flag", default: true}, ...app],
  docker: [{name: "image", label: "Image name (local, not pushed)", kind: "text", default: "app"}],
};
const titles: Record<StackId, string> = {node: "Node.js", python: "Python", go: "Go", rust: "Rust", docker: "Docker image build"};
const forges: Record<CiForge, string> = {github: "GitHub Actions", gitea: "Gitea Actions", gitlab: "GitLab CI", azure: "Azure Pipelines"};

/** The commands of a stack, one per line, each wrapped by the forge's step syntax; `root` ones run at the repository's root. */
type Step = {name: string; run: string; root?: true} | {section: string} | {end: string};
const install: Record<Exclude<StackId, "docker">, Step[]> = {
  node: [
    // Node 25 and later ship without Corepack: it is installed first, then enabled.
    {section: "#packageManager=pnpm"}, {name: "Enable pnpm", run: "npm install -g corepack && corepack enable"}, {end: "packageManager"},
    {section: "#packageManager=yarn"}, {name: "Enable yarn", run: "npm install -g corepack && corepack enable"}, {end: "packageManager"},
    {section: "#lockfile"},
    {section: "#packageManager=npm"}, {name: "Install", run: "npm ci"}, {end: "packageManager"},
    {section: "#packageManager=pnpm"}, {name: "Install", run: "pnpm install --frozen-lockfile"}, {end: "packageManager"},
    {section: "#packageManager=yarn"}, {name: "Install", run: "yarn install --immutable"}, {end: "packageManager"},
    {section: "#packageManager=bun"}, {name: "Install", run: "bun install --frozen-lockfile"}, {end: "packageManager"},
    {end: "lockfile"},
    {section: "^lockfile"}, {name: "Install", run: "{{packageManager}} install"}, {end: "lockfile"},
  ],
  python: [
    {section: "#pythonTool=uv"},
    // uv and Poetry at the versions checked with, as the actions are pinned: a new project's CI is reproducible.
    {section: "#lockfile"}, {name: "Install", run: "pip install uv==" + versions.uv + " && uv sync --locked"}, {end: "lockfile"},
    {section: "^lockfile"}, {name: "Install", run: "pip install uv==" + versions.uv + " && uv sync"}, {end: "lockfile"},
    {end: "pythonTool"},
    {section: "#pythonTool=poetry"}, {name: "Install", run: "pip install poetry==" + versions.poetry + " && poetry install --no-interaction"}, {end: "pythonTool"},
    {section: "#pythonTool=pip"}, {name: "Install", run: "pip install -r requirements.txt"}, {end: "pythonTool"},
    {section: "#pythonTool=pyproject"}, {name: "Install", run: "pip install ."}, {end: "pythonTool"},
  ],
  go: [],
  rust: [{name: "Toolchain", run: "rustup toolchain install stable --profile minimal --component clippy && rustup default stable"}],
};
const checks: Record<Exclude<StackId, "docker">, Step[]> = {
  node: [
    {section: "#lint"}, {name: "Lint", run: "{{packageManager}} run lint"}, {end: "lint"},
    {section: "#build"}, {name: "Build", run: "{{packageManager}} run build"}, {end: "build"},
    {section: "#test"}, {name: "Test", run: "{{packageManager}} run test"}, {end: "test"},
  ],
  python: [
    {section: "#test"},
    {section: "#pythonTool=uv"}, {name: "Test", run: "uv run pytest"}, {end: "pythonTool"},
    {section: "#pythonTool=poetry"}, {name: "Test", run: "poetry run pytest"}, {end: "pythonTool"},
    {section: "^pythonTool=uv"}, {section: "^pythonTool=poetry"}, {name: "Test", run: "python -m pytest"}, {end: "pythonTool"}, {end: "pythonTool"},
    {end: "test"},
  ],
  go: [{name: "Build", run: "go build ./..."}, {name: "Vet", run: "go vet ./..."}, {name: "Test", run: "go test ./..."}],
  rust: [
    {name: "Build", run: "cargo build"},
    {section: "#clippy"}, {name: "Clippy", run: "cargo clippy -- -D warnings"}, {end: "clippy"},
    {name: "Test", run: "cargo test"},
  ],
};
/**
 * Installation, then the stack's checks, or `make check` when the project's Makefile has that target (ADR-011). A Go
 * project with web/ checks it with `make web-check`; on GitLab, where a job has one image, that runs in a job of its own
 * and the Go job leaves it out (`WEB=0`).
 */
const steps = (stack: Exclude<StackId, "docker">, separateWeb = false): Step[] => [...install[stack],
  {section: "^make"}, ...checks[stack], {end: "make"},
  ...(stack === "go" && !separateWeb ? [{section: "^make"}, {section: "#web"}, {name: "Web", run: "make web-check", root: true as const}, {end: "web"}, {end: "make"}] : []),
  {section: "#make"},
  ...(stack === "go" && separateWeb ? [{section: "#web"}, {name: "Check", run: "make check WEB=0", root: true as const}, {end: "web"}, {section: "^web"}] : []),
  {name: "Check", run: "make check", root: true},
  ...(stack === "go" && separateWeb ? [{end: "web"}] : []),
  {end: "make"}];
const dockerSteps: Step[] = [{name: "Build image", run: "docker build -t {{image}}:ci .", root: true}];

/** Writes steps with `indent`, each command through `line`; section tags go on their own lines. */
const render = (list: Step[], indent: string, line: (step: {name: string; run: string; root?: true}) => string) =>
  list.map(step => "section" in step ? indent + "{{" + step.section + "}}\n" : "end" in step ? indent + "{{/" + step.end + "}}\n" : line(step)).join("");
/** A step's working folder when the application is in src/<role>/: the forge's own key, kept out for a root project. */
const inApp = (indent: string, key: string, step: {root?: true}) => step.root ? "" : indent + "{{#inApp}}\n" + indent + key + ": {{appDir}}\n" + indent + "{{/inApp}}\n";

/** Steps that set up the language before the stack's commands, per syntax. */
function actionsSetup(stack: StackId) {
  const step = (uses: string, input?: [string, string]) => "      - uses: " + uses + "\n" + (input ? "        with:\n          " + input[0] + ": \"" + input[1] + "\"\n" : "");
  if (stack === "node") return step("actions/setup-node@v4", ["node-version", "{{nodeVersion}}"]) +
    "      {{#packageManager=bun}}\n      - uses: oven-sh/setup-bun@v2\n      {{/packageManager}}\n";
  if (stack === "python") return step("actions/setup-python@v5", ["python-version", "{{pythonVersion}}"]);
  if (stack === "go") return step("actions/setup-go@v5", ["go-version", "{{goVersion}}"]) +
    "      {{#web}}\n" + step("actions/setup-node@v4", ["node-version", "{{webNode}}"]) + "      {{/web}}\n";
  return "";
}
const images: Record<StackId, string> = {node: "node:{{nodeVersion}}", python: "python:{{pythonVersion}}", go: "golang:{{goVersion}}", rust: "rust:latest", docker: "docker:latest"};

function actions(stack: StackId, forge: "github" | "gitea"): CiTemplate {
  const list = stack === "docker" ? dockerSteps : steps(stack);
  const body = "# " + titles[stack] + " CI from a Makosh Git template. Add deployment and secrets yourself.\n" +
    "name: CI\non:\n  push:\n    branches: [{{branch}}]\n  pull_request:\n  workflow_dispatch:\n" +
    "jobs:\n  ci:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n" + actionsSetup(stack) +
    render(list, "      ", step => "      - name: " + step.name + "\n        run: " + step.run + "\n" + inApp("        ", "working-directory", step));
  return {id: stack + "-" + forge, title: titles[stack] + " · " + forges[forge], stacks: [stack], forge,
    path: (forge === "github" ? ".github" : ".gitea") + "/workflows/{{workflow}}.yml", params: [branch, workflow, ...params[stack]], body};
}

function gitlab(stack: StackId): CiTemplate {
  const list = stack === "docker" ? dockerSteps : steps(stack, true);
  const body = "# " + titles[stack] + " CI from a Makosh Git template. Add deployment and secrets yourself.\n" +
    "workflow:\n  rules:\n    - if: $CI_PIPELINE_SOURCE == \"merge_request_event\"\n    - if: $CI_COMMIT_BRANCH == \"{{branch}}\"\n" +
    "ci:\n  image: " + images[stack] + "\n" + (stack === "docker" ? "  services:\n    - docker:dind\n  variables:\n    DOCKER_TLS_CERTDIR: \"/certs\"\n" : "") +
    "  script:\n" + (stack === "node" ? "    {{#packageManager=bun}}\n    - npm install -g bun\n    {{/packageManager}}\n" : "") +
    // One shell runs a job's lines: a step in the application folder goes in a subshell, so make check stays at the root.
    render(list, "    ", step => step.root ? "    - " + step.run + "\n"
      : "    {{#inApp}}\n    - (cd {{appDir}} && " + step.run + ")\n    {{/inApp}}\n    {{^inApp}}\n    - " + step.run + "\n    {{/inApp}}\n") +
    (stack === "go" ? "{{#web}}\nweb:\n  image: node:{{webNode}}\n  script:\n    - make web-check\n{{/web}}\n" : "");
  return {id: stack + "-gitlab", title: titles[stack] + " · " + forges.gitlab, stacks: [stack], forge: "gitlab", path: ".gitlab-ci.yml",
    params: [branch, ...params[stack]], body};
}

function azureSetup(stack: StackId) {
  const task = (name: string, key: string, value: string) => "  - task: " + name + "\n    inputs:\n      " + key + ": \"" + value + "\"\n";
  if (stack === "node") return task("NodeTool@0", "versionSpec", "{{nodeVersion}}.x") + "  {{#packageManager=bun}}\n  - script: npm install -g bun\n    displayName: Install bun\n  {{/packageManager}}\n";
  if (stack === "python") return task("UsePythonVersion@0", "versionSpec", "{{pythonVersion}}");
  if (stack === "go") return task("GoTool@0", "version", "{{goVersion}}") + "  {{#web}}\n" + task("NodeTool@0", "versionSpec", "{{webNode}}.x") + "  {{/web}}\n";
  return "";
}

function azure(stack: StackId): CiTemplate {
  const list = stack === "docker" ? dockerSteps : steps(stack);
  const body = "# " + titles[stack] + " CI from a Makosh Git template. Add deployment and secrets yourself.\n" +
    "trigger:\n  branches:\n    include: [{{branch}}]\npool:\n  vmImage: ubuntu-latest\nsteps:\n" + azureSetup(stack) +
    render(list, "  ", step => "  - script: " + step.run + "\n    displayName: " + step.name + "\n" + inApp("    ", "workingDirectory", step));
  return {id: stack + "-azure", title: titles[stack] + " · " + forges.azure, stacks: [stack], forge: "azure", path: "azure-pipelines.yml",
    params: [branch, ...params[stack]], body};
}

const stacks: StackId[] = ["node", "python", "go", "rust", "docker"];
/** Every built-in template, by stack then forge. */
export const builtinTemplates: CiTemplate[] = stacks.flatMap(stack => [actions(stack, "github"), actions(stack, "gitea"), gitlab(stack), azure(stack)]);
