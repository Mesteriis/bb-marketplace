// Resolves the `@/` alias (tsconfig paths, which `bb plugin build` also reads)
// so tests can render components that import the vendored design system.
import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

const pluginRoot = fileURLToPath(new URL("./", import.meta.url));

// Files whose tests are CPU-heavy: 100 001-entry plans, 1 MiB view replies, the full app in jsdom.
// Each such test costs at most about 0.6–0.7 s of CPU alone (measured 2026-11-28), but with eight
// agent threads on the machine (load average 40–80) wall time grew 5–10× past the 5 s default.
// They run one file at a time with a 30 s limit: ×50 headroom over their CPU cost. A project is
// per file, so the light tests in these files share the limit; every other file keeps 5 s.
const heavy = [
  "src/core/planner.test.ts",
  "src/core/preview.test.ts",
  "tests/file-read.test.ts",
  "app.test.tsx",
  // The archive flow renders the whole App in jsdom as well: about 0.2 s alone, but under the same
  // load its findBy waits (1 s each) ran out. Running it one file at a time removes that contention.
  "app-archive.test.tsx",
];

// research/upstream holds donor sources (git-ignored); their tests are not ours.
const exclude = [...configDefaults.exclude, "research/**"];

export default defineConfig({
  resolve: {
    alias: [{ find: /^@\//, replacement: pluginRoot }],
  },
  test: {
    projects: [
      {
        extends: true,
        test: { name: "unit", exclude: [...exclude, ...heavy] },
      },
      {
        extends: true,
        test: { name: "heavy", include: heavy, exclude, testTimeout: 30_000, fileParallelism: false },
      },
    ],
  },
});
