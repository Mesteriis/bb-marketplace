// The request handler: four pages, two static files, the read-status
// image and the events feed for the owner's own app.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { homePage, mailPage, privacyPage, termsPage } from "./pages.mjs";
import { PAGE_MAX, clientKind, sameSecret, validToken } from "./tracking.mjs";

/** A transparent 1×1 GIF. */
export const PIXEL = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

const PUBLIC = fileURLToPath(new URL("../public/", import.meta.url));
const STATIC = {
  "/site.css": { type: "text/css; charset=utf-8", body: readFileSync(`${PUBLIC}site.css`) },
  "/favicon.svg": { type: "image/svg+xml", body: readFileSync(`${PUBLIC}favicon.svg`) },
  "/robots.txt": { type: "text/plain; charset=utf-8", body: Buffer.from("User-agent: *\nDisallow: /o/\nDisallow: /api/\n") },
};
const SECURITY = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'none'; style-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "Strict-Transport-Security": "max-age=31536000",
};

/**
 * @param {{ trackKey: string, apiKey: string, store: import("./tracking.mjs").OpenStore, catalog: { plugins: object[] },
 *   site: { origin: string, contact?: string, googleVerification?: string, googleVerificationFile?: string }, now?: () => Date }} deps
 */
export function createApp(deps) {
  const now = deps.now ?? (() => new Date());
  const pages = {
    "/": homePage(deps.site, deps.catalog),
    "/mail": mailPage(deps.site),
    "/privacy": privacyPage(deps.site),
    "/terms": termsPage(deps.site),
  };
  const verificationFile = /^google[0-9a-f]{16}\.html$/.test(deps.site.googleVerificationFile ?? "") ? deps.site.googleVerificationFile : null;

  return function handle(request, response) {
    const send = (status, headers, body) => {
      response.writeHead(status, { ...SECURITY, "Content-Length": Buffer.byteLength(body), ...headers });
      response.end(request.method === "HEAD" ? undefined : body);
    };
    const text = (status, body) => send(status, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" }, body);
    let url;
    try {
      url = new URL(request.url ?? "/", "http://site.invalid");
    } catch {
      return text(400, "Bad request\n");
    }
    // Node reads "\\" in a path as "/"; the proxy in front does not, so such a path is not served.
    if ((request.url ?? "").includes("\\")) return text(404, "Not found\n");
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.setHeader("Allow", "GET, HEAD");
      return text(405, "Method not allowed\n");
    }
    const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : url.pathname;

    if (path === "/healthz") return text(200, "ok\n");

    // The read-status image. The same image answers every request, so the
    // answer says nothing about whether a token is known.
    const open = /^\/o\/([^/]{1,80})\.gif$/.exec(path);
    if (open !== null) {
      const token = validToken(deps.trackKey, open[1]);
      if (token !== null && request.method === "GET") deps.store.record(token, clientKind(request.headers["user-agent"]), now());
      return send(200, { "Content-Type": "image/gif", "Cache-Control": "no-store, private, max-age=0", "Cross-Origin-Resource-Policy": "cross-origin" }, PIXEL);
    }

    if (path === "/api/events") {
      const given = /^Bearer (.+)$/.exec(String(request.headers.authorization ?? ""))?.[1];
      if (given === undefined || !sameSecret(given, deps.apiKey)) {
        return send(401, { "Content-Type": "application/json", "Cache-Control": "no-store", "WWW-Authenticate": "Bearer" }, '{"error":"unauthorized"}\n');
      }
      const after = Number(url.searchParams.get("after") ?? "0");
      const limit = Number(url.searchParams.get("limit") ?? String(PAGE_MAX));
      if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1) {
        return send(400, { "Content-Type": "application/json", "Cache-Control": "no-store" }, '{"error":"bad_request"}\n');
      }
      return send(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }, `${JSON.stringify(deps.store.after(after, limit))}\n`);
    }

    if (verificationFile !== null && path === `/${verificationFile}`) {
      return send(200, { "Content-Type": "text/html; charset=utf-8" }, `google-site-verification: ${verificationFile}`);
    }
    const file = STATIC[path];
    if (file !== undefined) return send(200, { "Content-Type": file.type, "Cache-Control": "public, max-age=3600" }, file.body);
    const page = pages[path];
    if (page !== undefined) return send(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=300" }, page);
    return text(404, "Not found\n");
  };
}
