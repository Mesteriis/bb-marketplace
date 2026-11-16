import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const alias = { "@": fileURLToPath(new URL("./", import.meta.url)) };

// Two projects because the two halves need different environments: the panel
// renders in jsdom, the engine shells out to git and touches the filesystem.
export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: "app",
          environment: "jsdom",
          include: ["components/**/*.test.tsx"],
        },
      },
      {
        resolve: { alias },
        test: {
          name: "server",
          environment: "node",
          include: ["tests/**/*.test.ts"],
        },
      },
    ],
  },
});
