// Google sign-in for an installed app, as data: the consent page's address
// and what Google's answers mean. No network and no secrets here; adapters
// send the requests (google-tokens.ts, google-sign-in.ts). Texts of Google's
// replies are never kept: a reply becomes a grant or a fixed reason.

/** What Mail asks for: who signed in, and IMAP/SMTP access to their mail. */
export const GOOGLE_MAIL_SCOPES = ["openid", "email", "https://mail.google.com/"] as const;

const AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";

export type GoogleAuthorizationInput = {
  clientId: string;
  /** The loopback address the browser comes back to. */
  redirectUri: string;
  scopes: readonly string[];
  state: string;
  /** PKCE S256 challenge of the flow's verifier. */
  codeChallenge: string;
  /** The address to preselect; null when any account may sign in. */
  loginHint: string | null;
};

/** The consent page for one sign-in: an offline grant, always confirmed, on top of earlier grants. */
export function googleAuthorizationUrl(input: GoogleAuthorizationInput): string {
  const url = new URL(AUTHORIZATION_ENDPOINT);
  const params: [string, string][] = [
    ["client_id", input.clientId],
    ["redirect_uri", input.redirectUri],
    ["response_type", "code"],
    ["scope", input.scopes.join(" ")],
    ["state", input.state],
    ["code_challenge", input.codeChallenge],
    ["code_challenge_method", "S256"],
    ["access_type", "offline"],
    // Without it Google may answer a repeated sign-in with no refresh token.
    ["prompt", "consent"],
    ["include_granted_scopes", "true"],
  ];
  if (input.loginHint !== null) params.push(["login_hint", input.loginHint]);
  for (const [name, value] of params) url.searchParams.set(name, value);
  return url.toString();
}

export type GoogleTokenReply =
  | {
      ok: true;
      accessToken: string;
      expiresInSeconds: number;
      /** Present after a sign-in, absent after a refresh. */
      refreshToken: string | null;
      scopes: string[];
      idToken: string | null;
    }
  /** invalid_grant: the grant is gone for good. other: anything else, worth another try. */
  | { ok: false; reason: "invalid_grant" | "other" };

const text = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);

/** The token endpoint's answer as a grant or a fixed reason. */
export function parseGoogleTokenReply(status: number, body: unknown): GoogleTokenReply {
  const fields = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  if (status !== 200) return { ok: false, reason: fields.error === "invalid_grant" ? "invalid_grant" : "other" };
  const accessToken = text(fields.access_token);
  const expiresIn = fields.expires_in;
  if (accessToken === null || typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    return { ok: false, reason: "other" };
  }
  return {
    ok: true,
    accessToken,
    expiresInSeconds: expiresIn,
    refreshToken: text(fields.refresh_token),
    scopes: (text(fields.scope) ?? "").split(" ").filter((scope) => scope !== ""),
    idToken: text(fields.id_token),
  };
}

/**
 * Who an ID token is for. Only the payload is read: the token came straight
 * from Google's token endpoint over TLS, so its signature adds nothing here.
 */
export function googleIdentity(idToken: string): { subject: string; email: string } | null {
  const parts = idToken.split(".");
  if (parts.length !== 3) return null;
  let payload: unknown;
  try {
    const base64 = parts[1]!.replace(/-/g, "+").replace(/_/g, "/");
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    payload = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
  if (typeof payload !== "object" || payload === null) return null;
  const { sub, email, email_verified: verified } = payload as Record<string, unknown>;
  if (text(sub) === null || text(email) === null || verified !== true) return null;
  return { subject: sub as string, email: (email as string).trim().toLowerCase() };
}

/** True when two addresses name the same mailbox. */
export function sameMailbox(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}
