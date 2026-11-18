// Build-output gate (stage 5): what a release must contain, and what it must not.
//   node scripts/check-build-output.mjs [--release]
// Always: dist/ has the files `bb plugin build` produces, app.css carries our rules (check-dist-css), the plugin id and version
// in the build metadata match package.json, and no file leaks this machine's home directory (a source map that does is
// reported as a warning, with the advice not to ship it).
// With --release: bin/remote-hub-helper and bin/SHA256SUMS must exist and agree, and the binary must be an arm64 Mach-O.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { checkHelperIntegrity } from "../src/adapters/bb/helper-integrity.ts";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const release = process.argv.includes("--release");
const problems = [];
const warnings = [];
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

const REQUIRED_DIST = ["app.js", "app.css", "app.meta.json", "server.js", "server.meta.json", "package.json"];
for (const f of REQUIRED_DIST) if (!existsSync(join(root, "dist", f))) problems.push(`dist/${f} is missing: run npm run build`);

if (problems.length === 0) {
  const meta = JSON.parse(readFileSync(join(root, "dist", "app.meta.json"), "utf8"));
  if (meta.pluginId !== "makosh-remote-hub") problems.push(`dist/app.meta.json pluginId is ${meta.pluginId}`);
  if (meta.pluginVersion !== pkg.version) problems.push(`dist/app.meta.json pluginVersion ${meta.pluginVersion} != package.json ${pkg.version}`);
  const home = homedir();
  for (const f of readdirSync(join(root, "dist"))) {
    const text = readFileSync(join(root, "dist", f), "utf8");
    // The only home-looking string the app itself carries is the placeholder shown in the key-file field.
    const leaks = [...text.matchAll(new RegExp(home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "[^\"'\\s]*", "g"))].length;
    if (leaks > 0) (f.endsWith(".map") ? warnings : problems).push(`dist/${f} contains this machine's home directory (${leaks}x)${f.endsWith(".map") ? "; do not ship source maps" : ""}`);
  }
}

if (release) {
  const bin = join(root, "bin", "remote-hub-helper");
  if (!existsSync(bin)) problems.push("bin/remote-hub-helper is missing");
  else {
    // The same strict check the plugin runs before it starts the helper: the one shared module. A helper that fails it is
    // never executed here (not even with --version).
    const integrity = checkHelperIntegrity(bin);
    if (!integrity.ok) problems.push(`bin/remote-hub-helper failed the checksum check (${integrity.reason}); run npm run helper:sums`);
    else {
      const out = execFileSync("file", [bin], { encoding: "utf8" });
      if (!/Mach-O 64-bit executable arm64/.test(out)) problems.push(`bin/remote-hub-helper is not an arm64 Mach-O: ${out.trim()}`);
      // The binary must not carry the builder's home directory (cargo and rustc paths end up in panic messages).
      if (readFileSync(bin).includes(Buffer.from(homedir()))) problems.push("bin/remote-hub-helper contains this machine's home directory: build it with npm run build:helper (it remaps paths)");
      try {
        const version = execFileSync(bin, ["--version"], { encoding: "utf8" }).trim();
        if (version !== `remote-hub-helper ${pkg.version}`) problems.push(`helper reports "${version}", package.json is ${pkg.version}`);
      } catch (e) {
        problems.push(`the helper cannot run: ${e.message}`);
      }
    }
  }
}

for (const w of warnings) console.warn("warning:", w);
if (problems.length > 0) {
  for (const p of problems) console.error("error:", p);
  process.exit(1);
}
console.log(`build output ok (${release ? "release" : "dist only"})`);
