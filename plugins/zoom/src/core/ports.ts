// Ports: what the core needs from its host. Each host supplies adapters.

export interface Clock {
  /** Milliseconds since the epoch. */
  now(): number;
}

/** The owner's Zoom app (General app, user-managed). Null until the ID and secret are set. */
export interface AppCredentials {
  /** Signs the Meeting SDK JWT together with the secret. */
  readonly clientId: string;
  readonly clientSecret: string;
  /**
   * The app's Public client ID ("Use public client OAuth"). When set, sign-in
   * runs as a PKCE public client: Zoom allows a loopback redirect
   * (http://127.0.0.1) only for those. Null signs in with the ID and secret.
   */
  readonly publicClientId: string | null;
}

export interface AppCredentialsSource {
  get(): Promise<AppCredentials | null>;
}

export interface StoredTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  /** Milliseconds since the epoch. */
  readonly expiresAt: number;
}

/** Keeps the account's tokens at rest. The adapter encrypts them. */
export interface TokenStore {
  load(): Promise<StoredTokens | null>;
  save(tokens: StoredTokens): Promise<void>;
  clear(): Promise<void>;
}

/** A sign-in the user started and has not finished yet. */
export interface PendingLogin {
  readonly state: string;
  readonly verifier: string;
  readonly redirectUri: string;
  readonly createdAt: number;
}

export interface PendingLoginStore {
  put(login: PendingLogin): Promise<void>;
  /** Returns the login and forgets it, so a state works once. */
  take(state: string): Promise<PendingLogin | null>;
}

export interface HttpRequest {
  readonly method: "GET" | "POST";
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
}

export interface HttpResponse {
  readonly status: number;
  text(): Promise<string>;
}

/** The subset of `fetch` the core uses; it rejects when the network fails. */
export type HttpFetch = (url: string, request: HttpRequest) => Promise<HttpResponse>;

export interface Random {
  /** URL-safe random text carrying `bytes` bytes of entropy. */
  token(bytes: number): string;
}
