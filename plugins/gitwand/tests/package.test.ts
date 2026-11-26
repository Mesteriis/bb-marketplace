// A marketplace (git) install runs npm without devDependencies, and BB bundles
// SDK subpath imports such as @get-bb/plugin-sdk/process from the plugin's own
// SDK install, so the SDK must be a runtime dependency.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

describe("package.json", () => {
  it("ships the plugin SDK as a dependency, pinned", () => {
    expect(pkg.dependencies["@get-bb/plugin-sdk"]).toBe("0.6.132");
    expect(pkg.devDependencies["@get-bb/plugin-sdk"]).toBeUndefined();
  });
});
