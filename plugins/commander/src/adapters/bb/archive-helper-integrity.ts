// Ported from plugins/remote-hub/src/adapters/bb/helper-integrity.ts (same repository); see THIRD_PARTY_NOTICES.md.
// The helper binary is checked against `bin/SHA256SUMS` before it is ever executed (S14). What this proves: the install is
// not corrupted or half-updated. What it does NOT prove: anything about someone who can write to the plugin directory (they
// could replace SHA256SUMS, or dist/server.js, as well). Fail closed: a missing,
// malformed or non-matching sums file, or a binary or sums file that is a symlink, means the helper is NOT started. There
// is no override of any kind. A checkout builds its own helper with `npm run build:helper`, which writes the sums file
// next to the binary it just built, so development needs no bypass.
// This module is also loaded by the release scripts (scripts/check-build-output.mjs), so there is one parser: it uses only
// node built-ins and no TypeScript-only syntax.
//
// Not solved, on purpose: the file is hashed and then executed by path, so a process of the SAME user that swaps the binary
// between the two steps wins (see "same-user" in docs/security.md).
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export const SUMS_FILE_NAME = "SHA256SUMS";

export type IntegrityReason = "no_sums" | "unreadable_sums" | "malformed_sums" | "not_listed" | "duplicate" | "symlink" | "mismatch";
export type IntegrityResult = { ok: true } | { ok: false; code: "helper_checksum_failed"; reason: IntegrityReason };

/**
 * Strict `sha256sum` / `shasum -a 256` format: every non-blank line is `<64 hex>  <name>` (text or binary marker), and the
 * named file must have exactly one entry. Returns the hash, or the reason it cannot be trusted.
 */
export function parseSums(text: string, name: string): { ok: true; sha256: string } | { ok: false; reason: IntegrityReason } {
  const entries: Array<[string, string]> = [];
  for (const raw of text.split(/\r?\n/)) {
    if (raw.trim() === "") continue;
    const m = /^([0-9a-fA-F]{64}) [ *]([^\s/\\][^/\\]*)$/.exec(raw);
    if (m === null) return { ok: false, reason: "malformed_sums" };
    entries.push([m[2] as string, (m[1] as string).toLowerCase()]);
  }
  const mine = entries.filter(([n]) => n === name);
  if (mine.length === 0) return { ok: false, reason: "not_listed" };
  if (mine.length > 1) return { ok: false, reason: "duplicate" };
  return { ok: true, sha256: (mine[0] as [string, string])[1] };
}

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

const isRegularFile = (path: string): boolean => {
  try {
    const s = lstatSync(path);
    return s.isFile() && !s.isSymbolicLink();
  } catch {
    return false;
  }
};

export function checkHelperIntegrity(binPath: string): IntegrityResult {
  const sumsPath = join(dirname(binPath), SUMS_FILE_NAME);
  const fail = (reason: IntegrityReason): IntegrityResult => ({ ok: false, code: "helper_checksum_failed", reason });
  let sumsStat;
  try {
    sumsStat = lstatSync(sumsPath);
  } catch {
    return fail("no_sums");
  }
  if (sumsStat.isSymbolicLink() || !sumsStat.isFile()) return fail("symlink");
  if (!isRegularFile(binPath)) return fail("symlink");
  let text: string;
  try {
    text = readFileSync(sumsPath, "utf8");
  } catch {
    return fail("unreadable_sums");
  }
  const parsed = parseSums(text, basename(binPath));
  if (!parsed.ok) return fail(parsed.reason);
  try {
    return sha256File(binPath) === parsed.sha256 ? { ok: true } : fail("mismatch");
  } catch {
    return fail("mismatch");
  }
}
