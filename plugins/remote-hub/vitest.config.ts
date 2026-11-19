// Resolves the `@/` alias (tsconfig paths, which `bb plugin build` also reads).
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const pluginRoot = fileURLToPath(new URL("./", import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@\//, replacement: pluginRoot },
      // noVNC 1.6.0 is vendored unmodified (vendor/novnc, see its README): the same files ship and run in the tests.
      { find: /^@novnc\/novnc\/core\//, replacement: pluginRoot + "vendor/novnc/core/" },
    ],
  },
});
