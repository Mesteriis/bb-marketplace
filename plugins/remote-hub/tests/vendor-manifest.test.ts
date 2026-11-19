import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("vendored noVNC", () => {
  it("is exactly what MANIFEST.sha256 says (check:vendor)", () => {
    const out = execFileSync("node", [join(root, "scripts", "check-vendor.mjs")], { encoding: "utf8" });
    expect(out).toContain("matches its manifest (59 files)");
  });
});
