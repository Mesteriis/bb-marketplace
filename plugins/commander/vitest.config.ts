// Resolves the `@/` alias (tsconfig paths, which `bb plugin build` also reads)
// so tests can render components that import the vendored design system.
import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

const pluginRoot = fileURLToPath(new URL("./", import.meta.url));

export default defineConfig({
  resolve: {
    alias: [{ find: /^@\//, replacement: pluginRoot }],
  },
  // research/upstream holds donor sources (git-ignored); their tests are not ours.
  test: {
    exclude: [...configDefaults.exclude, "research/**"],
  },
});
