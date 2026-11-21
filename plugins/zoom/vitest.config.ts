import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const pluginRoot = fileURLToPath(new URL("./", import.meta.url));

export default defineConfig({
  resolve: {
    alias: [{ find: /^@\//, replacement: pluginRoot }],
  },
});
