// Entry point: reads the environment, opens the store, listens.
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { createApp } from "./src/app.mjs";
import { OpenStore } from "./src/tracking.mjs";

const env = process.env;
const need = (name) => {
  const value = env[name];
  if (value === undefined || value.length < 32) {
    console.error(`${name} must be set to a secret of at least 32 characters`);
    process.exit(1);
  }
  return value;
};
const trackKey = need("MAKOSH_TRACK_KEY");
const apiKey = need("MAKOSH_API_KEY");
if (trackKey === apiKey) {
  console.error("MAKOSH_TRACK_KEY and MAKOSH_API_KEY must be different secrets");
  process.exit(1);
}
const origin = env.MAKOSH_ORIGIN ?? "";
if (!/^https:\/\/[a-z0-9.-]+(:\d{1,5})?$/.test(origin)) {
  console.error("MAKOSH_ORIGIN must be set to the site's https address, for example https://makosh.example.org");
  process.exit(1);
}
const store = new OpenStore(env.MAKOSH_DATA_FILE ?? "/data/opens.jsonl", (line) => console.error(line));
try {
  store.checkWritable();
} catch (error) {
  console.error(`the data file cannot be written (${error instanceof Error && "code" in error ? error.code : "error"})`);
  process.exit(1);
}
store.prune(new Date());
setInterval(() => store.prune(new Date()), 6 * 3_600_000).unref();

const catalog = JSON.parse(readFileSync(fileURLToPath(new URL("./catalog.json", import.meta.url)), "utf8"));
const app = createApp({
  trackKey,
  apiKey,
  store,
  catalog,
  site: {
    origin,
    contact: env.MAKOSH_CONTACT_EMAIL || undefined,
    googleVerification: env.MAKOSH_GOOGLE_SITE_VERIFICATION || undefined,
    googleVerificationFile: env.MAKOSH_GOOGLE_VERIFICATION_FILE || undefined,
  },
});
const server = createServer(app);
server.requestTimeout = 10_000;
server.headersTimeout = 5_000;
server.maxHeadersCount = 50;
const port = Number(env.PORT ?? "8080");
server.listen(port, "0.0.0.0", () => console.log(`makosh-site listening on ${port}, ${store.size} opens kept`));
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => server.close(() => process.exit(0)));
