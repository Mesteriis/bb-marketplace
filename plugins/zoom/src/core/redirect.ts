// The OAuth redirect address, built from the origin BB is open on. Zoom
// accepts https, or plain http on the 127.0.0.1 loopback only (any port).
import { DomainError } from "./errors.ts";

/** The plugin's OAuth callback route as the browser sees it. */
export const OAUTH_CALLBACK_PATH = "/api/v1/plugins/makosh-zoom/http/oauth/callback";

export function redirectUriFor(origin: string): string {
  let url: URL | null;
  try {
    url = new URL(origin.trim());
  } catch {
    url = null;
  }
  const allowed =
    url !== null &&
    url.username === "" &&
    url.password === "" &&
    (url.protocol === "https:" || (url.protocol === "http:" && url.hostname === "127.0.0.1"));
  if (url === null || !allowed) {
    throw new DomainError(
      "invalid_input",
      "Zoom принимает возврат только на https или на http://127.0.0.1. Откройте BB по такому адресу",
    );
  }
  return `${url.origin}${OAUTH_CALLBACK_PATH}`;
}

/** The call page route as the browser sees it. */
export const CALL_PAGE_PATH = "/api/v1/plugins/makosh-zoom/http/call";

/**
 * Where to load the call page from, given the address BB is open on. Zoom's
 * SDK needs a real origin, and it must not be BB's own: the same server is
 * reached under the other loopback name, which the browser treats as a
 * different origin. Null when BB is not on a loopback address; the embedded
 * call is then unavailable and meetings open in the Zoom app.
 */
export function callPageUrlFor(origin: string): string | null {
  let url: URL;
  try {
    url = new URL(origin.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:") return null;
  const other = url.hostname === "127.0.0.1" ? "localhost" : url.hostname === "localhost" ? "127.0.0.1" : null;
  if (other === null) return null;
  return `http://${other}${url.port === "" ? "" : `:${url.port}`}${CALL_PAGE_PATH}`;
}
