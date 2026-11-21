// Makosh Zoom — BB backend entry.
//
// Composition root: builds the BB implementations of the core's ports and
// exposes the core over BB RPC and two HTTP routes. The Zoom client secret and
// the OAuth tokens stay in this process; the page receives only a per-meeting
// signature and the user's ZAK, which the Meeting SDK needs in the browser.
import { randomBytes } from "node:crypto";
import { defineRpcContract, experimental_PluginRpcRefusal, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { registerHttpRoutes } from "./src/adapters/bb/http-routes.ts";
import { createPendingLogins } from "./src/adapters/bb/pending-logins.ts";
import { createTokenStore, generateVaultKey, isVaultKey } from "./src/adapters/bb/token-store.ts";
import { prepareCall } from "./src/core/call.ts";
import { CHANNEL_ACCOUNT_CHANGED, rpcSchemas } from "./src/core/contract.ts";
import { DomainError } from "./src/core/errors.ts";
import { createOAuth } from "./src/core/oauth.ts";
import type { AppCredentialsSource, HttpFetch } from "./src/core/ports.ts";
import { redirectUriFor } from "./src/core/redirect.ts";
import { createZoomApi } from "./src/core/zoom-api.ts";

export const rpcContract = defineRpcContract(rpcSchemas);

const ZOOM_TIMEOUT_MS = 20_000;

const zoomFetch: HttpFetch = (url, request) =>
  fetch(url, {
    method: request.method,
    headers: request.headers,
    body: request.body,
    redirect: "error",
    signal: AbortSignal.timeout(ZOOM_TIMEOUT_MS),
  });

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    clientId: {
      type: "string",
      label: "Zoom Client ID",
      description: "Client ID of your Zoom General app (user-managed) with Meeting SDK enabled.",
      default: "",
    },
    publicClientId: {
      type: "string",
      label: "Zoom Public client ID",
      description:
        "Public client ID of the same app (Basic information → Use public client OAuth). Needed when BB is open on http://127.0.0.1; leave empty for an https address.",
      default: "",
    },
    clientSecret: {
      type: "string",
      label: "Zoom Client Secret",
      description: "Client Secret of the same Zoom app. Stays on the BB server.",
      secret: true,
    },
    vaultKey: {
      type: "string",
      label: "Token encryption key",
      description: "32-byte base64 key that encrypts the Zoom sign-in. Generated on first load; changing it disconnects the account.",
      secret: true,
      experimental_schema: z.string().refine(isVaultKey, "Must be a 32-byte key in base64"),
    },
  });

  let { vaultKey } = await settings.get();
  if (vaultKey === undefined) {
    vaultKey = generateVaultKey();
    await settings.experimental_set({ vaultKey });
  }

  const credentials: AppCredentialsSource = {
    async get() {
      const { clientId, clientSecret, publicClientId } = await settings.get();
      const id = clientId.trim();
      const publicId = publicClientId.trim();
      if (id === "" || clientSecret === undefined || clientSecret === "") return null;
      return { clientId: id, clientSecret, publicClientId: publicId === "" ? null : publicId };
    },
  };
  const clock = { now: () => Date.now() };
  const oauth = createOAuth({
    clock,
    credentials,
    fetch: zoomFetch,
    tokens: createTokenStore(bb.storage.kv, vaultKey),
    pending: createPendingLogins(),
    random: { token: (bytes) => randomBytes(bytes).toString("base64url") },
  });
  const api = createZoomApi({ fetch: zoomFetch, clock, accessToken: (options) => oauth.accessToken(options) });
  const accountChanged = () => bb.realtime.publish(CHANNEL_ACCOUNT_CHANGED, {});

  registerHttpRoutes(bb, oauth, accountChanged);

  async function run<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof DomainError) {
        // A sign-in that Zoom no longer accepts was just forgotten: tell open pages.
        if (error.code === "auth_expired") accountChanged();
        throw new experimental_PluginRpcRefusal({
          code: error.code === "not_found" ? "not_found" : "invalid",
          message: error.message,
        });
      }
      bb.log.error("request failed: " + (error instanceof Error ? error.name : "unknown"));
      throw new experimental_PluginRpcRefusal({ code: "invalid", message: "Запрос не выполнен. Повторите попытку" });
    }
  }

  bb.rpc.register(rpcContract, {
    async status() {
      const configured = (await credentials.get()) !== null;
      const connected = await oauth.isConnected();
      // The name is decoration: the page still works when Zoom cannot be reached.
      const displayName = configured && connected ? await api.profile().then((p) => p.displayName, () => null) : null;
      // Read again: a refresh Zoom rejected during the profile call forgets the account.
      return { configured, connected: await oauth.isConnected(), displayName };
    },
    redirect_uri: ({ origin }) => run(async () => ({ redirectUri: redirectUriFor(origin) })),
    login_begin: ({ origin }) =>
      run(async () => {
        const redirectUri = redirectUriFor(origin);
        return { ...(await oauth.beginLogin(redirectUri)), redirectUri };
      }),
    disconnect: () =>
      run(async () => {
        await oauth.disconnect();
        accountChanged();
        return { ok: true as const };
      }),
    meetings_list: () => run(async () => ({ meetings: await api.listUpcoming() })),
    meeting_create: (input) => run(async () => ({ meeting: await api.createMeeting(input) })),
    call_prepare: (input) => run(() => prepareCall({ clock, credentials, api }, input)),
  });
}
