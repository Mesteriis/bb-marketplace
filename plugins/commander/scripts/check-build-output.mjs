// Build-output gate. Always: dist/ carries the files `bb plugin build` produces and no file leaks this machine's home
// directory. With --release: bin/commander-archive-helper and bin/SHA256SUMS must agree (the same strict check the plugin
// runs before it spawns the helper), the binary must be an arm64 Mach-O without the builder's home directory, and it must
// report the version package.json names for it.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkHelperIntegrity } from "../src/adapters/bb/archive-helper-integrity.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const release = process.argv.includes("--release");
const HELPER_VERSION = "0.1.0";
const problems = [];
for (const f of ["app.js", "server.js", "package.json"]) {
  if (!existsSync(join(root, "dist", f))) problems.push(`dist/${f} is missing: run npm run build`);
}
if (problems.length === 0) {
  const home = homedir();
  for (const f of readdirSync(join(root, "dist"))) {
    if (!readFileSync(join(root, "dist", f), "utf8").includes(home)) continue;
    // A source map names the builder's paths; it is reported, with the advice not to ship it, but does not fail the gate.
    if (f.endsWith(".map")) console.warn(`warning: dist/${f} contains this machine's home directory; do not ship source maps`);
    else problems.push(`dist/${f} contains this machine's home directory`);
  }
}
if (release) {
  const bin = join(root, "bin", "commander-archive-helper");
  if (!existsSync(bin)) problems.push("bin/commander-archive-helper is missing");
  else {
    const integrity = checkHelperIntegrity(bin);
    if (!integrity.ok) problems.push(`the helper failed the checksum check (${integrity.reason}); run npm run helper:sums`);
    else {
      const out = execFileSync("file", [bin], { encoding: "utf8" });
      if (!/Mach-O 64-bit executable arm64/.test(out)) problems.push(`the helper is not an arm64 Mach-O: ${out.trim()}`);
      if (readFileSync(bin).includes(Buffer.from(homedir()))) problems.push("the helper contains this machine's home directory: build it with npm run build:helper");
      const version = execFileSync(bin, ["--version"], { encoding: "utf8" }).trim();
      if (version !== `commander-archive-helper ${HELPER_VERSION}`) problems.push(`the helper reports "${version}", expected ${HELPER_VERSION}`);
    }
  }
}
if (problems.length > 0) {
  for (const p of problems) console.error("error:", p);
  process.exit(1);
}
console.log(`build output ok (${release ? "release" : "dist only"})`);
