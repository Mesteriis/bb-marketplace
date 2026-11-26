// Serves the GitWand UI of the current runtime: one GET route per built file
// (BB routes match exact paths). Files are read from the current runtime at
// request time, so a route of a file the runtime no longer has answers 404.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { PLUGIN_HTTP_BASE } from "../../core/frame-url.ts";
import { contentTypeFor, uiRouteFor } from "../../core/ui-routes.ts";

export const SHIM_PATH = `${PLUGIN_HTTP_BASE}/gw/shim.js`;
export const EMBED_CSS_PATH = `${PLUGIN_HTTP_BASE}/gw/embed.css`;

/**
 * Styles for GitWand inside a BB tab. GitWand centres its dock over the whole
 * window; in a window narrower than its desktop layout (a thread tab is
 * 480-900 px) the dock covers the commit panel's Stage all and Commit
 * buttons. The panel gets room for the dock, the same clearance GitWand gives
 * its PR view (`--app-dock-height` plus the dock's offsets).
 */
export const EMBED_CSS = `@media (max-width: 1200px) {
  .commit-panel { padding-bottom: calc(var(--app-dock-height, 44px) + 2 * var(--space-4, 12px)) !important; }
}
`;

/** The UI may only be framed by BB pages on loopback, and talks only to its own origin. */
const UI_CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self' ws://127.0.0.1:* ws://localhost:*",
  "worker-src 'self' blob:",
  "frame-ancestors http://127.0.0.1:* http://localhost:*",
].join("; ");

function page(status: number, text: string): Response {
  return new Response(`<!doctype html><meta charset="utf-8"><title>GitWand</title><p style="font:14px system-ui;padding:16px">${text}</p>`, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

/** One file of the UI; `uiDir` null means no runtime is installed. */
export async function serveUiFile(uiDir: string | null, file: string): Promise<Response> {
  if (uiDir === null) return page(503, "The GitWand runtime is not installed. Open the plugin settings in BB.");
  let body: Buffer;
  try {
    body = await readFile(join(uiDir, ...file.split("/")));
  } catch {
    return new Response("Not found", { status: 404 });
  }
  const headers: Record<string, string> = { "content-type": contentTypeFor(file), "x-content-type-options": "nosniff" };
  if (file === "index.html") {
    const html = body.toString("utf8").replace("<head>", `<head>\n    <script src="${SHIM_PATH}"></script>\n    <link rel="stylesheet" href="${EMBED_CSS_PATH}">`);
    return new Response(html, { headers: { ...headers, "content-security-policy": UI_CSP, "cache-control": "no-store" } });
  }
  return new Response(new Uint8Array(body), { headers: { ...headers, "cache-control": "no-cache" } });
}

/** Registers routes for the files of a runtime; new files of a later runtime get routes too. */
export class UiRoutes {
  private readonly registered = new Set<string>();

  constructor(
    private readonly register: (route: string, handler: () => Promise<Response>) => void,
    private readonly uiDir: () => Promise<string | null>,
  ) {}

  get count(): number {
    return this.registered.size;
  }

  /** Registers what is new; a route the host refuses is reported and tried again next time. */
  ensure(files: string[]): { added: number; failed: string[] } {
    let added = 0;
    const failed: string[] = [];
    for (const file of files) {
      const route = uiRouteFor(file);
      if (route === null || this.registered.has(route)) continue;
      try {
        this.register(route, async () => serveUiFile(await this.uiDir(), file));
      } catch {
        failed.push(file);
        continue;
      }
      this.registered.add(route);
      added++;
    }
    return { added, failed };
  }
}
