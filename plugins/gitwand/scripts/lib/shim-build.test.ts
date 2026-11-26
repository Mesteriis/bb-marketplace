import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SHIM_SOURCE } from "../../src/adapters/bb/shim-source.generated.ts";
import { transpileShim } from "./shim-build.ts";

describe("transpileShim", () => {
  it("turns the TypeScript shim into a plain function declaration without exports or types", () => {
    const js = transpileShim("export interface C { a: string }\nexport function installTauriShim(win: any, cfg: C): void { win.x = cfg.a as string; }\n");
    expect(js).toBe("function installTauriShim(win, cfg) { win.x = cfg.a; }\n");
  });

  it("refuses a shim that imports anything, since the string must stand alone", () => {
    expect(() => transpileShim('import { z } from "zod";\nexport function installTauriShim() {}\n')).toThrow("the shim must not import");
  });
});

describe("shim-source.generated.ts", () => {
  it("is the current shim source (run `npm run shim` after editing src/shim/tauri-shim.ts)", () => {
    const source = readFileSync(new URL("../../src/shim/tauri-shim.ts", import.meta.url), "utf8");
    expect(SHIM_SOURCE).toBe(transpileShim(source));
  });
});
