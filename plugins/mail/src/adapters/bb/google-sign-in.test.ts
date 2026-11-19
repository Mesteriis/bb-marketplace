import { afterEach, describe, expect, it, vi } from "vitest";
import { ADDRESS_IS_ALIAS } from "../../core/accounts.ts";
import type { GoogleTokenReply } from "../../core/google-oauth.ts";
import type { Account } from "../../core/model.ts";
import { createGoogleSignIn, type GoogleSignIn, type GoogleSignInDeps } from "./google-sign-in.ts";

const client = { id: "invented-client-id", secret: "invented-client-secret" };

function idToken(email: string): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "RS256" })}.${part({ sub: "123", email, email_verified: true })}.signature`;
}

const granted = (email: string, refreshToken: string | null = "invented-refresh"): GoogleTokenReply => ({
  ok: true,
  accessToken: "a1",
  expiresInSeconds: 3599,
  refreshToken,
  scopes: ["openid", "email", "https://mail.google.com/"],
  idToken: idToken(email),
});

const open: GoogleSignIn[] = [];
afterEach(() => {
  for (const signIn of open.splice(0)) signIn.close();
});

function setup(overrides: Partial<GoogleSignInDeps> = {}, reply: GoogleTokenReply = granted("owner@example.org")) {
  const exchanged: { code: string; codeVerifier: string; redirectUri: string }[] = [];
  const tested: [string, string][] = [];
  const saved: { email: string; refreshToken: string; scopes: string[] }[] = [];
  const signIn = createGoogleSignIn({
    client,
    tokens: {
      accessToken: async () => "a1",
      exchangeCode: async (input) => (exchanged.push(input), reply),
      forget: () => undefined,
    },
    testSignIn: async (email, refreshToken) => (tested.push([email, refreshToken]), "ok"),
    save: async (input) => (saved.push(input), { id: "acc_1" } as Account),
    ...overrides,
  });
  open.push(signIn);
  return { signIn, exchanged, tested, saved };
}

/** What the browser does after consent: one GET to the redirect address. */
async function comeBack(url: string, params: Record<string, string>, path = "/") {
  const consent = new URL(url);
  const back = new URL(path, consent.searchParams.get("redirect_uri")!);
  for (const [name, value] of Object.entries(params)) back.searchParams.set(name, value);
  const response = await fetch(back);
  return { status: response.status, text: await response.text() };
}

const stateOf = (url: string) => new URL(url).searchParams.get("state")!;
const refusesConnections = async (url: string) =>
  fetch(new URL(url).searchParams.get("redirect_uri")!).then(
    () => false,
    () => true,
  );

describe("createGoogleSignIn", () => {
  it("turns a consent into a saved account and frees the port", async () => {
    const { signIn, exchanged, tested, saved } = setup();
    const { flowId, url } = await signIn.start({ email: "Owner@Example.org" });
    const consent = new URL(url);

    expect(consent.origin + consent.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(consent.searchParams.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:[0-9]{2,5}$/);
    expect(consent.searchParams.get("client_id")).toBe("invented-client-id");
    expect(consent.searchParams.get("scope")).toBe("openid email https://mail.google.com/");
    expect(consent.searchParams.get("login_hint")).toBe("Owner@Example.org");
    expect(stateOf(url).length).toBeGreaterThanOrEqual(32);
    expect(url).not.toContain("invented-client-secret");
    expect(signIn.status(flowId)).toEqual({ state: "pending" });

    const back = await comeBack(url, { state: stateOf(url), code: "c1" });

    expect(back.status).toBe(200);
    expect(back.text).toContain("You can close this tab");
    expect(back.text).not.toContain("c1");
    await vi.waitFor(() => expect(signIn.status(flowId)).toEqual({ state: "done", accountId: "acc_1" }));
    expect(exchanged).toHaveLength(1);
    expect(exchanged[0]).toMatchObject({ code: "c1", redirectUri: consent.searchParams.get("redirect_uri") });
    expect(exchanged[0]!.codeVerifier.length).toBeGreaterThanOrEqual(43);
    expect(tested).toEqual([["owner@example.org", "invented-refresh"]]);
    expect(saved).toEqual([
      { email: "owner@example.org", refreshToken: "invented-refresh", scopes: ["openid", "email", "https://mail.google.com/"] },
    ]);
    expect(await refusesConnections(url)).toBe(true);
  });

  it("the challenge sent to Google is the SHA-256 of the verifier sent with the code", async () => {
    const { createHash } = await import("node:crypto");
    const { signIn, exchanged } = setup();
    const { flowId, url } = await signIn.start({ email: null });
    expect(new URL(url).searchParams.has("login_hint")).toBe(false);
    await comeBack(url, { state: stateOf(url), code: "c1" });
    await vi.waitFor(() => expect(signIn.status(flowId).state).toBe("done"));
    expect(new URL(url).searchParams.get("code_challenge")).toBe(
      createHash("sha256").update(exchanged[0]!.codeVerifier).digest("base64url"),
    );
  });

  it("refuses another Google account than the one asked for, and saves nothing", async () => {
    const { signIn, saved, tested } = setup({}, granted("other@example.org"));
    const { flowId, url } = await signIn.start({ email: "owner@example.org" });
    await comeBack(url, { state: stateOf(url), code: "c1" });
    await vi.waitFor(() => expect(signIn.status(flowId)).toEqual({ state: "failed", reason: "mismatch" }));
    expect(saved).toEqual([]);
    expect(tested).toEqual([]);
  });

  it("a refused consent ends the flow as denied and frees the port", async () => {
    const { signIn, exchanged } = setup();
    const { flowId, url } = await signIn.start({ email: null });
    const back = await comeBack(url, { state: stateOf(url), error: "access_denied" });
    expect(back.status).toBe(200);
    expect(back.text).toContain("not completed");
    await vi.waitFor(() => expect(signIn.status(flowId)).toEqual({ state: "failed", reason: "denied" }));
    expect(exchanged).toEqual([]);
    await vi.waitFor(async () => expect(await refusesConnections(url)).toBe(true));
  });

  it("nobody coming back ends the flow as timeout and frees the port", async () => {
    const { signIn } = setup({ timeoutMs: 40 });
    const { flowId, url } = await signIn.start({ email: null });
    await vi.waitFor(() => expect(signIn.status(flowId)).toEqual({ state: "failed", reason: "timeout" }));
    expect(await refusesConnections(url)).toBe(true);
  });

  it("a wrong state, another path and a second request change nothing", async () => {
    const { signIn, exchanged } = setup();
    const { flowId, url } = await signIn.start({ email: null });

    expect((await comeBack(url, { state: "wrong", code: "c0" })).status).toBe(400);
    expect((await comeBack(url, { code: "c0" })).status).toBe(400);
    expect((await comeBack(url, { state: stateOf(url), code: "c0" }, "/other")).status).toBe(404);
    expect(signIn.status(flowId)).toEqual({ state: "pending" });
    expect(exchanged).toEqual([]);

    expect((await comeBack(url, { state: stateOf(url), code: "c1" })).status).toBe(200);
    const second = await comeBack(url, { state: stateOf(url), code: "c2" }).catch(() => ({ status: 0 }));
    expect([0, 400]).toContain(second.status);
    await vi.waitFor(() => expect(signIn.status(flowId).state).toBe("done"));
    expect(exchanged.map((call) => call.code)).toEqual(["c1"]);
  });

  const endings: [string, GoogleTokenReply, Partial<GoogleSignInDeps>, string][] = [
    ["no refresh token", granted("owner@example.org", null), {}, "no_refresh_token"],
    ["a failed exchange", { ok: false, reason: "other" }, {}, "error"],
    ["an unreadable identity", { ok: true, accessToken: "a1", expiresInSeconds: 3599, refreshToken: "invented-refresh", scopes: [], idToken: "x.y" }, {}, "error"],
    ["a refused mail sign-in", granted("owner@example.org"), { testSignIn: async (): Promise<"refused"> => "refused" }, "refused"],
    ["an unreachable mail server", granted("owner@example.org"), { testSignIn: async (): Promise<"unreachable"> => "unreachable" }, "unreachable"],
    ["an alias of another account", granted("owner@example.org"), { save: async () => { throw new Error(ADDRESS_IS_ALIAS); } }, "alias"],
    ["a failed save", granted("owner@example.org"), { save: async () => { throw new Error("database is locked"); } }, "error"],
  ];
  it.each(endings)("%s ends the flow with its own reason", async (_label, reply, overrides, reason) => {
    const { signIn } = setup(overrides, reply);
    const { flowId, url } = await signIn.start({ email: null });
    await comeBack(url, { state: stateOf(url), code: "c1" });
    await vi.waitFor(() => expect(signIn.status(flowId)).toEqual({ state: "failed", reason }));
  });

  it("keeps at most three sign-ins waiting: a fourth ends the oldest", async () => {
    const { signIn } = setup();
    const first = await signIn.start({ email: null });
    const second = await signIn.start({ email: null });
    await signIn.start({ email: null });
    const fourth = await signIn.start({ email: null });
    expect(signIn.status(first.flowId)).toEqual({ state: "failed", reason: "timeout" });
    expect(signIn.status(second.flowId)).toEqual({ state: "pending" });
    expect(signIn.status(fourth.flowId)).toEqual({ state: "pending" });
    expect(await refusesConnections(first.url)).toBe(true);
  });

  it("a sign-in the browser already came back for is not ended by newer ones or by close", async () => {
    let release!: (reply: GoogleTokenReply) => void;
    const held = new Promise<GoogleTokenReply>((resolve) => (release = resolve));
    const saved: string[] = [];
    const signIn = createGoogleSignIn({
      client,
      tokens: { accessToken: async () => "a1", exchangeCode: () => held, forget: () => undefined },
      testSignIn: async () => "ok",
      save: async (input) => (saved.push(input.email), { id: "acc_1" } as Account),
    });
    open.push(signIn);
    const first = await signIn.start({ email: null });
    await comeBack(first.url, { state: stateOf(first.url), code: "c1" });

    await signIn.start({ email: null });
    await signIn.start({ email: null });
    await signIn.start({ email: null });
    await signIn.start({ email: null });
    expect(signIn.status(first.flowId)).toEqual({ state: "pending" });

    release(granted("owner@example.org"));
    await vi.waitFor(() => expect(signIn.status(first.flowId)).toEqual({ state: "done", accountId: "acc_1" }));
    expect(saved).toEqual(["owner@example.org"]);
  });

  it("an unknown flow reads as expired, and close ends what is waiting", async () => {
    const { signIn } = setup();
    expect(signIn.status("missing")).toEqual({ state: "failed", reason: "timeout" });
    const { flowId, url } = await signIn.start({ email: null });
    signIn.close();
    expect(signIn.status(flowId)).toEqual({ state: "failed", reason: "timeout" });
    expect(await refusesConnections(url)).toBe(true);
  });

  it("does not start without a client", async () => {
    const { signIn } = setup({ client: null });
    await expect(signIn.start({ email: null })).rejects.toThrow("Google sign-in is not available");
  });
});
