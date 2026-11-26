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

  it("records the published runtime release, as in its signed channel.json", () => {
    expect(lock.runtime).toEqual({
      version: "3.14.0+bb2",
      release: "https://github.com/Mesteriis/GitWand-bb/releases/tag/runtime-3.14.0-bb2",
      builtFrom: "c988566144abb2fb2b1e94d4d94da4e96957d6a5",
      signingKey: "24041B7E27AE78BE",
      channel: { sha256: "090d5baa35ff040904b3c33c482a62c205964b035145c83f0e039649b78fc882" },
      platforms: {
        "darwin-arm64": {
          url: "https://github.com/Mesteriis/GitWand-bb/releases/download/runtime-3.14.0-bb2/gitwand-runtime-3.14.0-bb2-darwin-arm64.tar.gz",
          sha256: "9c98efe4521c06af35605270ec288a725c296610e664350e5f258bf2218b3c6b",
          size: 7074965,
        },
        "darwin-x64": {
          url: "https://github.com/Mesteriis/GitWand-bb/releases/download/runtime-3.14.0-bb2/gitwand-runtime-3.14.0-bb2-darwin-x64.tar.gz",
          sha256: "d9143ce70272089e0f6bc70221dbe3a7418a014b86c2d3e3d49ab12ac66ff720",
          size: 7329059,
        },
        "linux-x64": {
          url: "https://github.com/Mesteriis/GitWand-bb/releases/download/runtime-3.14.0-bb2/gitwand-runtime-3.14.0-bb2-linux-x64.tar.gz",
          sha256: "25ba695c90448a8894d9dcd83053914fe9d6babd4afa5ad73b86a7b1808299ea",
          size: 8416074,
        },
      },
    });
  });
});
