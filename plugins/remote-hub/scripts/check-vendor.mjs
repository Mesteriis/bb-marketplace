// The vendored noVNC tree must be byte-for-byte what the manifest says: every file listed with its SHA-256, no file missing, no
// file extra (README.md and MANIFEST.sha256 are ours). `--write` rewrites the manifest after a deliberate update.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "vendor", "novnc");
const OURS = new Set(["README.md", "MANIFEST.sha256"]);

function files(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? files(full) : [full];
  });
}

const actual = new Map(
  files(root)
    .map((f) => relative(root, f).split(sep).join("/"))
    .filter((f) => !OURS.has(f))
    .sort()
    .map((f) => [f, createHash("sha256").update(readFileSync(join(root, f))).digest("hex")]),
);

if (process.argv.includes("--write")) {
  writeFileSync(join(root, "MANIFEST.sha256"), [...actual].map(([f, h]) => `${h}  ${f}`).join("\n") + "\n");
  console.log(`manifest written for ${actual.size} files`);
  process.exit(0);
}

const expected = new Map(
  readFileSync(join(root, "MANIFEST.sha256"), "utf8")
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => {
      const [hash, ...path] = l.split("  ");
      return [path.join("  "), hash];
    }),
);
const problems = [
  ...[...expected].filter(([f, h]) => actual.get(f) !== undefined && actual.get(f) !== h).map(([f]) => `changed: ${f}`),
  ...[...expected].filter(([f]) => !actual.has(f)).map(([f]) => `missing: ${f}`),
  ...[...actual].filter(([f]) => !expected.has(f)).map(([f]) => `extra: ${f}`),
];
if (problems.length > 0) {
  console.error("vendor/novnc differs from MANIFEST.sha256:\n" + problems.join("\n"));
  process.exit(1);
}
console.log(`vendor/novnc matches its manifest (${actual.size} files)`);
