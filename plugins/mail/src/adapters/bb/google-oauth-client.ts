// The Google desktop client that ships with the plugin: the JSON file Google
// Cloud gives for an "installed" client, committed as it is. For this client
// type Google does not treat the secret as confidential; it gives nobody
// access to a mailbox. The values never go to a log, an RPC answer or the
// page. To use your own client, replace google-oauth-client.json.
import shipped from "../../../google-oauth-client.json" with { type: "json" };

export type GoogleClient = { id: string; secret: string };

const LOOPBACK = /^http:\/\/(localhost|127\.0\.0\.1)(:[0-9]{1,5})?\/?$/;

/** The client of a Google Cloud "installed" document; null for anything else. */
export function parseGoogleClient(document: unknown): GoogleClient | null {
  if (typeof document !== "object" || document === null) return null;
  const installed = (document as { installed?: unknown }).installed;
  if (typeof installed !== "object" || installed === null) return null;
  const { client_id: id, client_secret: secret, redirect_uris: redirects } = installed as Record<string, unknown>;
  if (typeof id !== "string" || id === "" || typeof secret !== "string" || secret === "") return null;
  if (!Array.isArray(redirects) || redirects.length === 0) return null;
  if (!redirects.every((uri) => typeof uri === "string" && LOOPBACK.test(uri))) return null;
  return { id, secret };
}

let parsed: GoogleClient | null | undefined;

/** The shipped client, read once; null when the file is not a usable desktop client. */
export function googleClient(): GoogleClient | null {
  if (parsed === undefined) parsed = parseGoogleClient(shipped);
  return parsed;
}
