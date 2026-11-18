// Does bin/remote-hub-helper correspond to the source? Rebuilds the helper in a throwaway target directory with the same
// flags as `npm run build:helper` and compares. Rust builds are not guaranteed to be byte-identical across machines and
// toolchains, so a difference is REPORTED with both hashes (exit 2) and is for a person to judge; a missing binary or a
// failing build is an error (exit 1). Identical = exit 0.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const committed = join(root, "bin", "remote-hub-helper");
if (!existsSync(committed)) {
  console.error("bin/remote-hub-helper does not exist");
  process.exit(1);
}
const target = mkdtempSync(join(tmpdir(), "rh-verify-"));
try {
  execFileSync("cargo", ["build", "--release", "--locked", "--target", "aarch64-apple-darwin", "--manifest-path", join(root, "helper", "Cargo.toml")], {
    stdio: "inherit",
    env: { ...process.env, CARGO_TARGET_DIR: target },
  });
  const built = join(target, "aarch64-apple-darwin", "release", "remote-hub-helper");
  const hash = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
  const [a, b] = [hash(committed), hash(built)];
  console.log(`bin/remote-hub-helper ${a}\nrebuilt from source   ${b}`);
  if (a === b) console.log("identical");
  else {
    console.log("DIFFERENT: not necessarily wrong (non-reproducible build), but the binary was not made from exactly this source on this toolchain");
    process.exitCode = 2;
  }
} finally {
  rmSync(target, { recursive: true, force: true });
}
