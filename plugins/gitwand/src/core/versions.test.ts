import { describe, expect, it } from "vitest";
import { compareRuntimeVersions, parseRuntimeVersion, platformKey } from "./versions.ts";

describe("parseRuntimeVersion", () => {
  it("reads GitWand's version and the plugin build", () => {
    expect(parseRuntimeVersion("3.14.0+bb2")).toEqual({ major: 3, minor: 14, patch: 0, build: 2 });
  });

  it.each(["3.14.0", "3.14+bb1", "v3.14.0+bb1", "3.14.0+bb0", "3.14.0+bb1 ", "03.14.0+bb1"])("refuses %j", (v) => {
    expect(parseRuntimeVersion(v)).toBeNull();
  });
});

describe("compareRuntimeVersions", () => {
  it.each([
    ["3.14.0+bb2", "3.14.0+bb1", 1],
    ["3.13.3+bb9", "3.14.0+bb1", -1],
    ["3.14.0+bb1", "3.14.0+bb1", 0],
    ["3.14.10+bb1", "3.14.9+bb7", 1],
    ["4.0.0+bb1", "3.99.99+bb99", 1],
  ])("%s against %s is %i", (a, b, want) => {
    expect(compareRuntimeVersions(a, b)).toBe(want);
  });

  it("throws on a malformed version instead of ordering it", () => {
    expect(() => compareRuntimeVersions("latest", "3.14.0+bb1")).toThrow(/runtime version/);
  });
});

describe("platformKey", () => {
  it.each([
    ["darwin", "arm64", "darwin-arm64"],
    ["darwin", "x64", "darwin-x64"],
    ["linux", "x64", "linux-x64"],
    ["linux", "arm64", null],
    ["win32", "x64", null],
  ])("%s/%s → %s", (platform, arch, key) => {
    expect(platformKey(platform, arch)).toBe(key);
  });
});
