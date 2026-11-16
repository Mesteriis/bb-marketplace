#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const registry = JSON.parse(readFileSync(new URL("../subtrees.json", import.meta.url), "utf8"));
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const known = new Set(git("remote").split("\n"));
for (const p of registry.plugins) {
  for (const [name, url] of [[p.remote, p.fork], [p.upstreamRemote, p.upstream]]) {
    if (known.has(name)) {
      if (git("remote", "get-url", name) !== url) throw new Error(`Remote ${name} already points elsewhere; inspect it before changing it`);
    } else {
      git("remote", "add", name, url);
      known.add(name);
    }
  }
}
console.log(`Configured fork/upstream remotes for ${registry.plugins.length} subtrees`);
