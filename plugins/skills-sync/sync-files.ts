import * as fs from "node:fs";
import * as path from "node:path";

/** Direct child directories, excluding dot-entries. */
export function listDirs(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort();
}

/** Every file under `dir`, relative and sorted; dot-entries included. */
export function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string, prefix: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(path.join(current, entry.name), rel);
      else if (entry.isFile()) out.push(rel);
    }
  };
  walk(dir, "");
  return out.sort();
}

export function readFileOrNull(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** Files present in either tree whose bytes differ. Missing counts as differing. */
export function changedFiles(a: string | null, b: string | null): string[] {
  const files = new Set<string>([
    ...(a === null ? [] : listFiles(a)),
    ...(b === null ? [] : listFiles(b)),
  ]);
  const changed: string[] = [];
  for (const file of [...files].sort()) {
    const left = a === null ? null : readFileOrNull(path.join(a, file));
    const right = b === null ? null : readFileOrNull(path.join(b, file));
    if (left !== right) changed.push(file);
  }
  return changed;
}
