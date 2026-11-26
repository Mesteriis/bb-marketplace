#!/usr/bin/env node
// Checks that the collection manifest (.bb/plugins.json), the marketplace
// catalog (marketplace.json), and every plugin manifest agree with each other
// and with the BB store rules.
//
//   node scripts/check-manifests.mjs [repository-root]
//
// Prints every problem and exits 1 when something is off.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(
  process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), ".."),
);
const REPOSITORY_LICENSE = "MIT";
const subtrees = JSON.parse(readFileSync(join(root, "subtrees.json"), "utf8")).plugins;
const importedDirectories = new Set([...subtrees.map((p) => p.prefix), "plugins/makosh-ai", "plugins/navigation"]);
const RESERVED_MARKETPLACE_NAMES = ["bb-official", "bb-community"];
const DESCRIPTION_LIMIT = 140;
const OVERVIEW_LIMIT = 4000;

const problems = [];
const problem = (where, message) => problems.push(`${where}: ${message}`);

const isFile = (relativePath) => {
  const path = join(root, relativePath);
  return existsSync(path) && statSync(path).isFile();
};

function readJson(relativePath) {
  if (!isFile(relativePath)) {
    problem(relativePath, "file is missing");
    return null;
  }
  try {
    return JSON.parse(readFileSync(join(root, relativePath), "utf8"));
  } catch (error) {
    problem(relativePath, `invalid JSON (${error.message})`);
    return null;
  }
}

/** The plugin id BB derives from a package name. */
function derivePluginId(packageName) {
  const base = packageName.includes("/")
    ? packageName.split("/").at(-1)
    : packageName;
  return base
    .replace(/^bb-plugin-/, "")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^-+|-+$/g, "");
}

const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;
const CARET_RANGE = /^\^(\d+)\.(\d+)\.(\d+)$/;

/** Whether an X.Y.Z version is inside a caret range; null if either is not that shape. */
function satisfiesCaret(version, range) {
  const have = VERSION.exec(version)?.slice(1).map(Number);
  const floor = CARET_RANGE.exec(range)?.slice(1).map(Number);
  if (have === undefined || floor === undefined) return null;
  const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  const ceiling =
    floor[0] > 0
      ? [floor[0] + 1, 0, 0]
      : floor[1] > 0
        ? [0, floor[1] + 1, 0]
        : [0, 0, floor[2] + 1];
  return compare(have, floor) >= 0 && compare(have, ceiling) < 0;
}

/** The store's rules for PLUGIN_OVERVIEW.md. */
function checkOverview(relativePath) {
  if (!isFile(relativePath)) {
    problem(relativePath, "file is missing; the BB store requires it");
    return;
  }
  const text = readFileSync(join(root, relativePath), "utf8");
  const length = [...text].length;
  if (length > OVERVIEW_LIMIT) {
    problem(relativePath, `has ${length} characters; the store limit is ${OVERVIEW_LIMIT}`);
  }
  // Code is exempt from the markup rules below.
  const prose = text.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
  const rules = [
    [/^#\s/m, "must not use a `#` title; start sections at `##`"],
    [/!\[[^\]]*\]\(/, "must not contain images; put them in screenshots"],
    [/<\/?[a-zA-Z][a-zA-Z0-9-]*(\s[^>]*)?\/?>/, "must not contain raw HTML"],
    [/^\s*\|.*\|\s*$/m, "must not contain tables"],
    [/^\s*[-*+]\s+\[[ xX]\]\s/m, "must not contain task lists"],
    [/\[\^[^\]]+\]/, "must not contain footnotes"],
  ];
  for (const [pattern, message] of rules) {
    if (pattern.test(prose)) problem(relativePath, message);
  }
  for (const [, target] of prose.matchAll(/\]\(([^)\s]+)/g)) {
    if (!target.startsWith("https://")) {
      problem(relativePath, `link "${target}" must be an absolute https URL`);
    }
  }
}

/** Checks one plugin directory; returns what the catalog check needs. */
function checkPlugin(entry) {
  const directory = entry.source.replace(/^\.\//, "");
  const where = `${directory}/package.json`;
  const manifest = readJson(where);
  if (manifest === null) return null;
  if (typeof manifest.name !== "string" || derivePluginId(manifest.name) === "") {
    problem(where, "name must yield a plugin id (bb-plugin-<id>)");
    return null;
  }
  if (!VERSION.test(manifest.version ?? "")) {
    problem(where, "version must be X.Y.Z");
  }
  if (importedDirectories.has(directory)) {
    const bb = manifest.bb ?? {};
    for (const field of ["name", "description"]) {
      if (typeof bb[field] !== "string" || !bb[field].trim()) problem(where, `bb.${field} is missing`);
    }
    for (const field of ["server", "app", "host"]) {
      if (typeof bb[field] === "string" && !isFile(join(directory, bb[field]))) problem(where, `bb.${field} points at a missing file`);
    }
    return { name: entry.name, directory, id: derivePluginId(manifest.name), version: manifest.version, displayName: bb.name, description: bb.description };
  }
  if (manifest.license !== REPOSITORY_LICENSE) {
    problem(where, `license must be "${REPOSITORY_LICENSE}", the repository license`);
  }
  if (manifest.repository?.directory !== directory) {
    problem(where, `repository.directory must be "${directory}"`);
  }
  for (const engine of ["bb", "bbPluginSdk"]) {
    if (typeof manifest.engines?.[engine] !== "string") {
      problem(where, `engines.${engine} is missing`);
    }
  }

  const bb = manifest.bb ?? {};
  for (const field of ["name", "description"]) {
    if (typeof bb[field] !== "string" || bb[field].trim() === "") {
      problem(where, `bb.${field} is missing`);
    }
  }
  if (typeof bb.description === "string") {
    const length = [...bb.description].length;
    if (length > DESCRIPTION_LIMIT) {
      problem(where, `bb.description has ${length} characters; keep it within ${DESCRIPTION_LIMIT}`);
    }
    if (manifest.description !== bb.description) {
      problem(where, "description must equal bb.description");
    }
  }
  const icon = bb.branding?.icon;
  if (typeof icon !== "string" && typeof bb.branding?.logo?.light !== "string") {
    problem(where, "bb.branding needs an icon or a light logo");
  }
  if (typeof icon === "string" && icon.startsWith("./") && !isFile(join(directory, icon))) {
    problem(where, `bb.branding.icon points at a missing file (${icon})`);
  }
  if (typeof bb.server !== "string") problem(where, "bb.server is missing");
  for (const field of ["server", "app", "host"]) {
    const file = bb[field];
    if (typeof file === "string" && !isFile(join(directory, file))) {
      problem(where, `bb.${field} points at a missing file (${file})`);
    }
  }

  checkOverview(`${directory}/PLUGIN_OVERVIEW.md`);
  return {
    name: entry.name,
    directory,
    id: derivePluginId(manifest.name),
    version: manifest.version,
    displayName: bb.name,
    description: bb.description,
  };
}

function checkCollection() {
  const where = ".bb/plugins.json";
  const collection = readJson(where);
  if (collection === null) return [];
  if (!Array.isArray(collection.plugins) || collection.plugins.length === 0) {
    problem(where, "plugins must list at least one plugin");
    return [];
  }
  const names = new Set();
  const plugins = [];
  for (const entry of collection.plugins) {
    if (typeof entry?.name !== "string" || typeof entry?.source !== "string") {
      problem(where, "every entry needs a name and a source");
      continue;
    }
    if (names.has(entry.name)) problem(where, `duplicate entry name "${entry.name}"`);
    names.add(entry.name);
    if (!entry.source.startsWith("./")) {
      problem(where, `source of "${entry.name}" must start with "./"`);
      continue;
    }
    const plugin = checkPlugin(entry);
    if (plugin !== null) plugins.push(plugin);
  }
  return plugins;
}

function checkCatalog(plugins) {
  const where = "marketplace.json";
  const catalog = readJson(where);
  if (catalog === null) return 0;
  if (RESERVED_MARKETPLACE_NAMES.includes(catalog.name)) {
    problem(where, `name "${catalog.name}" is reserved by BB`);
  }
  const entries = Array.isArray(catalog.plugins) ? catalog.plugins : [];
  const byId = new Map(plugins.map((plugin) => [plugin.id, plugin]));
  const listed = new Set();

  for (const entry of entries) {
    const at = `${where} (${entry?.id ?? "entry without id"})`;
    const plugin = byId.get(entry?.id);
    if (plugin === undefined) {
      problem(at, "no plugin in .bb/plugins.json has this id");
      continue;
    }
    if (listed.has(entry.id)) problem(at, "listed twice");
    listed.add(entry.id);
    if (entry.id.startsWith("bb--")) problem(at, 'ids starting with "bb--" are reserved by BB');
    if (entry.displayName !== plugin.displayName) {
      problem(at, "displayName must equal the plugin's bb.name");
    }
    if (entry.description !== plugin.description) {
      problem(at, "description must equal the plugin's bb.description");
    }
    const iconUrl = entry.icon?.url;
    if (typeof iconUrl === "string" && !iconUrl.startsWith("https://") && !isFile(iconUrl)) {
      problem(at, `icon file is missing (${iconUrl})`);
    }
    const git = entry.source?.git;
    if (git === undefined) {
      problem(at, "source must be a git source of this repository");
      continue;
    }
    if (git.subdir !== plugin.directory) {
      problem(at, `source.git.subdir must be "${plugin.directory}"`);
    }
    if (git.ref !== "main" || git.range !== undefined || git.tagPrefix !== undefined) {
      problem(at, "this aggregate catalog must track the main branch explicitly");
    }
    if (git.url !== "https://github.com/Mesteriis/bb-marketplace.git") {
      problem(at, "source must point to the maintained aggregate");
    }
  }
  for (const plugin of plugins) {
    if (!listed.has(plugin.id)) {
      problem(where, `plugin "${plugin.id}" (${plugin.directory}) has no entry`);
    }
  }
  return entries.length;
}

/** The accepted-servers collection (mcp-collection/), checked only when present. */
function checkMcpCollection() {
  const indexPath = "mcp-collection/index.json";
  if (!existsSync(join(root, "mcp-collection"))) return 0;
  const index = readJson(indexPath);
  if (index === null) return 0;
  if (!Array.isArray(index.servers)) {
    problem(indexPath, "servers must be an array");
    return 0;
  }
  // One line per server: an update replaces the line of its name, it never adds a second one.
  const seen = new Set();
  for (const item of index.servers) {
    const at = `${indexPath} (${item?.name ?? "entry without name"})`;
    if (typeof item?.name !== "string" || typeof item?.version !== "string" || typeof item?.path !== "string") {
      problem(at, "entry needs string name, version and path");
      continue;
    }
    if (seen.has(item.name)) {
      problem(at, `duplicate server name "${item.name}"`);
      continue;
    }
    seen.add(item.name);
    const slug = item.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    if (item.path !== `mcp-collection/${slug}`) {
      problem(at, `path must be "mcp-collection/${slug}"`);
      continue;
    }
    const files = ["server.json", "review.md", "entry.json"];
    const missing = files.filter((file) => !isFile(`${item.path}/${file}`));
    for (const file of missing) problem(at, `${item.path}/${file} is missing`);
    if (missing.length > 0) continue;
    let entry = null;
    try {
      entry = JSON.parse(readFileSync(join(root, item.path, "entry.json"), "utf8"));
    } catch (error) {
      problem(at, `entry.json is invalid JSON (${error.message})`);
      continue;
    }
    if (entry?.name !== item.name || entry?.version !== item.version) {
      problem(at, "entry.json name/version do not match the index");
    }
    const choice = entry?.choice;
    const choiceOk =
      (choice?.kind === "package" || choice?.kind === "remote") &&
      Number.isInteger(choice.index) &&
      choice.index >= 0;
    for (const field of ["name", "version", "serverJsonSha256", "acceptedAt"]) {
      if (typeof entry?.[field] !== "string") problem(at, `entry.json: ${field} must be a string`);
    }
    if (!choiceOk) problem(at, "entry.json: choice must be {kind: package|remote, index: integer >= 0}");
    if (entry?.ociDigest !== undefined && typeof entry.ociDigest !== "string") {
      problem(at, "entry.json: ociDigest must be a string");
    }
    if (entry?.notes !== undefined && !(Array.isArray(entry.notes) && entry.notes.every((n) => typeof n === "string"))) {
      problem(at, "entry.json: notes must be an array of strings");
    }
    const hash = createHash("sha256")
      .update(readFileSync(join(root, item.path, "server.json")))
      .digest("hex");
    if (hash !== entry?.serverJsonSha256) problem(at, "server.json hash does not match entry.json serverJsonSha256");
  }
  return index.servers.length;
}

const plugins = checkCollection();
const entryCount = checkCatalog(plugins);
const collectionCount = checkMcpCollection();

if (problems.length > 0) {
  console.error(problems.map((line) => `- ${line}`).join("\n"));
  console.error(`\n${problems.length} problem(s) found.`);
  process.exit(1);
}
console.log(`manifests ok: ${plugins.length} plugin(s), ${entryCount} catalog entry(ies)${collectionCount > 0 ? `, ${collectionCount} collection server(s)` : ""}`);
