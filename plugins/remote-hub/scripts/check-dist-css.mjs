// Build gate: dist/app.css must carry the plugin's own .rh-* rules. They reach
// it only through `import "./app.css"` in app.tsx; without the import the build
// still succeeds and BB shows the page unstyled.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = readFileSync(join(root, "dist", "app.css"), "utf8");
const required = [".rh-page", ".rh-form", ".rh-root", ".rh-tokens", ".rh-editor", ".rh-credentials", ".rh-saved", ".rh-rdp-main", ".rh-rdp-canvas", ".rh-rdp-cert", ".rh-agent-overlay", ".rh-agent-dots"];
const missing = [...required, "@container"].filter((selector) => !dist.includes(selector));
if (missing.length > 0) {
  console.error(`dist/app.css is missing ${missing.join(", ")}: is app.css imported by app.tsx?`);
  process.exit(1);
}
console.log(`dist/app.css carries ${required.length} required .rh-* selectors`);
