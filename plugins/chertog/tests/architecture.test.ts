// Keeps the host-agnostic layers free of host code, so a move from BB to
// another host replaces adapters instead of the plugin.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const IMPORT_SPECIFIER =
  /\bfrom\s+["']([^"']+)["']|\bimport\s+["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)|\brequire\(\s*["']([^"']+)["']\s*\)/g;

function importSpecifiers(source: string): string[] {
  return [...source.matchAll(IMPORT_SPECIFIER)].map(
    (match) => match[1] ?? match[2] ?? match[3] ?? match[4] ?? "",
  );
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

function isInside(directory: string, path: string): boolean {
  return path === directory || path.startsWith(directory + sep);
}

interface Layer {
  directory: string;
  packages: string[];
  reachable: string[];
}

/** Whether a file of the layer may import the specifier. */
function isAllowed(layer: Layer, file: string, specifier: string): boolean {
  if (specifier.startsWith(".")) {
    const target = resolve(dirname(file), specifier);
    return layer.reachable.some((dir) => isInside(resolve(pluginRoot, dir), target));
  }
  return layer.packages.some((allowed) => specifier === allowed || specifier.startsWith(allowed + "/"));
}

function violations(layer: Layer): string[] {
  return sourceFiles(resolve(pluginRoot, layer.directory)).flatMap((file) =>
    importSpecifiers(readFileSync(file, "utf8"))
      .filter((specifier) => !isAllowed(layer, file, specifier))
      .map((specifier) => relative(pluginRoot, file) + " imports \"" + specifier + "\""),
  );
}

const core: Layer = { directory: "src/core", packages: ["zod"], reachable: ["src/core"] };

const ui: Layer = {
  directory: "src/ui",
  packages: ["react", "@/components", "@/lib", "@/hooks"],
  reachable: ["src/ui", "src/core"],
};

const HOST_SPECIFIERS = [
  "@get-bb/plugin-sdk",
  "@get-bb/plugin-sdk/app",
  "node:fs",
  "node:path",
  "electron",
  "@tauri-apps/api",
  "@tauri-apps/api/core",
  "tauri",
];

describe("import scanner", () => {
  it("finds static, side-effect, dynamic, and require specifiers", () => {
    const source = [
      'import { a } from "pkg-a";',
      "import type { B } from './b.ts';",
      'export * from "pkg-c";',
      'import "pkg-d";',
      'const e = await import("pkg-e");',
      'const f = require("pkg-f");',
    ].join("\n");
    expect(importSpecifiers(source)).toEqual(["pkg-a", "./b.ts", "pkg-c", "pkg-d", "pkg-e", "pkg-f"]);
  });
});

describe("layer rule", () => {
  const coreFile = resolve(pluginRoot, "src/core/model.ts");
  const uiFile = resolve(pluginRoot, "src/ui/page.tsx");

  it.each(HOST_SPECIFIERS)("refuses %s in src/core and src/ui", (specifier) => {
    expect(isAllowed(core, coreFile, specifier)).toBe(false);
    expect(isAllowed(ui, uiFile, specifier)).toBe(false);
  });

  it("refuses packages that only share a prefix with an allowed one", () => {
    expect(isAllowed(core, coreFile, "zod-to-json-schema")).toBe(false);
    expect(isAllowed(ui, uiFile, "react-dom")).toBe(false);
  });

  it("lets the core import zod and itself, and nothing above it", () => {
    expect(isAllowed(core, coreFile, "zod")).toBe(true);
    expect(isAllowed(core, coreFile, "./ports.ts")).toBe(true);
    expect(isAllowed(core, coreFile, "../ui/page.tsx")).toBe(false);
    expect(isAllowed(core, coreFile, "../adapters/bb/index.ts")).toBe(false);
    expect(isAllowed(core, coreFile, "../../server.ts")).toBe(false);
  });

  it("lets the UI import React, the core and the design system, and not the adapters", () => {
    expect(isAllowed(ui, uiFile, "react")).toBe(true);
    expect(isAllowed(ui, uiFile, "react/jsx-runtime")).toBe(true);
    expect(isAllowed(ui, uiFile, "@/components/ui/button")).toBe(true);
    expect(isAllowed(ui, uiFile, "../core/index.ts")).toBe(true);
    expect(isAllowed(ui, uiFile, "./tile.tsx")).toBe(true);
    expect(isAllowed(ui, uiFile, "../adapters/bb/index.ts")).toBe(false);
    expect(isAllowed(ui, uiFile, "../../app.tsx")).toBe(false);
  });
});

describe("host-agnostic layers", () => {
  it.each([core, ui])("$directory has source files to check", (layer) => {
    expect(sourceFiles(resolve(pluginRoot, layer.directory)).length).toBeGreaterThan(0);
  });

  it("src/core imports only zod and itself", () => {
    expect(violations(core)).toEqual([]);
  });

  it("src/ui imports only React, the core, and the vendored design system", () => {
    expect(violations(ui)).toEqual([]);
  });
});
