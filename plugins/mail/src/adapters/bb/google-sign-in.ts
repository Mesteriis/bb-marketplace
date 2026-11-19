// One Google sign-in for an installed app: the system browser shows Google's
// consent page and comes back to a listener on 127.0.0.1 at a random port
// that lives for this one sign-in. The listener takes a single request with
// the flow's state, answers with a fixed page and closes. Nothing from the
// request or from Google is logged or shown: a flow ends as an account or a
// fixed reason.
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { ADDRESS_IS_ALIAS } from "../../core/accounts.ts";
import { GOOGLE_MAIL_SCOPES, googleAuthorizationUrl, googleIdentity, sameMailbox } from "../../core/google-oauth.ts";
import type { Account } from "../../core/model.ts";
import type { GoogleClient } from "./google-oauth-client.ts";
import type { GoogleTokens } from "./google-tokens.ts";

export type GoogleSignInFailure =
  /** Consent was refused or the page reported an error. */
  | "denied"
  /** Nobody came back in time, or the flow is no longer known. */
  | "timeout"
  /** Another Google account signed in than the one asked for. */
  | "mismatch"
  /** Google gave no refresh token, so the account could not stay signed in. */
  | "no_refresh_token"
  /** The mail server refused the new grant. */
  | "refused"
  /** The mail server could not be reached to try the grant. */
  | "unreachable"
  /** The address is a sending address of another account. */
  | "alias"
  | "error";

export type GoogleSignInStatus =
  | { state: "pending" }
  | { state: "done"; accountId: string }
  | { state: "failed"; reason: GoogleSignInFailure };

export interface GoogleSignIn {
  /** Opens the listener and returns the consent page to open. Rejects when the plugin has no client. */
  start(input: { email: string | null; extraScopes?: readonly string[] }): Promise<{ flowId: string; url: string }>;
  status(flowId: string): GoogleSignInStatus;
  /** Ends every flow and closes every listener. */
  close(): void;
}

export type GoogleSignInDeps = {
  client: GoogleClient | null;
  tokens: GoogleTokens;
  /** One IMAP sign-in with the new grant. */
  testSignIn: (email: string, refreshToken: string) => Promise<"ok" | "refused" | "unreachable">;
  /** Saves the account; throws an Error with ADDRESS_IS_ALIAS for an alias of another account. */
  save: (input: { email: string; refreshToken: string; scopes: string[] }) => Promise<Account>;
  scopes?: readonly string[];
  /** How long the browser may take; five minutes by default. */
  timeoutMs?: number;
};

export const GOOGLE_SIGN_IN_TIMEOUT_MS = 5 * 60_000;
/** Sign-ins waiting for the browser at once; a new one ends the oldest. */
const PENDING_MAX = 3;
/** Finished flows kept so the page can read how they ended. */
const KEPT_MAX = 16;

const page = (text: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Makosh Mail</title></head>` +
  `<body style="font-family:system-ui,sans-serif;margin:3rem"><p>${text}</p></body></html>`;
const DONE_PAGE = page("Makosh Mail is finishing the sign-in. You can close this tab and return to BB.");
const DENIED_PAGE = page("The sign-in was not completed. You can close this tab and return to BB.");
const REFUSED_PAGE = page("This address accepts nothing more.");

type Flow = {
  status: GoogleSignInStatus;
  server: Server | null;
  timer: ReturnType<typeof setTimeout> | null;
  used: boolean;
};

const base64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");

function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function createGoogleSignIn(deps: GoogleSignInDeps): GoogleSignIn {
  const flows = new Map<string, Flow>();
  const scopes = deps.scopes ?? GOOGLE_MAIL_SCOPES;
  const timeoutMs = deps.timeoutMs ?? GOOGLE_SIGN_IN_TIMEOUT_MS;

  function release(flow: Flow): void {
    if (flow.timer !== null) clearTimeout(flow.timer);
    flow.timer = null;
    const server = flow.server;
    flow.server = null;
    if (server !== null) {
      server.close();
      server.closeAllConnections();
    }
  }

  function end(flow: Flow, status: GoogleSignInStatus): void {
    if (flow.status.state === "pending") flow.status = status;
    release(flow);
  }

  function prune(): void {
    // Only sign-ins still waiting for the browser: one that came back is being finished.
    const pending = [...flows.values()].filter((flow) => flow.status.state === "pending" && !flow.used);
    while (pending.length >= PENDING_MAX) end(pending.shift()!, { state: "failed", reason: "timeout" });
    for (const [id, flow] of flows) {
      if (flows.size < KEPT_MAX) break;
      if (flow.status.state !== "pending") flows.delete(id);
    }
  }

  /** The consent's code as an account, or the reason it did not become one. */
  async function finish(
    wanted: string | null,
    grant: { code: string; codeVerifier: string; redirectUri: string },
  ): Promise<GoogleSignInStatus> {
    const failed = (reason: GoogleSignInFailure): GoogleSignInStatus => ({ state: "failed", reason });
    const reply = await deps.tokens.exchangeCode(grant);
    if (!reply.ok) return failed("error");
    if (reply.refreshToken === null) return failed("no_refresh_token");
    const identity = reply.idToken === null ? null : googleIdentity(reply.idToken);
    if (identity === null) return failed("error");
    if (wanted !== null && !sameMailbox(wanted, identity.email)) return failed("mismatch");
    const tried = await deps.testSignIn(identity.email, reply.refreshToken);
    if (tried !== "ok") return failed(tried);
    try {
      const account = await deps.save({ email: identity.email, refreshToken: reply.refreshToken, scopes: reply.scopes });
      return { state: "done", accountId: account.id };
    } catch (error) {
      return failed(error instanceof Error && error.message === ADDRESS_IS_ALIAS ? "alias" : "error");
    }
  }

  return {
    async start({ email, extraScopes }) {
      const asked = [...new Set([...scopes, ...(extraScopes ?? [])])];
      const client = deps.client;
      if (client === null) throw new Error("Google sign-in is not available");
      prune();
      const flowId = randomUUID();
      const state = base64url(randomBytes(24));
      const codeVerifier = base64url(randomBytes(32));
      const codeChallenge = base64url(createHash("sha256").update(codeVerifier).digest());
      const flow: Flow = { status: { state: "pending" }, server: null, timer: null, used: false };
      let redirectUri = "";

      const server = createServer((request, response) => {
        const answer = (status: number, body: string) => {
          response.writeHead(status, {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
            "referrer-policy": "no-referrer",
            connection: "close",
          });
          response.end(body);
        };
        let url: URL;
        try {
          url = new URL(request.url ?? "/", "http://127.0.0.1");
        } catch {
          return answer(400, REFUSED_PAGE);
        }
        if (request.method !== "GET" || url.pathname !== "/") return answer(404, REFUSED_PAGE);
        if (flow.used || flow.status.state !== "pending" || !sameText(url.searchParams.get("state") ?? "", state)) {
          return answer(400, REFUSED_PAGE);
        }
        flow.used = true;
        const code = url.searchParams.get("code");
        if (url.searchParams.has("error") || code === null || code === "") {
          answer(200, DENIED_PAGE);
          response.once("finish", () => end(flow, { state: "failed", reason: "denied" }));
          return;
        }
        answer(200, DONE_PAGE);
        // The port is free as soon as the page is sent; the grant is finished without it.
        response.once("finish", () => release(flow));
        void finish(email, { code, codeVerifier, redirectUri })
          .catch((): GoogleSignInStatus => ({ state: "failed", reason: "error" }))
          .then((status) => end(flow, status));
      });
      server.on("error", () => end(flow, { state: "failed", reason: "error" }));
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve());
      });
      flow.server = server;
      redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      flow.timer = setTimeout(() => end(flow, { state: "failed", reason: "timeout" }), timeoutMs);
      flow.timer.unref?.();
      flows.set(flowId, flow);
      return {
        flowId,
        url: googleAuthorizationUrl({ clientId: client.id, redirectUri, scopes: asked, state, codeChallenge, loginHint: email }),
      };
    },

    status(flowId) {
      return flows.get(flowId)?.status ?? { state: "failed", reason: "timeout" };
    },

    close() {
      for (const flow of flows.values()) end(flow, { state: "failed", reason: "timeout" });
    },
  };
}
