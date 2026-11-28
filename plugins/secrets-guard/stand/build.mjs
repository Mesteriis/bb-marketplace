// Builds the component stand into stand/dist.
//
//   npm run build            (the plugin's styles: dist/app.css)
//   node stand/build.mjs <path to the host's theme css>
//
// The host's stylesheet is the BB app's own index-*.css; it is copied, never committed.
import { copyFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const stand = dirname(fileURLToPath(import.meta.url));
const hostCss = process.argv[2];
const appCss = join(stand, "..", "dist", "app.css");
if (hostCss === undefined || !existsSync(hostCss)) throw new Error("pass the path to the host's theme css");
if (!existsSync(appCss)) throw new Error("run `npm run build` first: dist/app.css is missing");

const outDir = join(stand, "dist");
await build({
  root: stand,
  logLevel: "warn",
  build: { outDir, emptyOutDir: true },
  esbuild: { jsx: "automatic" },
});
copyFileSync(hostCss, join(outDir, "host.css"));
copyFileSync(appCss, join(outDir, "app.css"));
console.log(`stand built: ${outDir}`);
