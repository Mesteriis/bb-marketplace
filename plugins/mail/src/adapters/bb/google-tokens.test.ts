import { describe, expect, it } from "vitest";
import { GrantRevokedError } from "../../core/ports.ts";
import { GOOGLE_TOKEN_URL, createGoogleTokens } from "./google-tokens.ts";

const client = { id: "invented-client-id", secret: "invented-client-secret" };

type Call = { url: string; body: Record<string, string> };

/** A token endpoint that answers from a queue and records what it was sent. */
function endpoint(replies: (Response | Error | (() => Promise<Response>))[]) {
  const calls: Call[] = [];
  const fetch = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), body: Object.fromEntries(new URLSearchParams(String(init?.body))) });
    const reply = replies.shift();
    if (reply === undefined) throw new Error("no reply scripted");
    if (reply instanceof Error) throw reply;
    return typeof reply === "function" ? reply() : reply;
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const granted = (accessToken: string, expiresIn = 3599) =>
  new Response(JSON.stringify({ access_token: accessToken, expires_in: expiresIn }), { status: 200 });

describe("createGoogleTokens", () => {
  it("asks once, reuses the token, and refreshes when under five minutes are left", async () => {
    let now = 1_000_000;
    const { fetch, calls } = endpoint([granted("a1"), granted("a2")]);
    const tokens = createGoogleTokens({ client, fetch, now: () => now });

    expect(await tokens.accessToken("invented-refresh")).toBe("a1");
    expect(calls).toEqual([
      {
        url: "https://oauth2.googleapis.com/token",
        body: {
          grant_type: "refresh_token",
          refresh_token: "invented-refresh",
          client_id: "invented-client-id",
          client_secret: "invented-client-secret",
        },
      },
    ]);
    expect(GOOGLE_TOKEN_URL).toBe("https://oauth2.googleapis.com/token");

    now += 3294_000; // 305 s left
    expect(await tokens.accessToken("invented-refresh")).toBe("a1");
    expect(calls).toHaveLength(1);

    now += 6_000; // 299 s left
    expect(await tokens.accessToken("invented-refresh")).toBe("a2");
    expect(calls).toHaveLength(2);
  });

  it("runs one refresh for callers that ask together, and keeps grants apart", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const { fetch, calls } = endpoint([() => held.then(() => granted("a1")), granted("b1")]);
    const tokens = createGoogleTokens({ client, fetch, now: () => 0 });

    const both = Promise.all([tokens.accessToken("r1"), tokens.accessToken("r1")]);
    release();
    expect(await both).toEqual(["a1", "a1"]);
    expect(await tokens.accessToken("r2")).toBe("b1");
    expect(calls.map((call) => call.body.refresh_token)).toEqual(["r1", "r2"]);
  });

  it("a revoked grant is a GrantRevokedError and is asked again next time", async () => {
    const { fetch, calls } = endpoint([
      new Response(JSON.stringify({ error: "invalid_grant", error_description: "Token has been expired or revoked." }), { status: 400 }),
      granted("a1"),
    ]);
    const tokens = createGoogleTokens({ client, fetch, now: () => 0 });

    const failure = await tokens.accessToken("invented-refresh").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(GrantRevokedError);
    expect(String((failure as Error).message)).not.toContain("invented");
    expect(await tokens.accessToken("invented-refresh")).toBe("a1");
    expect(calls).toHaveLength(2);
  });

  it("anything else is TokenUnavailable, with nothing of the request in the message", async () => {
    const { fetch } = endpoint([
      new Error("getaddrinfo ENOTFOUND oauth2.googleapis.com invented-refresh invented-client-secret"),
      new Response("upstream invented-client-secret", { status: 503 }),
      new Response("not json", { status: 200 }),
    ]);
    const tokens = createGoogleTokens({ client, fetch, now: () => 0 });

    for (let i = 0; i < 3; i++) {
      const failure = (await tokens.accessToken("invented-refresh").catch((error: unknown) => error)) as Error & { code?: string };
      expect(failure).not.toBeInstanceOf(GrantRevokedError);
      expect(failure.code).toBe("TokenUnavailable");
      expect(failure.message).toBe("IMAP error (TokenUnavailable)");
    }
  });

  it("without a client nothing is asked", async () => {
    const { fetch, calls } = endpoint([]);
    const tokens = createGoogleTokens({ client: null, fetch, now: () => 0 });
    const failure = (await tokens.accessToken("invented-refresh").catch((error: unknown) => error)) as { code?: string };
    expect(failure.code).toBe("TokenUnavailable");
    expect(calls).toEqual([]);
  });

  it("forget drops a cached token", async () => {
    const { fetch, calls } = endpoint([granted("a1"), granted("a2")]);
    const tokens = createGoogleTokens({ client, fetch, now: () => 0 });
    await tokens.accessToken("r1");
    tokens.forget("r1");
    expect(await tokens.accessToken("r1")).toBe("a2");
    expect(calls).toHaveLength(2);
  });

  it("keeps at most 16 grants in memory", async () => {
    const { fetch, calls } = endpoint(Array.from({ length: 18 }, (_, i) => granted(`a${i}`)));
    const tokens = createGoogleTokens({ client, fetch, now: () => 0 });
    for (let i = 0; i < 17; i++) await tokens.accessToken(`r${i}`);
    await tokens.accessToken("r16"); // still cached
    expect(calls).toHaveLength(17);
    await tokens.accessToken("r0"); // the oldest was dropped
    expect(calls).toHaveLength(18);
  });

  it("exchanges a code with the flow's verifier and redirect", async () => {
    const { fetch, calls } = endpoint([
      new Response(JSON.stringify({ access_token: "a1", expires_in: 3599, refresh_token: "r1", scope: "openid email", id_token: "x.y.z" }), { status: 200 }),
      new Error("offline"),
    ]);
    const tokens = createGoogleTokens({ client, fetch, now: () => 0 });

    expect(await tokens.exchangeCode({ code: "c1", codeVerifier: "v1", redirectUri: "http://127.0.0.1:8123" })).toEqual({
      ok: true,
      accessToken: "a1",
      expiresInSeconds: 3599,
      refreshToken: "r1",
      scopes: ["openid", "email"],
      idToken: "x.y.z",
    });
    expect(calls[0]!.body).toEqual({
      grant_type: "authorization_code",
      code: "c1",
      code_verifier: "v1",
      redirect_uri: "http://127.0.0.1:8123",
      client_id: "invented-client-id",
      client_secret: "invented-client-secret",
    });
    // The sign-in's own token is cached, so the first connection asks nothing.
    expect(await tokens.accessToken("r1")).toBe("a1");
    expect(calls).toHaveLength(1);
    expect(await tokens.exchangeCode({ code: "c2", codeVerifier: "v2", redirectUri: "http://127.0.0.1:8123" })).toEqual({ ok: false, reason: "other" });
  });
});
