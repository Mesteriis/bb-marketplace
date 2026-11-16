import { readFileSync, readdirSync } from "node:fs";
import { expect, test } from "vitest";

test("the prototype UI and fixtures do not import host modules", () => {
  const root = new URL("../src/", import.meta.url);
  for (const file of readdirSync(root, { recursive: true, encoding: "utf8" })) {
    if (!/^(core|ui)\//.test(file) || !/\.tsx?$/.test(file)) continue;
    const source = readFileSync(new URL(file, root), "utf8");
    expect(source, file).not.toMatch(/["'](?:@get-bb\/|node:|electron["']|@tauri-apps\/|(?:\.\.\/)+adapters\/)/);
  }
});
