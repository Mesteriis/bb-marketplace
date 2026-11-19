// Handlers of the plugin API (src/core/plugin-api.ts) and of the owner's
// methods that grant it. A plugin is known only by the id BB verified for
// the call; a client caller has none, so the API's own methods refuse it.
import type { ExperimentalPluginRpcHandlerContext } from "@get-bb/plugin-sdk";

import {
  PLUGIN_ID_MAX,
  REQUESTS_PER_DAY,
  cleanRequest,
  isGoogleRight,
  isPluginRight,
  overDailyLimit,
  type PluginGrant,
  type PluginRight,
} from "../../core/plugin-access.ts";
import {
  GRANT_ACCOUNT_MESSAGE,
  GRANT_GOOGLE_MESSAGE,
  GRANT_RIGHT_MESSAGE,
  PLUGIN_API_VERSION,
  PLUGIN_ID_MESSAGE,
  PLUGIN_METHOD_RIGHT,
  PLUGIN_ONLY_MESSAGE,
  REQUEST_INVALID_MESSAGE,
  REQUEST_LIMIT_MESSAGE,
  missingRightMessage,
} from "../../core/plugin-api.ts";
import type { MailStore } from "../../core/ports.ts";
import { refuse } from "./bb-rpc.ts";
import type { PluginCheck } from "./plugin-guard.ts";

export type PluginApiDeps = {
  store: MailStore;
  now: () => Date;
  /** Requests or grants changed; `request` is the plugin that has just asked, if one has. */
  announce: (request: string | null) => void;
  /** Plugin id to the time of its last call (the activity log). */
  lastCalls?: () => ReadonlyMap<string, string>;
};

type Context = ExperimentalPluginRpcHandlerContext;

/** The verified id of the calling plugin; a client caller is refused. */
export function callingPlugin(context: Context): string {
  const caller = context.experimental_caller;
  if (caller.kind !== "plugin") throw refuse("forbidden", PLUGIN_ONLY_MESSAGE);
  if (caller.pluginId.length === 0 || caller.pluginId.length > PLUGIN_ID_MAX) throw refuse("invalid", PLUGIN_ID_MESSAGE);
  return caller.pluginId;
}

export function createPluginApi(deps: PluginApiDeps) {
  const { store } = deps;
  const ok = { ok: true as const };

  /** The grant check the guard runs before a handler: the plugin holds the method's right for some account. */
  const check: PluginCheck = (pluginId, method, input) => {
    const needs = PLUGIN_METHOD_RIGHT[method];
    if (needs === undefined) return;
    const asked = needs === "google" ? (input as { right?: unknown } | null)?.right : needs;
    if (typeof asked !== "string" || !isPluginRight(asked) || (needs === "google" && !isGoogleRight(asked))) {
      throw refuse("invalid", GRANT_RIGHT_MESSAGE);
    }
    if (!store.listPluginGrants().some((grant) => grant.pluginId === pluginId && grant.right === asked)) {
      throw refuse("forbidden", missingRightMessage(asked));
    }
  };

  const grantOf = (input: { pluginId: string; right: string; accountId: string }): PluginGrant => {
    if (input.pluginId.length > PLUGIN_ID_MAX) throw refuse("invalid", PLUGIN_ID_MESSAGE);
    if (!isPluginRight(input.right)) throw refuse("invalid", GRANT_RIGHT_MESSAGE);
    return { pluginId: input.pluginId, right: input.right as PluginRight, accountId: input.accountId, grantedAt: deps.now().toISOString() };
  };

  const handlers = {
    plugin_access_info: (_input: Record<string, never>, context: Context) => {
      const pluginId = callingPlugin(context);
      const request = store.getPluginRequests().find((r) => r.pluginId === pluginId) ?? null;
      return {
        apiVersion: PLUGIN_API_VERSION,
        grants: store
          .listPluginGrants()
          .filter((grant) => grant.pluginId === pluginId)
          .map((grant) => ({ right: grant.right, accountId: grant.accountId })),
        request: request === null ? null : { rights: request.rights, reason: request.reason, askedAt: request.askedAt },
      };
    },

    plugin_access_request: (input: { rights: string[]; reason: string }, context: Context) => {
      const pluginId = callingPlugin(context);
      const clean = cleanRequest(input);
      if (!clean.ok) throw refuse("invalid", REQUEST_INVALID_MESSAGE);
      const now = deps.now();
      if (overDailyLimit(store.pluginRequestTimes(pluginId), now, REQUESTS_PER_DAY)) {
        throw refuse("conflict", REQUEST_LIMIT_MESSAGE);
      }
      store.putPluginRequest({ pluginId, rights: clean.rights, reason: clean.reason, askedAt: now.toISOString() });
      deps.announce(pluginId);
      return ok;
    },

    plugin_grants_list: (_input: Record<string, never>, _context?: Context) => {
      const grants = store.listPluginGrants();
      const requests = store.getPluginRequests();
      const lastCalls = deps.lastCalls?.() ?? new Map<string, string>();
      const ids = [...new Set(grants.map((grant) => grant.pluginId))].sort();
      return {
        plugins: ids.map((pluginId) => ({
          pluginId,
          grants: grants
            .filter((grant) => grant.pluginId === pluginId)
            .map((grant) => ({ right: grant.right, accountId: grant.accountId, grantedAt: grant.grantedAt })),
          lastCallAt: lastCalls.get(pluginId) ?? null,
        })),
        requests,
      };
    },

    plugin_grant_set: (input: { pluginId: string; right: string; accountId: string; on: boolean }, _context?: Context) => {
      const grant = grantOf(input);
      if (input.on) {
        // A Google key needs Google's own consent for its scope first: Mail settings run that sign-in.
        if (isGoogleRight(grant.right)) throw refuse("invalid", GRANT_GOOGLE_MESSAGE);
        if (store.getAccount(grant.accountId) === null) throw refuse("not_found", GRANT_ACCOUNT_MESSAGE);
      }
      store.setPluginGrant(grant, input.on);
      deps.announce(null);
      return ok;
    },

    plugin_grant_revoke: (input: { pluginId: string }, _context?: Context) => {
      store.revokePluginGrants(input.pluginId);
      deps.announce(null);
      return ok;
    },

    plugin_request_dismiss: (input: { pluginId: string }, _context?: Context) => {
      store.dismissPluginRequest(input.pluginId);
      deps.announce(null);
      return ok;
    },
  };

  return { handlers, check };
}

export type PluginApi = ReturnType<typeof createPluginApi>;
