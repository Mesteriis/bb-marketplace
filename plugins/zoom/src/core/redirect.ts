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
