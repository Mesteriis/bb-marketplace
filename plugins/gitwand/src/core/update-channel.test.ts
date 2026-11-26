import { describe, expect, it } from "vitest";
import { parseChannelManifest, selectUpdate } from "./update-channel.ts";

const MANIFEST = {
  version: "3.14.0+bb2",
  gitwandTag: "v3.14.0",
  commit: "436b9684f096e8edd35b6a36e3b4d3af0fd7e084",
  minPluginVersion: "0.2.0",
  platforms: {
    "darwin-arm64": { url: "https://example.invalid/a.tar.gz", sha256: "ab".repeat(32), size: 7063799 },
  },
};

describe("parseChannelManifest", () => {
  it("accepts a well-formed manifest", () => {
    expect(parseChannelManifest(JSON.stringify(MANIFEST))).toEqual(MANIFEST);
  });

  it.each([
    ["not JSON", "{"],
    ["a bad version", JSON.stringify({ ...MANIFEST, version: "latest" })],
    ["a short commit", JSON.stringify({ ...MANIFEST, commit: "436b968" })],
    ["an http URL", JSON.stringify({ ...MANIFEST, platforms: { "darwin-arm64": { ...MANIFEST.platforms["darwin-arm64"], url: "http://x/a" } } })],
    ["a bad sha256", JSON.stringify({ ...MANIFEST, platforms: { "darwin-arm64": { ...MANIFEST.platforms["darwin-arm64"], sha256: "xyz" } } })],
    ["an unknown platform", JSON.stringify({ ...MANIFEST, platforms: { "win-x64": MANIFEST.platforms["darwin-arm64"] } })],
    ["a zero size", JSON.stringify({ ...MANIFEST, platforms: { "darwin-arm64": { ...MANIFEST.platforms["darwin-arm64"], size: 0 } } })],
  ])("refuses %s", (_name, text) => {
    expect(() => parseChannelManifest(text)).toThrow(/channel manifest/);
  });
});

describe("selectUpdate", () => {
  const m = parseChannelManifest(JSON.stringify(MANIFEST));

  it("offers a newer build for this platform", () => {
    expect(selectUpdate(m, { installed: "3.14.0+bb1", pluginVersion: "0.2.0", platform: "darwin-arm64" })).toEqual({
      kind: "available",
      version: "3.14.0+bb2",
      url: "https://example.invalid/a.tar.gz",
      sha256: "ab".repeat(32),
      size: 7063799,
    });
  });

  it("offers it when nothing is installed yet", () => {
    expect(selectUpdate(m, { installed: null, pluginVersion: "0.3.0", platform: "darwin-arm64" })).toMatchObject({ kind: "available" });
  });

  it.each(["3.14.0+bb2", "3.14.0+bb3", "3.15.0+bb1"])("offers nothing over the installed %s", (installed) => {
    expect(selectUpdate(m, { installed, pluginVersion: "0.2.0", platform: "darwin-arm64" })).toEqual({ kind: "none" });
  });

  it("offers nothing for a platform the channel does not build", () => {
    expect(selectUpdate(m, { installed: "3.14.0+bb1", pluginVersion: "0.2.0", platform: "linux-x64" })).toEqual({ kind: "none" });
  });

  it("asks for a newer plugin when the build needs one", () => {
    expect(selectUpdate(m, { installed: "3.14.0+bb1", pluginVersion: "0.1.9", platform: "darwin-arm64" })).toEqual({
      kind: "needs-plugin",
      minPluginVersion: "0.2.0",
    });
  });
});
