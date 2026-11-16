#!/usr/bin/env node
import { readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
export function validateSubtrees(root) {
  const read = (p) => JSON.parse(readFileSync(join(root, p), "utf8"));
  const registry = read("subtrees.json");
  const catalog = read("marketplace.json");
  const problems = [];
  const seen = new Set();
  const remotes = new Set();
  for (const p of registry.plugins) {
    if (seen.has(p.id)) problems.push(`duplicate subtree: ${p.id}`);
    seen.add(p.id);
    if (p.prefix !== `plugins/${p.id}`) problems.push(`invalid prefix: ${p.id}`);
    if (!/^https:\/\/github\.com\/Mesteriis\/[A-Za-z0-9_.-]+\.git$/.test(p.fork)) problems.push(`invalid maintained fork: ${p.id}`);
    if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/.test(p.upstream)) problems.push(`invalid upstream: ${p.id}`);
    if (p.branch !== `marketplace/${p.id}`) problems.push(`invalid maintained branch: ${p.id}`);
    if (!/^[a-f0-9]{40}$/.test(p.commit)) problems.push(`invalid commit: ${p.id}`);
    for (const remote of [p.remote, p.upstreamRemote]) {
      if (!/^(plugin|upstream)-[a-z0-9-]+$/.test(remote) || remotes.has(remote)) problems.push(`invalid or duplicate remote: ${remote}`);
      remotes.add(remote);
    }
    if (!existsSync(join(root, p.prefix, "package.json"))) problems.push(`missing package: ${p.id}`);
    const entry = catalog.plugins.find((entry) => entry.source?.git?.subdir === p.prefix);
    if (!entry || entry.source.git.ref !== "main" || entry.source.git.url !== "https://github.com/Mesteriis/bb-marketplace.git") problems.push(`missing maintained catalog source: ${p.id}`);
  }
  return problems;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(process.argv[2] ?? fileURLToPath(new URL("../", import.meta.url)));
  const problems = validateSubtrees(root);
  if (problems.length) { console.error(problems.join("\n")); process.exitCode = 1; }
  else console.log("Subtree provenance and catalog sources agree");
}
