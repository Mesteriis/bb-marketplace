// Every crate linked into the release helper must be a row (`| name | version |`) of the Commander helper table in the
// repository's THIRD_PARTY_NOTICES.md. The list is cargo's normal dependency tree for aarch64-apple-darwin; a row that is
// not in Cargo.lock is an error too. Without cargo the lockfile alone is checked for stale rows.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const notices = readFileSync(join(root, "..", "..", "THIRD_PARTY_NOTICES.md"), "utf8");
const section = notices.split("## Commander archive helper (Rust crates)")[1]?.split(/\n## /)[0];
if (section === undefined) {
  console.error("error: THIRD_PARTY_NOTICES.md has no 'Commander archive helper (Rust crates)' section");
  process.exit(1);
}
const rows = new Set([...section.matchAll(/^\| ([A-Za-z0-9_-]+) \| ([0-9][^ |]*) \|/gm)].map((m) => `${m[1]} ${m[2]}`));
const lock = readFileSync(join(root, "helper", "Cargo.lock"), "utf8");
const locked = new Set([...lock.matchAll(/\[\[package\]\]\nname = "([^"]+)"\nversion = "([^"]+)"/g)].map((m) => `${m[1]} ${m[2]}`));
const problems = [];
for (const row of rows) if (!locked.has(row)) problems.push(`notices row not in Cargo.lock: ${row}`);
let tree = null;
try {
  tree = execFileSync("cargo", ["tree", "--locked", "-e", "normal", "--target", "aarch64-apple-darwin", "--prefix", "none", "--manifest-path", join(root, "helper", "Cargo.toml")], { encoding: "utf8" });
} catch {
  console.warn("warning: cargo is not available; only stale rows were checked");
}
if (tree !== null) {
  for (const line of tree.split("\n")) {
    const m = /^([A-Za-z0-9_-]+) v([0-9][^ ]*)/.exec(line);
    if (!m || m[1] === "commander-archive-helper") continue;
    if (!rows.has(`${m[1]} ${m[2]}`)) problems.push(`crate missing from notices: ${m[1]} ${m[2]}`);
  }
}
if (problems.length > 0) {
  for (const p of problems) console.error("error:", p);
  process.exit(1);
}
console.log(`notices ok (${rows.size} crates)`);
