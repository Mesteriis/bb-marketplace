// The helper binary is checked against `bin/SHA256SUMS` before it is ever executed (stage 5). A release ships both files;
// a checkout that builds its own helper has no sums file and runs unverified (reported as `verified: false`).
// A sums file that exists must name the binary and match it exactly: anything else is refused, never "best effort".
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export const SUMS_FILE_NAME = "SHA256SUMS";

export type IntegrityResult = { ok: true; verified: boolean } | { ok: false; code: "helper_tampered"; reason: "mismatch" | "not_listed" | "unreadable_sums" };

/** Parses `<64 hex>  <name>` lines (sha256sum / shasum -a 256 format, text or binary marker). */
export function parseSums(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64}) [ *](.+)$/.exec(line.trim());
    if (m !== null) out.set(m[2] as string, (m[1] as string).toLowerCase());
  }
  return out;
}

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function checkHelperIntegrity(binPath: string): IntegrityResult {
  const sumsPath = join(dirname(binPath), SUMS_FILE_NAME);
  if (!existsSync(sumsPath)) return { ok: true, verified: false };
  let sums: Map<string, string>;
  try {
    sums = parseSums(readFileSync(sumsPath, "utf8"));
  } catch {
    return { ok: false, code: "helper_tampered", reason: "unreadable_sums" };
  }
  const expected = sums.get(basename(binPath));
  if (expected === undefined) return { ok: false, code: "helper_tampered", reason: "not_listed" };
  return sha256File(binPath) === expected ? { ok: true, verified: true } : { ok: false, code: "helper_tampered", reason: "mismatch" };
}
