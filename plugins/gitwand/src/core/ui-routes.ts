// BB plugin routes match exact paths, so the built UI is served by one GET
// route per file. These rules turn a file of the runtime's `ui/` directory
// into its route, refusing any name that could leave that directory or be
// read as something other than a plain path.

import { PLUGIN_HTTP_BASE } from "./frame-url.ts";

/** Where the UI is mounted; the build passes it to Vite as `base`. */
export const UI_BASE_PATH = `${PLUGIN_HTTP_BASE}/ui`;

const SEGMENT = /^[^/\\\u0000?#]+$/;

/** `/ui/<file>` for a `/`-separated path relative to `ui/`, or null if unsafe. */
export function uiRouteFor(file: string): string | null {
  const segments = file.split("/");
  const safe = segments.every((s) => SEGMENT.test(s) && s !== "." && s !== ".." && !s.includes(":"));
  return safe ? `/ui/${file}` : null;
}

const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  svg: "image/svg+xml",
  wasm: "application/wasm",
  json: "application/json",
  png: "image/png",
  woff2: "font/woff2",
};

/** Content type by extension; unknown files are served as bytes. */
export function contentTypeFor(file: string): string {
  const name = file.split("/").at(-1) ?? "";
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  return TYPES[ext] ?? "application/octet-stream";
}
