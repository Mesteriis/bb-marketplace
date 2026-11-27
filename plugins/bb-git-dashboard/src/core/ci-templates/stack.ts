/** The stacks a CI template is written for. */
export const stackIds = ["node", "python", "go", "rust", "docker"] as const;
export type StackId = typeof stackIds[number];
export type StackValues = Record<string, string | boolean>;
/** A stack found at a project's root: the files that show it and the template parameters they suggest. */
export type Stack = {id: StackId; evidence: string[]; defaults: StackValues};
/** The project's tracked paths and the text of the root manifests among them (see `manifestPaths`). */
export type StackInput = {paths: string[]; manifests: Record<string, string>};

const manifests = new Set(["package.json", ".nvmrc", ".node-version", "pyproject.toml", "requirements.txt", ".python-version", "go.mod", "Cargo.toml"]);
/** The root manifests worth reading, in the order the project lists them. */
export const manifestPaths = (paths: string[]) => paths.filter(path => manifests.has(path));

const major = (value: string | undefined) => /(\d+)/.exec(value ?? "")?.[1];
const minor = (value: string | undefined) => /(\d+\.\d+)/.exec(value ?? "")?.[1];

function packageJson(text: string | undefined): {packageManager?: unknown; engines?: {node?: unknown}; scripts?: Record<string, unknown>} {
  try {
    const value: unknown = JSON.parse(text ?? "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

function node(root: Set<string>, files: Record<string, string>): Stack {
  const manifest = packageJson(files["package.json"]);
  const locks: [string, string][] = [["pnpm-lock.yaml", "pnpm"], ["yarn.lock", "yarn"], ["bun.lock", "bun"], ["bun.lockb", "bun"], ["package-lock.json", "npm"]];
  const lock = locks.find(([file]) => root.has(file));
  const declared = typeof manifest.packageManager === "string" ? /^(npm|pnpm|yarn|bun)@/.exec(manifest.packageManager)?.[1] : undefined;
  const scripts = manifest.scripts && typeof manifest.scripts === "object" ? manifest.scripts : {};
  const engine = typeof manifest.engines?.node === "string" ? manifest.engines.node : undefined;
  return {id: "node", evidence: ["package.json", ...(lock ? [lock[0]] : [])], defaults: {
    packageManager: declared ?? lock?.[1] ?? "npm",
    nodeVersion: major(files[".nvmrc"]) ?? major(files[".node-version"]) ?? major(engine) ?? "22",
    test: typeof scripts.test === "string", build: typeof scripts.build === "string", lint: typeof scripts.lint === "string",
    lockfile: Boolean(lock),
  }};
}

function python(root: Set<string>, files: Record<string, string>): Stack {
  const project = files["pyproject.toml"] ?? "";
  const tool = root.has("uv.lock") ? "uv" : root.has("poetry.lock") || /^\[tool\.poetry\]/m.test(project) ? "poetry"
    : root.has("requirements.txt") ? "pip" : "pyproject";
  const requires = /^requires-python\s*=\s*"([^"]*)"/m.exec(project)?.[1];
  const evidence = ["pyproject.toml", "requirements.txt", "uv.lock", "poetry.lock"].filter(file => root.has(file));
  return {id: "python", evidence, defaults: {
    pythonTool: tool,
    pythonVersion: minor(files[".python-version"]) ?? minor(requires) ?? "3.12",
    test: /\bpytest\b/.test(project) || /\bpytest\b/.test(files["requirements.txt"] ?? ""),
  }};
}

/** The stacks of a project, found by the files at its root only: a subproject's manifest is not the project's stack. */
export function detectStacks({paths, manifests: files}: StackInput): Stack[] {
  const root = new Set(paths.filter(path => !path.includes("/")));
  const found: Stack[] = [];
  if (root.has("package.json")) found.push(node(root, files));
  if (root.has("pyproject.toml") || root.has("requirements.txt")) found.push(python(root, files));
  if (root.has("go.mod")) found.push({id: "go", evidence: ["go.mod"], defaults: {goVersion: minor(/^go\s+(\S+)/m.exec(files["go.mod"] ?? "")?.[1]) ?? "1.23"}});
  if (root.has("Cargo.toml")) found.push({id: "rust", evidence: ["Cargo.toml"], defaults: {}});
  if (root.has("Dockerfile")) found.push({id: "docker", evidence: ["Dockerfile"], defaults: {}});
  return found;
}
