// Writes site/catalog.json from the repository's marketplace.json and subtrees.json:
// what the home page lists. Run from the repository root after the catalog changes.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const market = JSON.parse(readFileSync(`${root}marketplace.json`, "utf8"));
const imported = new Set(JSON.parse(readFileSync(`${root}subtrees.json`, "utf8")).plugins.map((plugin) => plugin.id));
const text = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
const plugins = market.plugins
  .map((plugin) => ({
    id: text(plugin.id),
    name: text(plugin.displayName),
    description: text(plugin.description),
    author: text(plugin.author?.name),
    own: !imported.has(plugin.id),
  }))
  .sort((a, b) => Number(b.own) - Number(a.own) || a.name.localeCompare(b.name, "en"));
writeFileSync(`${root}site/catalog.json`, `${JSON.stringify({ plugins }, null, 1)}\n`);
console.log(`${plugins.length} plugins, ${plugins.filter((plugin) => plugin.own).length} of them Makosh packages`);
