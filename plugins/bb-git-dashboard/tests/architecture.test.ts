import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const forbidden = /^(?:node:|@get-bb\/|electron|@tauri-apps\/)/;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : /\.(?:ts|tsx)$/.test(name) ? [path] : [];
  });
}

export function specifiers(source: string) {
  return [...source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["']([^"']+)["']/g)].map(match => match[1]);
}

function violations(layer: "core" | "ui") {
  const base = join(root, "src", layer);
  return files(base).flatMap(file => specifiers(readFileSync(file, "utf8")).flatMap(spec => {
    if (forbidden.test(spec)) return [relative(root, file) + " → " + spec];
    if (layer !== "core") return [];
    if (spec === "zod") return [];
    if (!spec.startsWith(".")) return [relative(root, file) + " → " + spec];
    const target = resolve(dirname(file), spec);
    return target.startsWith(base) ? [] : [relative(root, file) + " → " + spec];
  }));
}

test("import scanner sees static, side-effect and dynamic imports", () => {
  assert.deepEqual(specifiers('import a from "node:fs";\nimport "electron";\nconst b = await import("@get-bb/plugin-sdk");'),
    ["node:fs", "electron", "@get-bb/plugin-sdk"]);
});

test("core imports only zod and other core modules", () => {
  assert.deepEqual(violations("core"), []);
});

test("ui imports no host code", () => {
  assert.deepEqual(violations("ui"), []);
});
