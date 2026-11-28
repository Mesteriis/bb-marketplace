import { z } from "zod";
import type { OfferedScaffold, ScaffoldSource } from "./catalog.ts";
import { scaffold, scaffoldIssues, type CommonLayer, type Scaffold, type ScaffoldFile } from "./model.ts";

/**
 * Templates kept in a repository (the owner's templates repository, or a local folder in its layout):
 *
 *   common/template.json, common/files/…       the files every project gets (license, AGENTS.md, .gitignore, …)
 *   templates/<id>/template.json                 the template's manifest
 *   templates/<id>/files/…                       the project's files as they are, values in {{ }}
 *
 * The manifest names the template in English and Russian, its parameters, which files are written only under a
 * condition (by glob), which are renamed (two LICENSE texts, two Dockerfiles), which are copied verbatim (a Vue file
 * writes {{ }} itself), and the .gitignore lines, .editorconfig sections and CI values the template adds.
 */

/** One file of a templates repository: text, or with `base64` its bytes; `executable` from the file's mode. */
export type TreeFile = {path: string; text: string; base64?: true; executable: boolean};
/** Text when the bytes are UTF-8 without NUL; otherwise the bytes in base64 (an icon). */
export function treeFileOf(path: string, bytes: Uint8Array, executable: boolean): TreeFile {
  if (!bytes.includes(0)) {
    try { return {path, text: new TextDecoder("utf-8", {fatal: true, ignoreBOM: true}).decode(bytes), executable}; } catch { /* binary */ }
  }
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return {path, text: btoa(binary), base64: true, executable};
}
/** The highest manifest format this plugin reads. */
export const templateFormat = 1;

const id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
const glob = z.string().min(1).max(200).regex(/^[A-Za-z0-9_.@+{}*?\/-]+$/);
const condition = z.string().regex(/^!?[a-z][A-Za-z0-9]*(?:!?=[A-Za-z0-9._\/@+-]+)?$/);
const words = <T extends number>(max: T) => z.object({en: z.string().max(max), ru: z.string().max(max).optional()}).strict();
const label = z.object({en: z.string().min(1).max(80), ru: z.string().min(1).max(80).optional()}).strict();
const param = z.discriminatedUnion("kind", [
  z.object({name: z.string(), kind: z.literal("text"), default: z.string(), pattern: z.string().optional(), label}).strict(),
  z.object({name: z.string(), kind: z.literal("choice"), default: z.string(), choices: z.array(z.string()), label}).strict(),
  z.object({name: z.string(), kind: z.literal("flag"), default: z.boolean(), label}).strict(),
  z.object({name: z.string(), kind: z.literal("line"), default: z.string(), label}).strict(),
]);
const layout = {
  /** Glob → condition: a file matching the glob is written only when the condition holds (all of them, for several). */
  when: z.record(glob, condition).optional(),
  /** Path in files/ → path in the project (it may take values). */
  rename: z.record(glob, z.string().min(1).max(200)).optional(),
  /** Globs of files copied as they are. */
  verbatim: z.array(glob).max(100).optional(),
};
const manifest = z.object({
  format: z.literal(templateFormat), id, title: words(100).extend({en: z.string().min(1).max(100)}), description: words(400),
  params: z.array(param).max(30), ...layout,
  ignore: z.array(z.string().max(200)).max(100).optional(), editorconfig: z.string().max(4000).optional(),
  ci: z.record(z.string(), z.union([z.string(), z.boolean()])).optional(),
}).strict();
const commonManifest = z.object({format: z.literal(templateFormat), ...layout}).strict();

/** `*` within a segment, `**` across segments, `?` one character; anchored. */
function globRegex(pattern: string) {
  let source = "";
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index]!;
    if (char === "*" && pattern[index + 1] === "*") { source += pattern[index + 2] === "/" ? "(?:.*/)?" : ".*"; index += pattern[index + 2] === "/" ? 2 : 1; }
    else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp("^" + source + "$");
}

/** Why a manifest does not fit its schema, in a line. */
function described(error: z.ZodError) {
  return error.issues.map(issue => issue.code === "unrecognized_keys" ? "unknown field " + issue.keys.join(", ")
    : (issue.path.length ? issue.path.join(".") + ": " : "") + issue.message.toLowerCase()).join("; ");
}

/** Reads a manifest: its JSON, its format, then its schema; the reason when one fails. */
function readManifest<T>(path: string, text: string | undefined, schema: z.ZodType<T>): {value: T} | {issue: string} {
  if (text === undefined) return {issue: path + " is missing."};
  let value: unknown;
  try { value = JSON.parse(text); } catch { return {issue: path + " is not JSON."}; }
  const format = (value as {format?: unknown} | null)?.format;
  if (typeof format === "number" && format > templateFormat) return {issue: path + " is of format " + format + ": it needs a newer Makosh Git."};
  const parsed = schema.safeParse(value);
  return parsed.success ? {value: parsed.data} : {issue: path + " does not match the template format: " + described(parsed.error) + "."};
}

/** The files under `<folder>/files/` as scaffold files: conditions by glob, renames, verbatim, bytes. */
function filesOf(tree: TreeFile[], folder: string, rules: z.infer<z.ZodObject<typeof layout>>): ScaffoldFile[] {
  const prefix = folder + "/files/";
  const when = Object.entries(rules.when ?? {}).map(([pattern, test]) => [globRegex(pattern), test] as const);
  const rename = Object.entries(rules.rename ?? {}).map(([pattern, to]) => [globRegex(pattern), to] as const);
  const verbatim = (rules.verbatim ?? []).map(globRegex);
  return tree.filter(file => file.path.startsWith(prefix)).map(file => {
    const relative = file.path.slice(prefix.length);
    const conditions = when.filter(([pattern]) => pattern.test(relative)).map(([, test]) => test);
    return {
      path: rename.find(([pattern]) => pattern.test(relative))?.[1] ?? relative, body: file.text,
      ...(conditions.length ? {when: conditions.length === 1 ? conditions[0]! : conditions} : {}),
      ...(file.executable ? {executable: true} : {}),
      ...(verbatim.some(pattern => pattern.test(relative)) ? {verbatim: true} : {}),
      ...(file.base64 ? {base64: true} : {}),
    };
  });
}

/**
 * The templates of a repository's files: its common layer, the templates offered (keys `<source>:<id>`) and those
 * refused with their reasons. A refused template does not keep the others from being offered; a broken common layer
 * refuses every template, as each would render with it.
 */
export function loadRepository(tree: TreeFile[], source: ScaffoldSource):
  {common: CommonLayer | null; offered: OfferedScaffold[]; rejected: {source: ScaffoldSource; name: string; issues: string[]}[]} {
  const text = new Map(tree.filter(file => !file.base64).map(file => [file.path, file.text]));
  const hasCommon = tree.some(file => file.path.startsWith("common/"));
  let common: CommonLayer | null = null;
  let commonIssue: string | null = null;
  if (hasCommon) {
    const read = readManifest("common/template.json", text.get("common/template.json"), commonManifest);
    if ("issue" in read) commonIssue = read.issue;
    else common = {files: filesOf(tree, "common", read.value)};
  }
  const ids = [...new Set(tree.map(file => /^templates\/([^/]+)\//.exec(file.path)?.[1]).filter((name): name is string => !!name))].sort();
  const offered: OfferedScaffold[] = [];
  const rejected: {source: ScaffoldSource; name: string; issues: string[]}[] = [];
  for (const name of ids) {
    const folder = "templates/" + name;
    if (commonIssue) { rejected.push({source, name, issues: [commonIssue]}); continue; }
    const read = readManifest(folder + "/template.json", text.get(folder + "/template.json"), manifest);
    if ("issue" in read) { rejected.push({source, name, issues: [read.issue]}); continue; }
    const m = read.value;
    if (m.id !== name) { rejected.push({source, name, issues: [folder + "/template.json: the id " + m.id + " is not its folder's name."]}); continue; }
    const labels = Object.fromEntries(m.params.flatMap(item => item.label.ru ? [[item.name, item.label.ru]] : []));
    const ru = {...(m.title.ru ? {title: m.title.ru} : {}), ...(m.description.ru ? {description: m.description.ru} : {}), ...(Object.keys(labels).length ? {labels} : {})};
    const raw: Scaffold = {
      id: m.id, title: m.title.en, description: m.description.en,
      params: m.params.map(({label: text, ...rest}) => ({...rest, label: text.en}) as Scaffold["params"][number]),
      files: filesOf(tree, folder, m),
      ...(m.ignore ? {ignore: m.ignore} : {}), ...(m.editorconfig ? {editorconfig: m.editorconfig} : {}), ...(m.ci ? {ci: m.ci} : {}),
      ...(Object.keys(ru).length ? {i18n: {ru}} : {}),
    };
    const issues = scaffoldIssues(raw, common ?? undefined);
    if (issues.length) { rejected.push({source, name, issues}); continue; }
    offered.push({key: source + ":" + m.id, source, scaffold: scaffold.parse(raw), ...(common ? {common} : {})});
  }
  return {common, offered, rejected};
}

