import { describe, expect, it } from "vitest";
import { buildChannelManifest, releaseAssetName } from "./channel-manifest.ts";

const BASE = "https://github.com/Mesteriis/GitWand-bb/releases/download/runtime-3.14.0-bb1";
const INPUT = {
  version: "3.14.0+bb1",
  gitwandTag: "v3.14.0",
  commit: "436b9684f096e8edd35b6a36e3b4d3af0fd7e084",
  minPluginVersion: "0.1.0",
  baseUrl: BASE,
  archives: [
    { file: "gitwand-runtime-3.14.0+bb1-linux-x64.tar.gz", sha256: "bb".repeat(32), size: 8000000 },
    { file: "gitwand-runtime-3.14.0+bb1-darwin-arm64.tar.gz", sha256: "aa".repeat(32), size: 7063799 },
  ],
};

describe("releaseAssetName", () => {
  it("replaces the + of the build number, which release hosts may rewrite", () => {
    expect(releaseAssetName("gitwand-runtime-3.14.0+bb1-darwin-arm64.tar.gz")).toBe("gitwand-runtime-3.14.0-bb1-darwin-arm64.tar.gz");
  });
});

describe("buildChannelManifest", () => {
  it("writes channel.json with one entry per platform, sorted, pointing at the release assets", () => {
    expect(buildChannelManifest(INPUT)).toBe(
      `{
  "version": "3.14.0+bb1",
  "gitwandTag": "v3.14.0",
  "commit": "436b9684f096e8edd35b6a36e3b4d3af0fd7e084",
  "minPluginVersion": "0.1.0",
  "platforms": {
    "darwin-arm64": {
      "url": "${BASE}/gitwand-runtime-3.14.0-bb1-darwin-arm64.tar.gz",
      "sha256": "${"aa".repeat(32)}",
      "size": 7063799
    },
    "linux-x64": {
      "url": "${BASE}/gitwand-runtime-3.14.0-bb1-linux-x64.tar.gz",
      "sha256": "${"bb".repeat(32)}",
      "size": 8000000
    }
  }
}
`,
    );
  });

  it.each([
    ["an archive of another version", { archives: [{ ...INPUT.archives[0], file: "gitwand-runtime-3.14.0+bb2-linux-x64.tar.gz" }] }, /not an archive of 3\.14\.0\+bb1/],
    ["an unknown platform", { archives: [{ ...INPUT.archives[0], file: "gitwand-runtime-3.14.0+bb1-windows-x64.tar.gz" }] }, /not an archive of 3\.14\.0\+bb1/],
    ["two archives for one platform", { archives: [INPUT.archives[0], INPUT.archives[0]] }, /two archives for linux-x64/],
    ["no archives", { archives: [] }, /no archives/],
    ["an http base URL", { baseUrl: "http://example.invalid/x" }, /invalid channel manifest/],
    ["a short sha256", { archives: [{ ...INPUT.archives[0], sha256: "ab" }] }, /invalid channel manifest/],
  ])("refuses %s", (_name, change, message) => {
    expect(() => buildChannelManifest({ ...INPUT, ...change })).toThrow(message);
  });
});
