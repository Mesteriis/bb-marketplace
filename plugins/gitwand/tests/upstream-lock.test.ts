// The lock pins upstream and the exact patch bytes the runtime is built from.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../", import.meta.url);
const lock = JSON.parse(readFileSync(new URL("upstream.lock.json", root), "utf8"));

describe("upstream.lock.json", () => {
  it("pins GitWand v3.14.0 by full commit", () => {
    expect(lock).toMatchObject({
      repo: "https://github.com/devlint/GitWand.git",
      tag: "v3.14.0",
      commit: "436b9684f096e8edd35b6a36e3b4d3af0fd7e084",
    });
  });

  it("lists every patch file, in order", () => {
    expect(lock.patches.map((p: { name: string }) => p.name)).toEqual(readdirSync(new URL("patches/", root)).sort());
  });

  it.each(lock.patches as { name: string; sha256: string }[])("matches the bytes of $name", ({ name, sha256 }) => {
    const actual = createHash("sha256").update(readFileSync(new URL(`patches/${name}`, root))).digest("hex");
    expect(actual).toBe(sha256);
  });
});
