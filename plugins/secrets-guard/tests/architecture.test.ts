// Keeps the host-agnostic layers free of host code, so a move from BB to
// another host (Tauri is the planned one) replaces adapters instead of the
// plugin. docs/architecture.md at the repository root states the rule.
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
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)
      ? [path]
      : [];
  });
}

function isInside(directory: string, path: string): boolean {
  return path === directory || path.startsWith(directory + sep);
}

interface Layer {
  /** Directory of the layer, relative to the plugin root. */
  directory: string;
  /** Bare specifiers and alias prefixes the layer may import. */
  packages: string[];
  /** Directories a relative import may resolve into. */
  reachable: string[];
}

function violations(layer: Layer): string[] {
  const reachable = layer.reachable.map((dir) => resolve(pluginRoot, dir));
  return sourceFiles(resolve(pluginRoot, layer.directory)).flatMap((file) =>
    importSpecifiers(readFileSync(file, "utf8"))
      .filter((specifier) => {
        if (specifier.startsWith(".")) {
          const target = resolve(dirname(file), specifier);
          return !reachable.some((dir) => isInside(dir, target));
        }
        return !layer.packages.some(
          (allowed) => specifier === allowed || specifier.startsWith(allowed + "/"),
        );
      })
      .map((specifier) => `${relative(pluginRoot, file)} imports "${specifier}"`),
  );
}

const core: Layer = {
  directory: "src/core",
  packages: ["zod"],
  reachable: ["src/core"],
};

const ui: Layer = {
  directory: "src/ui",
  packages: ["react", "lucide-react", "@radix-ui/react-popover"],
  reachable: ["src/ui", "src/core"],
};

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

    expect(importSpecifiers(source)).toEqual([
      "pkg-a",
      "./b.ts",
      "pkg-c",
      "pkg-d",
      "pkg-e",
      "pkg-f",
    ]);
  });
});

describe("host-agnostic layers", () => {
  it.each([core, ui])("$directory has source files to check", (layer) => {
    expect(sourceFiles(resolve(pluginRoot, layer.directory)).length).toBeGreaterThan(0);
  });

  it("src/core imports only zod and itself", () => {
    expect(violations(core)).toEqual([]);
  });

  it("src/ui imports only React, the icon and popover libraries and the core", () => {
    expect(violations(ui)).toEqual([]);
  });
});
