// Bundles demo/main.tsx (the real src/ui) into demo/demo.js with esbuild.
import { build } from "esbuild";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

await build({
  entryPoints: [resolve(root, "demo/main.tsx")],
  bundle: true,
  format: "iife",
  outfile: resolve(root, "demo/demo.js"),
  jsx: "automatic",
  minify: false,
  sourcemap: false,
  define: { "process.env.NODE_ENV": "\"production\"" },
  plugins: [
    {
      name: "demo-alias",
      setup(buildContext) {
        buildContext.onResolve({ filter: /^@\// }, async (args) => {
          const result = await buildContext.resolve("./" + args.path.slice(2), {
            resolveDir: root,
            kind: "import-statement",
          });
          return { path: result.path, external: false };
        });
        buildContext.onResolve({ filter: /^@get-bb\/plugin-sdk\/app$/ }, () => ({
          path: resolve(root, "demo/host-stub.tsx"),
        }));
      },
    },
  ],
});

console.log("built demo/demo.js");
