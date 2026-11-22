import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// @ts-expect-error -- plain ESM build script without type declarations
import { OUTPUT, bundlePoolBridge, generatedModule } from "../scripts/build-pool-bridge.mjs";
import { POOL_BRIDGE_BUNDLE } from "../src/adapters/bb/pool-bridge.bundle.generated.js";

describe("generated pool bridge bundle", () => {
  it("matches the current bridge sources (run npm run build:bridge)", async () => {
    const bundle: string = await bundlePoolBridge();
    expect(readFileSync(OUTPUT, "utf8")).toBe(generatedModule(bundle));
  });

  it("is the IIFE the Account Pooler patch expects", () => {
    expect(POOL_BRIDGE_BUNDLE.startsWith("var __makoshPoolBridge=")).toBe(true);
    expect(POOL_BRIDGE_BUNDLE).toContain("registerPoolModelApi");
  });
});
