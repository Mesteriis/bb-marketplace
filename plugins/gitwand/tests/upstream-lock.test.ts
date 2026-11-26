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
      version: "3.14.0+bb1",
      release: "https://github.com/Mesteriis/GitWand-bb/releases/tag/runtime-3.14.0-bb1",
      builtFrom: "eb96a11416ad7ec08f8df666c5e6472daf8d3851",
      signingKey: "24041B7E27AE78BE",
      channel: { sha256: "213e0316c5d2a511b9ef37e34b52e7da54c7a265ca001687da31b3a12ad91270" },
      platforms: {
        "darwin-arm64": {
          url: "https://github.com/Mesteriis/GitWand-bb/releases/download/runtime-3.14.0-bb1/gitwand-runtime-3.14.0-bb1-darwin-arm64.tar.gz",
          sha256: "d182e6b2130900d36225711c004a4e6462a7350a288d2bd0d67556acb5d0d11e",
          size: 7063890,
        },
        "darwin-x64": {
          url: "https://github.com/Mesteriis/GitWand-bb/releases/download/runtime-3.14.0-bb1/gitwand-runtime-3.14.0-bb1-darwin-x64.tar.gz",
          sha256: "9ca9303fb98c6dceb4cdb8fc5d38c336bdbe79484bbc071e46af08c93da7c4c5",
          size: 7316930,
        },
        "linux-x64": {
          url: "https://github.com/Mesteriis/GitWand-bb/releases/download/runtime-3.14.0-bb1/gitwand-runtime-3.14.0-bb1-linux-x64.tar.gz",
          sha256: "427a686c5fc572e1fbd6633f47681065e95201013b229bcc66a629bd1f653b86",
          size: 8406326,
        },
      },
    });
  });
});
