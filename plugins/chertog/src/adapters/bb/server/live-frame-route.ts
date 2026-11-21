// The HTTP route of the controlled frame page. `bb plugin build` copies no
// assets and the SDK has no static asset address, so the server reads
// assets/fixtures/live-frame.html from the package directory and returns it
// from one route of its own. The route takes no path from the request: it
// answers one fixed address with one fixed file.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PluginHttp, PluginLogger } from "@get-bb/plugin-sdk";
import { LIVE_FRAME_ROUTE } from "../../../core/wire/index.ts";

/**
 * The page runs its own inline style and script and loads or sends nothing:
 * every other source, `connect-src` included, falls back to 'none'. Only BB
 * may frame it: the origin that serves it, or the other loopback name of the
 * same server.
 */
const LIVE_FRAME_CSP = [
  "default-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'self' http://127.0.0.1:* http://localhost:*",
  "style-src 'unsafe-inline'",
  "script-src 'unsafe-inline'",
].join("; ");

const PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy": LIVE_FRAME_CSP,
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

/**
 * The page as text, or `null` when the package has none. `entryUrl` is the
 * `import.meta.url` of the server entry: server.ts in a checkout, or
 * dist/server.js after `bb plugin build`, one directory below the package.
 */
export function readLiveFrameFixture(entryUrl: string): string | null {
  const entryDirectory = dirname(fileURLToPath(entryUrl));
  for (const packageDirectory of [entryDirectory, dirname(entryDirectory)]) {
    const path = join(packageDirectory, "assets", "fixtures", "live-frame.html");
    if (existsSync(path)) return readFileSync(path, "utf8");
  }
  return null;
}

/**
 * Mounts the page at `LIVE_FRAME_ROUTE` with the host's default check, which
 * accepts requests of a local BB origin only. Without the page the route
 * answers 404.
 */
export function registerLiveFrameRoute(host: { http: Pick<PluginHttp, "route">; log: Pick<PluginLogger, "warn"> }, html: string | null): void {
  if (html === null) host.log.warn("live frame: assets/fixtures/live-frame.html was not found; the route answers 404");
  host.http.route("GET", LIVE_FRAME_ROUTE, () => {
    if (html === null) {
      return new Response("The live frame fixture is not part of this installation", {
        status: 404,
        headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
      });
    }
    return new Response(html, { status: 200, headers: PAGE_HEADERS });
  });
}
