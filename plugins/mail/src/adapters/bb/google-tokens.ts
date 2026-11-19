// Access tokens for Google accounts. An account keeps a refresh token where
// a password would be; IMAP and SMTP sign in with a short-lived access token
// made from it here. Access tokens stay in memory. Nothing Google answers is
// kept or shown: a reply becomes a token, GrantRevokedError (sign in again)
// or TokenUnavailable (try later).
import { parseGoogleTokenReply, type GoogleTokenReply } from "../../core/google-oauth.ts";
import { GrantRevokedError } from "../../core/ports.ts";
import type { GoogleClient } from "./google-oauth-client.ts";
import { SafeImapError } from "./imapflow-gateway.ts";

export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

/** A token with less than this left is replaced before it is used. */
const REFRESH_MARGIN_MS = 5 * 60_000;
/** Grants remembered at once; the oldest goes first. */
const CACHE_MAX = 16;
const REQUEST_TIMEOUT_MS = 20_000;

export interface GoogleTokens {
  /** A valid access token for the grant. Throws GrantRevokedError or SafeImapError("TokenUnavailable"). */
  accessToken(refreshToken: string): Promise<string>;
  /** The code of a finished consent for a grant; never throws. */
  exchangeCode(input: { code: string; codeVerifier: string; redirectUri: string }): Promise<GoogleTokenReply>;
  /** Drops what is remembered for a grant. */
  forget(refreshToken: string): void;
}

export type GoogleTokensDeps = {
  /** Null when the plugin has no usable client: every request fails as unavailable. */
  client: GoogleClient | null;
  fetch: typeof fetch;
  /** Milliseconds, as Date.now(). */
  now: () => number;
};

const unavailable = () => new SafeImapError("TokenUnavailable");

export function createGoogleTokens(deps: GoogleTokensDeps): GoogleTokens {
  const cached = new Map<string, { accessToken: string; expiresAt: number }>();
  const running = new Map<string, Promise<string>>();

  function remember(refreshToken: string, accessToken: string, expiresInSeconds: number): void {
    cached.delete(refreshToken);
    cached.set(refreshToken, { accessToken, expiresAt: deps.now() + expiresInSeconds * 1000 });
    while (cached.size > CACHE_MAX) cached.delete(cached.keys().next().value as string);
  }

  /** One form POST to the token endpoint; a failure of any kind is "other". */
  async function post(fields: Record<string, string>): Promise<GoogleTokenReply> {
    if (deps.client === null) return { ok: false, reason: "other" };
    try {
      const response = await deps.fetch(GOOGLE_TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ ...fields, client_id: deps.client.id, client_secret: deps.client.secret }).toString(),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const body: unknown = await response.json().catch(() => null);
      return parseGoogleTokenReply(response.status, body);
    } catch {
      return { ok: false, reason: "other" };
    }
  }

  async function refresh(refreshToken: string): Promise<string> {
    const reply = await post({ grant_type: "refresh_token", refresh_token: refreshToken });
    if (reply.ok) {
      remember(refreshToken, reply.accessToken, reply.expiresInSeconds);
      return reply.accessToken;
    }
    cached.delete(refreshToken);
    throw reply.reason === "invalid_grant" ? new GrantRevokedError() : unavailable();
  }

  return {
    accessToken(refreshToken) {
      const known = cached.get(refreshToken);
      if (known !== undefined && known.expiresAt - deps.now() >= REFRESH_MARGIN_MS) {
        return Promise.resolve(known.accessToken);
      }
      let pending = running.get(refreshToken);
      if (pending === undefined) {
        pending = refresh(refreshToken).finally(() => running.delete(refreshToken));
        running.set(refreshToken, pending);
      }
      return pending;
    },

    async exchangeCode({ code, codeVerifier, redirectUri }) {
      const reply = await post({
        grant_type: "authorization_code",
        code,
        code_verifier: codeVerifier,
        redirect_uri: redirectUri,
      });
      if (reply.ok && reply.refreshToken !== null) remember(reply.refreshToken, reply.accessToken, reply.expiresInSeconds);
      return reply;
    },

    forget(refreshToken) {
      cached.delete(refreshToken);
    },
  };
}
