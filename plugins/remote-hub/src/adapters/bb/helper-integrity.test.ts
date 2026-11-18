import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkHelperIntegrity, parseSums } from "./helper-integrity.ts";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
const sha = (b: string) => createHash("sha256").update(b).digest("hex");
function bin(content: string, sums?: string) {
  const d = mkdtempSync(join(tmpdir(), "rh-int-"));
  dirs.push(d);
  writeFileSync(join(d, "remote-hub-helper"), content);
  if (sums !== undefined) writeFileSync(join(d, "SHA256SUMS"), sums);
  return join(d, "remote-hub-helper");
}

describe("helper integrity", () => {
  it("a matching sums file verifies; the format of shasum -a 256 and a binary marker both parse", () => {
    expect(checkHelperIntegrity(bin("abc", `${sha("abc")}  remote-hub-helper\n`))).toEqual({ ok: true, verified: true });
    expect(checkHelperIntegrity(bin("abc", `${sha("abc").toUpperCase()} *remote-hub-helper\n`))).toEqual({ ok: true, verified: true });
    expect(parseSums("bad line\n" + `${"a".repeat(64)}  x\n`).get("x")).toBe("a".repeat(64));
  });
  it("no sums file means an unverified (checkout) helper, not a failure", () => {
    expect(checkHelperIntegrity(bin("abc"))).toEqual({ ok: true, verified: false });
  });
  it("a changed binary, a file that does not list it, or a garbage sums file is refused", () => {
    expect(checkHelperIntegrity(bin("abc", `${sha("other")}  remote-hub-helper\n`))).toEqual({ ok: false, code: "helper_tampered", reason: "mismatch" });
    expect(checkHelperIntegrity(bin("abc", `${sha("abc")}  something-else\n`))).toEqual({ ok: false, code: "helper_tampered", reason: "not_listed" });
    expect(checkHelperIntegrity(bin("abc", "not a sums file"))).toEqual({ ok: false, code: "helper_tampered", reason: "not_listed" });
  });
});
