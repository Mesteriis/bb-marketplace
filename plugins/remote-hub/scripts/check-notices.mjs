// Every crate linked into the release helper and every production npm package must be named in THIRD_PARTY_NOTICES.md.
// Crates are the `normal` dependency tree for aarch64-apple-darwin (dev and build-only tools excluded); a crate counts as
// covered when its name appears in the file either on its own or inside a prefix pattern written as `name_*` / `name-*`
// (the file groups families such as icu_*), or as a family root like `windows*`.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const notices = readFileSync(join(root, "THIRD_PARTY_NOTICES.md"), "utf8");
const lower = notices.toLowerCase();
const crates = new Set(
  execFileSync("cargo", ["tree", "--locked", "-e", "normal", "--target", "aarch64-apple-darwin", "--prefix", "none", "--manifest-path", join(root, "helper", "Cargo.toml")], { encoding: "utf8" })
    .split("\n")
    .map((l) => /^([A-Za-z0-9_-]+) v/.exec(l)?.[1])
    .filter((n) => n !== undefined && n !== "remote-hub-helper"),
);
const covered = (name) => {
  const n = name.toLowerCase();
  if (new RegExp(`(^|[^a-z0-9_-])${n.replace(/[-_]/g, "[-_]")}([^a-z0-9_-]|$)`).test(lower)) return true;
  // prefix families: "icu_*", "ironrdp-*", "windows*", "tokio-*"
  for (const m of lower.matchAll(/([a-z0-9]+(?:[-_][a-z0-9]+)*)[-_]?\*/g)) if (n.startsWith(m[1])) return true;
  return false;
};
const missingCrates = [...crates].filter((c) => !covered(c)).sort();

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const missingNpm = Object.keys(pkg.dependencies ?? {}).filter((d) => !lower.includes(d.toLowerCase()));

if (missingCrates.length + missingNpm.length > 0) {
  if (missingCrates.length > 0) console.error("crates linked into the helper but not in THIRD_PARTY_NOTICES.md:", missingCrates.join(", "));
  if (missingNpm.length > 0) console.error("production npm packages not in THIRD_PARTY_NOTICES.md:", missingNpm.join(", "));
  process.exit(1);
}
console.log(`notices cover ${crates.size} linked crates and ${Object.keys(pkg.dependencies ?? {}).length} production npm packages`);
