import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

test("the core and rendered UI do not import BB or platform APIs", () => {
  for (const layer of ["core", "ui"]) {
    const root = new URL("../src/" + layer + "/", import.meta.url);
    for (const path of readdirSync(root, {recursive: true}).filter(path => /\.tsx?$/.test(path))) {
      const source = readFileSync(new URL(path, root), "utf8");
      assert.doesNotMatch(source, /["'](?:@get-bb\/|node:|electron|@tauri-apps\/|.*adapters\/)/, path);
    }
  }
});
