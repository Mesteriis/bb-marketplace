// Zoom OAuth for one account: authorization code with PKCE (S256), token
// exchange, refresh and revocation. Tokens, codes and the client secret
// travel in request bodies and headers only, never in URLs, errors or logs.
import { DomainError } from "./errors.ts";
import type {
  AppCredentials,
  AppCredentialsSource,
  Clock,
  HttpFetch,
  HttpResponse,
  PendingLoginStore,
  Random,
  StoredTokens,
  TokenStore,
} from "./ports.ts";

const AUTHORIZE_URL = "https://zoom.us/oauth/authorize";
const TOKEN_URL = "https://zoom.us/oauth/token";
const REVOKE_URL = "https://zoom.us/oauth/revoke";
/** A consent started on the page must come back within this time. */
const LOGIN_TTL_MS = 15 * 60_000;
/** Refresh an access token when this little of its life is left. */
const REFRESH_SKEW_MS = 60_000;

export interface OAuthDeps {
  readonly clock: Clock;
  readonly tokens: TokenStore;
  readonly pending: PendingLoginStore;
  readonly fetch: HttpFetch;
  readonly random: Random;
  readonly credentials: AppCredentialsSource;
}

export interface LoginCallback {
  readonly code?: string;
  readonly state?: string;
  /** Zoom's `error` query parameter when the user refused. */
  readonly error?: string;
}

export interface OAuth {
  beginLogin(redirectUri: string): Promise<{ authorizeUrl: string }>;
  completeLogin(callback: LoginCallback): Promise<void>;
  /** A usable access token; `force` refreshes even when the stored one looks fresh. */
  accessToken(options?: { force?: boolean }): Promise<string>;
  isConnected(): Promise<boolean>;
  disconnect(): Promise<void>;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

function form(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}

function parseTokens(text: string, now: number): StoredTokens | null {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof body !== "object" || body === null) return null;
  const { access_token, refresh_token, expires_in } = body as Record<string, unknown>;
  if (typeof access_token !== "string" || typeof refresh_token !== "string" || typeof expires_in !== "number") {
    return null;
  }
  return { accessToken: access_token, refreshToken: refresh_token, expiresAt: now + expires_in * 1000 };
}

export function createOAuth(deps: OAuthDeps): OAuth {
  let refreshing: Promise<string> | null = null;

  async function requireCredentials(): Promise<AppCredentials> {
    const value = await deps.credentials.get();
    if (value === null) {
      throw new DomainError("not_configured", "Укажите Client ID и Client Secret приложения Zoom в настройках плагина");
    }
    return value;
  }

  async function post(url: string, app: AppCredentials, body: string): Promise<HttpResponse> {
    try {
      return await deps.fetch(url, {
        method: "POST",
        headers: {
          authorization: `Basic ${btoa(`${app.clientId}:${app.clientSecret}`)}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body,
      });
    } catch {
      throw new DomainError("network", "Нет связи с Zoom");
    }
  }

  async function refresh(current: StoredTokens): Promise<string> {
    const app = await requireCredentials();
    const response = await post(TOKEN_URL, app, form({ grant_type: "refresh_token", refresh_token: current.refreshToken }));
    if (response.status === 400 || response.status === 401) {
      await deps.tokens.clear();
      throw new DomainError("auth_expired", "Вход в Zoom истёк. Подключите аккаунт заново");
    }
    const next = response.status === 200 ? parseTokens(await response.text(), deps.clock.now()) : null;
    if (next === null) throw new DomainError("zoom_error", `Zoom не обновил вход (HTTP ${response.status})`);
    // Zoom replaces the refresh token on every refresh: keep the new one before anyone uses the access token.
    await deps.tokens.save(next);
    return next.accessToken;
  }

  return {
    async beginLogin(redirectUri) {
      const app = await requireCredentials();
      const state = deps.random.token(32);
      const verifier = deps.random.token(48);
      await deps.pending.put({ state, verifier, redirectUri, createdAt: deps.clock.now() });
      const query = form({
        response_type: "code",
        client_id: app.clientId,
        redirect_uri: redirectUri,
        state,
        code_challenge: await pkceChallenge(verifier),
        code_challenge_method: "S256",
      });
      return { authorizeUrl: `${AUTHORIZE_URL}?${query}` };
    },

    async completeLogin(callback) {
      const login = callback.state === undefined ? null : await deps.pending.take(callback.state);
      if (login === null || deps.clock.now() - login.createdAt > LOGIN_TTL_MS) {
        throw new DomainError("auth_state", "Этот вход устарел или начат не здесь. Начните подключение заново");
      }
      if (callback.error !== undefined || callback.code === undefined) {
        throw new DomainError("auth_denied", "Zoom не дал доступ: вход отменён");
      }
      const app = await requireCredentials();
      const response = await post(
        TOKEN_URL,
        app,
        form({
          grant_type: "authorization_code",
          code: callback.code,
          redirect_uri: login.redirectUri,
          code_verifier: login.verifier,
        }),
      );
      const tokens = response.status === 200 ? parseTokens(await response.text(), deps.clock.now()) : null;
      if (tokens === null) {
        throw new DomainError("auth_denied", `Zoom не принял вход (HTTP ${response.status})`);
      }
      await deps.tokens.save(tokens);
    },

    async accessToken(options = {}) {
      if (refreshing !== null) return refreshing;
      const current = await deps.tokens.load();
      if (current === null) throw new DomainError("not_connected", "Аккаунт Zoom не подключён");
      if (options.force !== true && current.expiresAt - deps.clock.now() > REFRESH_SKEW_MS) return current.accessToken;
      if (refreshing === null) {
        refreshing = refresh(current).finally(() => {
          refreshing = null;
        });
      }
      return refreshing;
    },

    async isConnected() {
      return (await deps.tokens.load()) !== null;
    },

    async disconnect() {
      const current = await deps.tokens.load();
      if (current === null) return;
      try {
        const app = await requireCredentials();
        await post(REVOKE_URL, app, form({ token: current.accessToken }));
      } catch {
        // Revoking is best effort: the local copy is removed either way.
      }
      await deps.tokens.clear();
    },
  };
}
