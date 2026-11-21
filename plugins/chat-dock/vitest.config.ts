import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environmentOptions: {
      // The fixture's two conversations live on the origin the plugin allows.
      jsdom: { url: "https://chatgpt.com/c/aaaaaaaa-0000-4000-8000-00000000000a" },
    },
  },
});
