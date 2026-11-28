// Renders templates of a templates repository (the layout of makosh-scaffolds) outside BB, with the plugin's own
// engine and loader: for the repository's CI and for checking a template before it is pushed. The plugin never runs it.
// Usage:
//   node scripts/scaffold.ts list <repository folder>                 templates offered; refused ones on stderr, exit 1
//   node scripts/scaffold.ts variants <repository folder> <id>        each choice and flag from the defaults, JSON lines
//   node scripts/scaffold.ts render <repository folder> <id> --out <new folder> [--set name=value]… [--values <JSON>] [--forge github|gitea|gitlab|azure]
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { readScaffoldTree } from "../src/adapters/bb/scaffold-tree.ts";
import { scaffoldCi } from "../src/core/scaffolds/ci.ts";
import { buildScaffold, variants } from "../src/core/scaffolds/model.ts";
import { commonParams } from "../src/core/scaffolds/overlay.ts";
import { loadRepository } from "../src/core/scaffolds/source.ts";
import type { CiForge } from "../src/core/ci-templates/render.ts";
import { CodedError } from "../src/core/workspace.ts";

const fail = (text: string): never => { process.stderr.write(text + "\n"); process.exit(1); };
const [command, folder, ...rest] = process.argv.slice(2);
if (!command || !folder || !["list", "variants", "render"].includes(command)) fail("usage: scaffold.ts list|variants|render <repository folder> …");

async function load() {
  try { return loadRepository((await readScaffoldTree(resolve(folder!))).files, "folder"); }
  catch (error) { return fail(error instanceof CodedError ? error.message + ": " + error.detail : String(error)); }
}

const loaded = await load();
if (command === "list") {
  for (const item of loaded.offered) process.stdout.write(item.scaffold.id + "\t" + item.scaffold.title + "\n");
  for (const item of loaded.rejected) process.stderr.write("refused " + item.name + ": " + item.issues.join(" ") + "\n");
  process.exit(loaded.rejected.length ? 1 : 0);
}

const id = rest.shift() ?? fail("name the template");
const entry = loaded.offered.find(item => item.scaffold.id === id)
  ?? fail("no template " + id + (loaded.rejected.some(item => item.name === id) ? ": " + loaded.rejected.find(item => item.name === id)!.issues.join(" ") : ""));
if (command === "variants") {
  for (const values of variants([...commonParams, ...entry.scaffold.params])) process.stdout.write(JSON.stringify(values) + "\n");
  process.exit(0);
}

const params = new Map([...commonParams, ...entry.scaffold.params].map(param => [param.name, param]));
const values: Record<string, string | boolean> = {};
let out = "";
let forge: CiForge | null = null;
for (let index = 0; index < rest.length; index++) {
  const flag = rest[index]!;
  const next = () => rest[++index] ?? fail(flag + " needs a value");
  if (flag === "--out") out = next();
  else if (flag === "--forge") forge = next() as CiForge;
  else if (flag === "--values") Object.assign(values, JSON.parse(next()));
  else if (flag === "--set") {
    const [key, ...value] = next().split("=");
    const text = value.join("=");
    values[key!] = params.get(key!)?.kind === "flag" ? text === "true" : text;
  } else fail("unknown option " + flag);
}
if (!out) fail("--out <new folder> is needed");
const target = resolve(out);
if (existsSync(target)) fail(target + " exists: render writes into a new folder only");
let built;
try { built = buildScaffold(entry.scaffold, values, {}, entry.common); }
catch (error) { fail(error instanceof CodedError ? error.message + ": " + error.detail : String(error)); }
const ci = scaffoldCi(built!.files, entry.scaffold, forge, {name: String(built!.values.name), branch: "main"});
for (const file of [...built!.files.filter(item => item.path !== ci?.path), ...(ci ? [{path: ci.path, text: ci.text, executable: false}] : [])]) {
  const path = join(target, file.path);
  mkdirSync(dirname(path), {recursive: true});
  writeFileSync(path, "base64" in file && file.base64 ? Buffer.from(file.text, "base64") : file.text);
  chmodSync(path, file.executable ? 0o755 : 0o644);
}
process.stdout.write(target + ": " + built!.files.length + " files" + (ci ? " and " + ci.path + " (" + ci.template + ")" : "") + "\n");
