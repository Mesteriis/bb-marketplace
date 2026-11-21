import { describe, expect, it } from "vitest";
import { DomainError } from "./errors.ts";
import { createOAuth } from "./oauth.ts";
import {
  FakeClock,
  MemoryPendingLogins,
  MemoryTokenStore,
  credentials,
  fixedRandom,
  scriptedFetch,
  type Reply,
} from "./testing/fakes.ts";

const REDIRECT = "http://127.0.0.1:38886/api/v1/plugins/makosh-zoom/http/oauth/callback";
const NOW = 1_700_000_000_000;
// RFC 7636 appendix B.
const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

function setup(options: { replies?: Reply[]; tokens?: MemoryTokenStore; configured?: boolean; publicClientId?: string } = {}) {
  const http = scriptedFetch(...(options.replies ?? []));
  const clock = new FakeClock(NOW);
  const tokens = options.tokens ?? new MemoryTokenStore();
  const pending = new MemoryPendingLogins();
  const oauth = createOAuth({
    clock,
    tokens,
    pending,
    fetch: http.fetch,
    random: fixedRandom("state-1", VERIFIER),
    credentials: credentials(
      options.configured === false ? null : { clientId: "cid", clientSecret: "secret", publicClientId: options.publicClientId ?? null },
    ),
  });
  return { oauth, http, clock, tokens, pending };
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DomainError) return error.code;
    throw error;
  }
  throw new Error("expected a DomainError");
}

const tokenReply = (access: string, refresh: string) => ({
  status: 200,
  body: { access_token: access, refresh_token: refresh, expires_in: 3600, token_type: "bearer" },
});

describe("beginLogin", () => {
  it("builds the consent link with a PKCE S256 challenge", async () => {
    const { oauth, pending } = setup();
    const { authorizeUrl } = await oauth.beginLogin(REDIRECT);
    expect(authorizeUrl).toBe(
      "https://zoom.us/oauth/authorize?response_type=code&client_id=cid" +
        "&redirect_uri=http%3A%2F%2F127.0.0.1%3A38886%2Fapi%2Fv1%2Fplugins%2Fmakosh-zoom%2Fhttp%2Foauth%2Fcallback" +
        `&state=state-1&code_challenge=${CHALLENGE}&code_challenge_method=S256`,
    );
    expect(pending.logins.get("state-1")).toEqual({
      state: "state-1",
      verifier: VERIFIER,
      redirectUri: REDIRECT,
      createdAt: NOW,
    });
  });

  it("refuses when the Zoom app is not configured", async () => {
    const { oauth } = setup({ configured: false });
    expect(await codeOf(oauth.beginLogin(REDIRECT))).toBe("not_configured");
  });
});

describe("completeLogin", () => {
  it("exchanges the code and stores the tokens", async () => {
    const { oauth, http, tokens } = setup({ replies: [tokenReply("access-1", "refresh-1")] });
    await oauth.beginLogin(REDIRECT);
    await oauth.completeLogin({ code: "the-code", state: "state-1" });

    expect(http.calls).toHaveLength(1);
    expect(http.calls[0]!.url).toBe("https://zoom.us/oauth/token");
    expect(http.calls[0]!.request).toEqual({
      method: "POST",
      headers: {
        authorization: "Basic Y2lkOnNlY3JldA==",
        "content-type": "application/x-www-form-urlencoded",
      },
      body:
        "grant_type=authorization_code&code=the-code" +
        "&redirect_uri=http%3A%2F%2F127.0.0.1%3A38886%2Fapi%2Fv1%2Fplugins%2Fmakosh-zoom%2Fhttp%2Foauth%2Fcallback" +
        `&code_verifier=${VERIFIER}`,
    });
    expect(tokens.tokens).toEqual({ accessToken: "access-1", refreshToken: "refresh-1", expiresAt: NOW + 3_600_000 });
  });

  it("rejects an unknown state without calling Zoom", async () => {
    const { oauth, http } = setup();
    await oauth.beginLogin(REDIRECT);
    expect(await codeOf(oauth.completeLogin({ code: "c", state: "other" }))).toBe("auth_state");
    expect(http.calls).toHaveLength(0);
  });

  it("accepts a state only once", async () => {
    const { oauth } = setup({ replies: [tokenReply("a", "r")] });
    await oauth.beginLogin(REDIRECT);
    await oauth.completeLogin({ code: "c", state: "state-1" });
    expect(await codeOf(oauth.completeLogin({ code: "c", state: "state-1" }))).toBe("auth_state");
  });

  it("accepts a sign-in at 15 minutes and rejects it one millisecond later", async () => {
    const onTime = setup({ replies: [tokenReply("a", "r")] });
    await onTime.oauth.beginLogin(REDIRECT);
    onTime.clock.time = NOW + 900_000;
    await onTime.oauth.completeLogin({ code: "c", state: "state-1" });
    expect(onTime.tokens.tokens?.accessToken).toBe("a");

    const late = setup();
    await late.oauth.beginLogin(REDIRECT);
    late.clock.time = NOW + 900_001;
    expect(await codeOf(late.oauth.completeLogin({ code: "c", state: "state-1" }))).toBe("auth_state");
    expect(late.http.calls).toHaveLength(0);
  });

  it("reports a refusal on the consent screen", async () => {
    const { oauth, http } = setup();
    await oauth.beginLogin(REDIRECT);
    expect(await codeOf(oauth.completeLogin({ error: "access_denied", state: "state-1" }))).toBe("auth_denied");
    expect(http.calls).toHaveLength(0);
  });

  it("does not put Zoom's reply or the code into the error", async () => {
    const { oauth } = setup({ replies: [{ status: 400, body: { reason: "Invalid authorization code the-code", error: "invalid_grant" } }] });
    await oauth.beginLogin(REDIRECT);
    const error = await oauth.completeLogin({ code: "the-code", state: "state-1" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe("auth_denied");
    expect((error as DomainError).message).not.toContain("the-code");
  });
});

describe("accessToken", () => {
  const stored = (expiresAt: number) =>
    new MemoryTokenStore({ accessToken: "access-old", refreshToken: "refresh-old", expiresAt });

  it("refuses when no account is connected", async () => {
    const { oauth } = setup();
    expect(await codeOf(oauth.accessToken())).toBe("not_connected");
  });

  it("returns a token that has more than a minute left", async () => {
    const { oauth, http } = setup({ tokens: stored(NOW + 60_001) });
    expect(await oauth.accessToken()).toBe("access-old");
    expect(http.calls).toHaveLength(0);
  });

  it("refreshes a token with a minute or less left and stores the new refresh token", async () => {
    const tokens = stored(NOW + 60_000);
    const { oauth, http } = setup({ tokens, replies: [tokenReply("access-new", "refresh-new")] });
    expect(await oauth.accessToken()).toBe("access-new");
    expect(http.calls[0]!.request.body).toBe("grant_type=refresh_token&refresh_token=refresh-old");
    expect(http.calls[0]!.request.headers.authorization).toBe("Basic Y2lkOnNlY3JldA==");
    expect(tokens.tokens).toEqual({ accessToken: "access-new", refreshToken: "refresh-new", expiresAt: NOW + 3_600_000 });
  });

  it("sends one refresh for callers that arrive together", async () => {
    let release!: (value: { status: number; body: unknown }) => void;
    const slow = new Promise<{ status: number; body: unknown }>((resolve) => (release = resolve));
    const { oauth, http } = setup({ tokens: stored(NOW), replies: [slow] });
    const both = Promise.all([oauth.accessToken(), oauth.accessToken()]);
    release(tokenReply("access-new", "refresh-new"));
    expect(await both).toEqual(["access-new", "access-new"]);
    expect(http.calls).toHaveLength(1);
  });

  it("forgets the account when Zoom rejects the refresh token", async () => {
    const tokens = stored(NOW);
    const { oauth } = setup({ tokens, replies: [{ status: 400, body: { error: "invalid_grant" } }] });
    expect(await codeOf(oauth.accessToken())).toBe("auth_expired");
    expect(tokens.tokens).toBeNull();
  });

  it("keeps the account when the network fails during a refresh", async () => {
    const tokens = stored(NOW);
    const { oauth } = setup({ tokens, replies: [new Error("ECONNRESET")] });
    expect(await codeOf(oauth.accessToken())).toBe("network");
    expect(tokens.tokens?.refreshToken).toBe("refresh-old");
  });

  it("keeps the account when Zoom is failing", async () => {
    const tokens = stored(NOW);
    const { oauth } = setup({ tokens, replies: [{ status: 503, body: "unavailable" }] });
    expect(await codeOf(oauth.accessToken())).toBe("zoom_error");
    expect(tokens.tokens?.refreshToken).toBe("refresh-old");
  });

  it("refreshes on demand even when the token looks fresh", async () => {
    const { oauth } = setup({ tokens: stored(NOW + 3_000_000), replies: [tokenReply("access-new", "refresh-new")] });
    expect(await oauth.accessToken({ force: true })).toBe("access-new");
  });
});

describe("disconnect", () => {
  it("revokes the token and forgets the account", async () => {
    const tokens = new MemoryTokenStore({ accessToken: "access-old", refreshToken: "r", expiresAt: NOW + 1 });
    const { oauth, http } = setup({ tokens, replies: [{ status: 200, body: { status: "success" } }] });
    await oauth.disconnect();
    expect(http.calls[0]!.url).toBe("https://zoom.us/oauth/revoke");
    expect(http.calls[0]!.request.body).toBe("token=access-old");
    expect(tokens.tokens).toBeNull();
  });

  it("forgets the account even when revoking fails", async () => {
    const tokens = new MemoryTokenStore({ accessToken: "a", refreshToken: "r", expiresAt: NOW + 1 });
    const { oauth } = setup({ tokens, replies: [new Error("offline")] });
    await oauth.disconnect();
    expect(tokens.tokens).toBeNull();
  });
});

describe("public client (PKCE without a secret)", () => {
  const PUBLIC = { publicClientId: "pub" };
  const FORM_ONLY = { "content-type": "application/x-www-form-urlencoded" };

  it("asks for consent with the public client ID", async () => {
    const { oauth } = setup(PUBLIC);
    const { authorizeUrl } = await oauth.beginLogin(REDIRECT);
    expect(new URL(authorizeUrl).searchParams.get("client_id")).toBe("pub");
    expect(new URL(authorizeUrl).searchParams.get("code_challenge")).toBe(CHALLENGE);
  });

  it("exchanges the code with client_id in the body and no Authorization header", async () => {
    const { oauth, http } = setup({ ...PUBLIC, replies: [tokenReply("access-1", "refresh-1")] });
    await oauth.beginLogin(REDIRECT);
    await oauth.completeLogin({ code: "the-code", state: "state-1" });
    expect(http.calls[0]!.request).toEqual({
      method: "POST",
      headers: FORM_ONLY,
      body:
        "grant_type=authorization_code&code=the-code" +
        "&redirect_uri=http%3A%2F%2F127.0.0.1%3A38886%2Fapi%2Fv1%2Fplugins%2Fmakosh-zoom%2Fhttp%2Foauth%2Fcallback" +
        `&code_verifier=${VERIFIER}&client_id=pub`,
    });
  });

  it("refreshes with client_id in the body and no Authorization header", async () => {
    const tokens = new MemoryTokenStore({ accessToken: "access-old", refreshToken: "refresh-old", expiresAt: NOW });
    const { oauth, http } = setup({ ...PUBLIC, tokens, replies: [tokenReply("access-new", "refresh-new")] });
    expect(await oauth.accessToken()).toBe("access-new");
    expect(http.calls[0]!.request).toEqual({
      method: "POST",
      headers: FORM_ONLY,
      body: "grant_type=refresh_token&refresh_token=refresh-old&client_id=pub",
    });
  });

  it("revokes with client_id in the body and no Authorization header", async () => {
    const tokens = new MemoryTokenStore({ accessToken: "access-old", refreshToken: "r", expiresAt: NOW + 1 });
    const { oauth, http } = setup({ ...PUBLIC, tokens, replies: [{ status: 200, body: { status: "success" } }] });
    await oauth.disconnect();
    expect(http.calls[0]!.request).toEqual({ method: "POST", headers: FORM_ONLY, body: "token=access-old&client_id=pub" });
  });
});
