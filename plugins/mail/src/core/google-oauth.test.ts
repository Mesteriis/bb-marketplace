import { describe, expect, it } from "vitest";
import {
  GOOGLE_MAIL_SCOPES,
  googleAuthorizationUrl,
  googleIdentity,
  parseGoogleTokenReply,
  sameMailbox,
} from "./google-oauth.ts";

/** A JWT-shaped string with this payload; the signature is never read. */
function idToken(payload: unknown): string {
  const part = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${part({ alg: "RS256" })}.${part(payload)}.signature`;
}

describe("googleAuthorizationUrl", () => {
  const input = {
    clientId: "invented-client-id",
    redirectUri: "http://127.0.0.1:8123",
    scopes: GOOGLE_MAIL_SCOPES,
    state: "invented-state",
    codeChallenge: "invented-challenge",
    loginHint: "owner@example.org",
  };

  it("asks Google for an offline grant with PKCE", () => {
    const url = new URL(googleAuthorizationUrl(input));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: "invented-client-id",
      redirect_uri: "http://127.0.0.1:8123",
      response_type: "code",
      scope: "openid email https://mail.google.com/",
      state: "invented-state",
      code_challenge: "invented-challenge",
      code_challenge_method: "S256",
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
      login_hint: "owner@example.org",
    });
  });

  it("leaves the hint out when the address is not known", () => {
    const url = new URL(googleAuthorizationUrl({ ...input, loginHint: null }));
    expect(url.searchParams.has("login_hint")).toBe(false);
  });
});

describe("parseGoogleTokenReply", () => {
  it("reads a grant", () => {
    expect(
      parseGoogleTokenReply(200, {
        access_token: "a",
        expires_in: 3599,
        refresh_token: "r",
        scope: "openid email https://mail.google.com/",
        id_token: "x.y.z",
      }),
    ).toEqual({
      ok: true,
      accessToken: "a",
      expiresInSeconds: 3599,
      refreshToken: "r",
      scopes: ["openid", "email", "https://mail.google.com/"],
      idToken: "x.y.z",
    });
  });

  it("reads a refresh, which has no refresh token, scope or identity", () => {
    expect(parseGoogleTokenReply(200, { access_token: "a", expires_in: 60 })).toEqual({
      ok: true,
      accessToken: "a",
      expiresInSeconds: 60,
      refreshToken: null,
      scopes: [],
      idToken: null,
    });
  });

  it("tells a revoked grant from every other failure", () => {
    expect(parseGoogleTokenReply(400, { error: "invalid_grant" })).toEqual({ ok: false, reason: "invalid_grant" });
    expect(parseGoogleTokenReply(400, { error: "invalid_client" })).toEqual({ ok: false, reason: "other" });
    expect(parseGoogleTokenReply(500, "oops")).toEqual({ ok: false, reason: "other" });
    expect(parseGoogleTokenReply(200, {})).toEqual({ ok: false, reason: "other" });
    expect(parseGoogleTokenReply(200, { access_token: "a", expires_in: -1 })).toEqual({ ok: false, reason: "other" });
    expect(parseGoogleTokenReply(200, { access_token: "", expires_in: 60 })).toEqual({ ok: false, reason: "other" });
    expect(parseGoogleTokenReply(200, null)).toEqual({ ok: false, reason: "other" });
  });
});

describe("googleIdentity", () => {
  it("reads the verified address in lower case", () => {
    expect(googleIdentity(idToken({ sub: "123", email: "Owner@Example.org", email_verified: true }))).toEqual({
      subject: "123",
      email: "owner@example.org",
    });
  });

  it("is null without a verified address or a readable payload", () => {
    expect(googleIdentity(idToken({ sub: "123", email: "owner@example.org", email_verified: false }))).toBeNull();
    expect(googleIdentity(idToken({ sub: "123" }))).toBeNull();
    expect(googleIdentity(idToken({ email: "owner@example.org", email_verified: true }))).toBeNull();
    expect(googleIdentity("only.two")).toBeNull();
    expect(googleIdentity("a.%%%.c")).toBeNull();
    expect(googleIdentity(`a.${btoa("not json")}.c`)).toBeNull();
  });
});

describe("sameMailbox", () => {
  it("ignores case and outer spaces", () => {
    expect(sameMailbox(" Owner@Example.org", "owner@example.org")).toBe(true);
    expect(sameMailbox("owner@example.org", "other@example.org")).toBe(false);
  });
});
