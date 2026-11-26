// Writes gitwand-bridge's dispatch.rs for an upstream GitWand checkout.
//   node scripts/gen-bridge-dispatch.ts <apps/desktop/src-tauri> <out dispatch.rs>
// Prints {"handlers":N,"generated":N,"adapted":N}; exits 1 on any surprise.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { ADAPTED, generateDispatch, indexCommands, parseHandlerList, type SourceFile } from "./lib/dispatch-gen.ts";

export function generateFor(srcTauri: string): { code: string; handlers: number; generated: number } {
  const src = join(srcTauri, "src");
  const files: SourceFile[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (relative(src, path) !== "bridge") walk(path);
      } else if (entry.name.endsWith(".rs")) {
        files.push({ path: relative(src, path).split("\\").join("/"), text: readFileSync(path, "utf8") });
      }
    }
  };
  walk(src);
  const handlers = parseHandlerList(readFileSync(join(src, "lib.rs"), "utf8"));
  const { code, generated } = generateDispatch(handlers, indexCommands(files), ADAPTED);
  return { code, handlers: handlers.length, generated: generated.length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [srcTauri, out] = process.argv.slice(2);
  if (!srcTauri || !out) {
    console.error("usage: node scripts/gen-bridge-dispatch.ts <apps/desktop/src-tauri> <out dispatch.rs>");
    process.exit(2);
  }
  try {
    const r = generateFor(srcTauri);
    writeFileSync(out, r.code);
    console.log(JSON.stringify({ handlers: r.handlers, generated: r.generated, adapted: ADAPTED.length }));
  } catch (error) {
    console.error(`gen-bridge-dispatch: ${(error as Error).message}`);
    process.exit(1);
  }
}
