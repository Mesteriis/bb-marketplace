import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

const pluginRoot = fileURLToPath(new URL("./", import.meta.url));

/** Adapter tests that render into a DOM are named `*.dom.test.tsx`. */
const domAdapterTests = "tests/adapters/**/*.dom.test.tsx";

/**
 * Tests that render into a DOM: every test file Vitest discovers under
 * tests/ui (the default `.test`/`.spec` names, so none of them can fall
 * through to node), and the DOM adapter tests.
 */
const domTests = [...configDefaults.include.map((pattern) => `tests/ui/${pattern}`), domAdapterTests];

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
          exclude: [...configDefaults.exclude, "tests/ui/**", domAdapterTests],
        },
      },
    ],
  },
});
