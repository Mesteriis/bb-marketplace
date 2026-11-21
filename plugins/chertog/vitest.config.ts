import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

const pluginRoot = fileURLToPath(new URL("./", import.meta.url));

/** Tests that render into a DOM: everything under tests/ui, and adapter tests named `*.dom.test.tsx`. */
const domTests = ["tests/ui/**/*.test.{ts,tsx}", "tests/adapters/**/*.dom.test.tsx"];

// Two projects because the two halves need different environments: the UI
// renders in jsdom, everything else runs in node, where a stray use of
// `document` fails instead of passing by accident.
export default defineConfig({
  resolve: {
    alias: [{ find: /^@\//, replacement: pluginRoot }],
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "dom",
          environment: "jsdom",
          include: domTests,
          setupFiles: ["tests/ui/setup.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "node",
          environment: "node",
          exclude: [...configDefaults.exclude, ...domTests],
        },
      },
    ],
  },
});
