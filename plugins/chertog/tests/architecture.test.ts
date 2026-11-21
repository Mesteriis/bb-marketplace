// Keeps the host-agnostic layers free of host code, so a move from BB to
// another host replaces adapters instead of the plugin.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** What the scanner reports for an import whose target is not a string literal. */
const NON_LITERAL = "<non-literal>";

/**
 * Every module specifier a source file imports, in source order. Reads the
 * TypeScript syntax tree, so comments, line breaks and quoting style between
 * the keyword and the specifier cannot hide an import, and import-like text
 * inside comments and strings is not counted.
 */
function importSpecifiers(source: string): string[] {
  const file = ts.createSourceFile("module.tsx", source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TSX);
  const found: string[] = [];
  const literal = (node: ts.Node | undefined): string =>
    node !== undefined && ts.isStringLiteralLike(node) ? node.text : NON_LITERAL;

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      found.push(literal(node.moduleSpecifier));
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) {
      found.push(literal(node.moduleSpecifier));
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      found.push(literal(node.moduleReference.expression));
    } else if (ts.isImportTypeNode(node)) {
      found.push(ts.isLiteralTypeNode(node.argument) ? literal(node.argument.literal) : NON_LITERAL);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    ) {
      found.push(literal(node.arguments[0]));
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
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

  it("finds specifiers behind comments, line breaks and template literals", () => {
    const source = [
      'const a = import(/* lazy */ "node:fs");',
      'const b = import(',
      '  // lazy',
      '  "node:path"',
      ');',
      'import { c } from /* host */ "electron";',
      'import /* side effect */ "@get-bb/plugin-sdk";',
      'const d = require(/* cjs */ "tauri");',
      'const e = import(`node:os`);',
      'export { f } from\n"@tauri-apps/api";',
    ].join("\n");
    expect(importSpecifiers(source)).toEqual([
      "node:fs",
      "node:path",
      "electron",
      "@get-bb/plugin-sdk",
      "tauri",
      "node:os",
      "@tauri-apps/api",
    ]);
  });

  it("finds import-equals and type-only import() specifiers", () => {
    const source = ['import fs = require("node:fs");', 'type Api = import("@get-bb/plugin-sdk").BbPluginApi;'].join("\n");
    expect(importSpecifiers(source)).toEqual(["node:fs", "@get-bb/plugin-sdk"]);
  });

  it("reports an import whose target is computed, so it cannot pass as allowed", () => {
    const source = ['const name = "node:" + "fs";', "const a = import(name);", "const b = require(name);"].join("\n");
    expect(importSpecifiers(source)).toEqual(["<non-literal>", "<non-literal>"]);
    expect(isAllowed(core, resolve(pluginRoot, "src/core/model.ts"), "<non-literal>")).toBe(false);
    expect(isAllowed(ui, resolve(pluginRoot, "src/ui/page.tsx"), "<non-literal>")).toBe(false);
  });

  it("ignores import-like text inside comments and strings", () => {
    const source = [
      '// import { a } from "node:fs";',
      '/* const b = require("electron"); */',
      'const c = "import(\'node:path\')";',
      'const url = "https://example.test/x"; // trailing',
    ].join("\n");
    expect(importSpecifiers(source)).toEqual([]);
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
