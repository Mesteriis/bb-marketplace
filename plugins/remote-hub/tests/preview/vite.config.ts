// A browser preview of the host-free UI with made-up data, outside BB: `npx vite --config tests/preview/vite.config.ts`.
// Styles come from dist/app.css (run `npm run build` first); theme.css stands in for the variables BB provides.
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const pluginRoot = fileURLToPath(new URL("../../", import.meta.url));

export default defineConfig({
  root: fileURLToPath(new URL("./", import.meta.url)),
  server: { fs: { allow: [pluginRoot] } },
  resolve: {
    alias: [
      { find: "@get-bb/plugin-sdk/app", replacement: fileURLToPath(new URL("./sdk-stub.tsx", import.meta.url)) },
      { find: /^@\//, replacement: pluginRoot },
      { find: /^@novnc\/novnc\/core\//, replacement: pluginRoot + "vendor/novnc/core/" },
    ],
  },
});
