// The plugin's two HTTP routes, served under /api/v1/plugins/makosh-zoom/http:
// the OAuth redirect and the call page BB embeds in an iframe.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { DomainError } from "../../core/errors.ts";
import type { OAuth } from "../../core/oauth.ts";
import { CALL_PAGE_CSP, callPageHtml, resultPageHtml } from "./call-page.ts";

const HTML_HEADERS = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" };
/** Query values longer than this are not Zoom's. */
const QUERY_LIMIT = 4096;

export function registerHttpRoutes(bb: BbPluginApi, oauth: OAuth, onAccountChanged: () => void): void {
  bb.http.route("GET", "/oauth/callback", async (c) => {
    const query = (name: string) => c.req.query(name)?.slice(0, QUERY_LIMIT);
    try {
      await oauth.completeLogin({ code: query("code"), state: query("state"), error: query("error") });
      onAccountChanged();
      return new Response(resultPageHtml(true, "Аккаунт Zoom подключён"), { status: 200, headers: HTML_HEADERS });
    } catch (error) {
      const message = error instanceof DomainError ? error.message : "Не удалось подключить аккаунт Zoom";
      if (!(error instanceof DomainError)) bb.log.error("oauth callback failed: " + (error instanceof Error ? error.name : "unknown"));
      return new Response(resultPageHtml(false, message), { status: 400, headers: HTML_HEADERS });
    }
  });

  bb.http.route("GET", "/call", () => {
    return new Response(callPageHtml(), {
      status: 200,
      headers: { ...HTML_HEADERS, "content-security-policy": CALL_PAGE_CSP, "referrer-policy": "no-referrer" },
    });
  });
}
