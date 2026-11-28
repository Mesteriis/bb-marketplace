import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkHelperIntegrity, parseSums } from "./archive-helper-integrity.ts";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
const sha = (b: string) => createHash("sha256").update(b).digest("hex");
function bin(content: string, sums?: string) {
  const d = mkdtempSync(join(tmpdir(), "ca-int-"));
  dirs.push(d);
  writeFileSync(join(d, "commander-archive-helper"), content);
  if (sums !== undefined) writeFileSync(join(d, "SHA256SUMS"), sums);
  return join(d, "commander-archive-helper");
}
const fail = (reason: string) => ({ ok: false, code: "helper_checksum_failed", reason });

describe("helper integrity (fail closed)", () => {
  it("a matching sums file verifies; the shasum -a 256 format with either marker parses", () => {
    expect(checkHelperIntegrity(bin("abc", `${sha("abc")}  commander-archive-helper\n`))).toEqual({ ok: true });
    expect(checkHelperIntegrity(bin("abc", `${sha("abc").toUpperCase()} *commander-archive-helper\n`))).toEqual({ ok: true });
  });
  it("a MISSING sums file refuses: there is no unverified mode", () => {
    expect(checkHelperIntegrity(bin("abc"))).toEqual(fail("no_sums"));
  });
  it("a changed binary, an entry for another file, or a duplicate entry is refused", () => {
    expect(checkHelperIntegrity(bin("abc", `${sha("other")}  commander-archive-helper\n`))).toEqual(fail("mismatch"));
    expect(checkHelperIntegrity(bin("abc", `${sha("abc")}  something-else\n`))).toEqual(fail("not_listed"));
    expect(checkHelperIntegrity(bin("abc", `${sha("abc")}  commander-archive-helper\n${sha("abc")}  commander-archive-helper\n`))).toEqual(fail("duplicate"));
  });
  it("any malformed line is an error, not skipped", () => {
    for (const text of ["not a sums file", `${sha("abc")}  commander-archive-helper\ngarbage\n`, `${sha("abc").slice(1)}  commander-archive-helper\n`, `${sha("abc")} commander-archive-helper\n`, `${sha("abc")}  ../commander-archive-helper\n`]) {
      expect(checkHelperIntegrity(bin("abc", text)), text).toEqual(fail("malformed_sums"));
    }
  });
  it("a binary or a sums file that is a symlink is refused", () => {
    const real = bin("abc", `${sha("abc")}  commander-archive-helper\n`);
    const dir = mkdtempSync(join(tmpdir(), "ca-int-"));
    dirs.push(dir);
    symlinkSync(real, join(dir, "commander-archive-helper"));
    writeFileSync(join(dir, "SHA256SUMS"), `${sha("abc")}  commander-archive-helper\n`);
    expect(checkHelperIntegrity(join(dir, "commander-archive-helper"))).toEqual(fail("symlink"));
    const dir2 = mkdtempSync(join(tmpdir(), "ca-int-"));
    dirs.push(dir2);
    writeFileSync(join(dir2, "commander-archive-helper"), "abc");
    symlinkSync(join(real, "..", "SHA256SUMS"), join(dir2, "SHA256SUMS"));
    expect(checkHelperIntegrity(join(dir2, "commander-archive-helper"))).toEqual(fail("symlink"));
  });
  it("parseSums wants exactly one entry for the named file", () => {
    expect(parseSums(`${"a".repeat(64)}  x\n\n`, "x")).toEqual({ ok: true, sha256: "a".repeat(64) });
    expect(parseSums("", "x")).toEqual({ ok: false, reason: "not_listed" });
  });
});
