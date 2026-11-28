// Writes bin/SHA256SUMS for bin/commander-archive-helper (shasum -a 256 format). Run after `npm run build:helper`.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const bin = join(dirname(fileURLToPath(import.meta.url)), "..", "bin");
const sum = createHash("sha256").update(readFileSync(join(bin, "commander-archive-helper"))).digest("hex");
writeFileSync(join(bin, "SHA256SUMS"), `${sum}  commander-archive-helper\n`);
console.log(`bin/SHA256SUMS: ${sum}`);
