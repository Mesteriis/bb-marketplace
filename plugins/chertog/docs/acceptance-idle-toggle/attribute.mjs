// attribute.mjs CPUPROFILE PLUGINLIST.json: nearest plugin-app-assets/<hash> owner, hash mapped to plugin id; chertog share.
import { readFileSync } from "node:fs";
const p = JSON.parse(readFileSync(process.argv[2], "utf8"));
const list = JSON.parse(readFileSync(process.argv[3], "utf8")).plugins ?? [];
const nameOf = {};
for (const pl of list) { const m = pl.app?.bundle?.jsUrl?.match(/plugin-app-assets\/([0-9a-f]+)\//); if (m) nameOf[m[1]] = pl.id; }
const nodes = new Map(p.nodes.map((n) => [n.id, n]));
const parent = new Map();
for (const n of p.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
const by = new Map(), fn = new Map(); let total = 0, idle = 0;
for (let i = 0; i < p.samples.length; i++) {
  const d = p.timeDeltas[i] ?? 0; total += d;
  let at = p.samples[i], owner = null, first = null; const leaf = nodes.get(at).callFrame;
  if (leaf.functionName === "(idle)") { idle += d; continue; }
  while (at !== undefined) {
    const u = nodes.get(at).callFrame.url; const m = u.match(/plugin-app-assets\/([0-9a-f]+)\//);
    if (m) { owner = "plugin:" + (nameOf[m[1]] ?? m[1]); break; }
    if (u && !first) first = u.replace(/^https?:\/\/[^/]+/, "").replace(/\?.*/, "");
    at = parent.get(at);
  }
  const k = owner ?? first ?? leaf.functionName; by.set(k, (by.get(k) ?? 0) + d);
  if (owner === "plugin:chertog") { const f = (leaf.functionName || "(anon)"); fn.set(f, (fn.get(f) ?? 0) + d); }
}
const busy = total - idle;
const out = { totalMs: +(total / 1000).toFixed(1), busyMs: +(busy / 1000).toFixed(1), chertogMs: +((by.get("plugin:chertog") ?? 0) / 1000).toFixed(1) };
out.chertogPctOfWall = +((100 * (by.get("plugin:chertog") ?? 0)) / total).toFixed(2);
out.chertogPctOfBusy = +((100 * (by.get("plugin:chertog") ?? 0)) / busy).toFixed(1);
out.top = [...by].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${(v / 1000).toFixed(0)}ms ${k}`);
out.chertogLeaf = [...fn].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${(v / 1000).toFixed(0)}ms ${k}`);
console.log(JSON.stringify(out, null, 1));
