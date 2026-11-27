import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { classifyMarker, descend, type GitMarker, type ScanRules, type SkipReason, type Verdict } from "../../core/catalog/project-scan.ts";

/** Levels below a hidden or excluded folder that are still read to report what was left out. */
const peekDepth = 1;

async function gitdirOf(folder: string) {
  try {
    const text = await readFile(join(folder, ".git"), {encoding: "utf8", flag: "r"});
    const match = /^gitdir:\s*(.+?)\s*$/m.exec(text.slice(0, 4096));
    if (!match) return null;
    const target = resolve(dirname(join(folder, ".git")), match[1]);
    return (await stat(target)).isDirectory() ? target : null;
  } catch { return null; }
}

/** Reads the projects folder without following symlinks or entering `.git`. Read-only. */
export async function walkProjects(root: string, rules: ScanRules, limit = 200_000): Promise<{verdicts: Verdict[]; truncated: boolean}> {
  const verdicts: Verdict[] = [];
  let visited = 0;
  let truncated = false;

  async function visit(folder: string, depth: number, skipped: {reason: SkipReason; remaining: number} | null) {
    if (++visited > limit) { truncated = true; return; }
    let entries: Dirent[];
    try { entries = await readdir(folder, {withFileTypes: true}); } catch { return; }
    const git = entries.find(entry => entry.name === ".git");
    if (git && (git.isDirectory() || git.isFile())) {
      const marker: GitMarker = git.isDirectory() ? {path: folder, git: "dir"} : {path: folder, git: "file", gitdir: await gitdirOf(folder)};
      const verdict = classifyMarker(marker);
      verdicts.push(skipped && verdict.kind === "project" ? {path: folder, kind: "skipped", reason: skipped.reason} : verdict);
    }
    if (depth >= rules.maxDepth) return;
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (truncated) return;
      if (!entry.isDirectory() || entry.name === ".git") continue;
      const child = join(folder, entry.name);
      if (skipped) {
        if (skipped.remaining > 0) await visit(child, depth + 1, {...skipped, remaining: skipped.remaining - 1});
        continue;
      }
      const decision = descend(entry.name, rules);
      await visit(child, depth + 1, decision === "descend" ? null : {reason: decision, remaining: peekDepth});
    }
  }

  await visit(root, 0, null);
  return {verdicts, truncated};
}
