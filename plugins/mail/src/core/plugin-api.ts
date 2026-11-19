// The plugin API: the only methods another plugin's server may call.
// Everything else in the contract refuses a plugin caller (the guard in
// src/adapters/bb/plugin-guard.ts); these are reached only with the owner's
// grant. A change that breaks a caller raises the version.

import { z } from "zod";

import { PLUGIN_RIGHTS, type PluginRight } from "./plugin-access.ts";

export const PLUGIN_API_VERSION = 1 as const;

/** A plugin caller on a method outside the plugin API. */
export const PLUGIN_CALLER_MESSAGE = "Other plugins reach Makosh Mail only through its plugin API";

/** A client caller on a method that answers a plugin's grants. */
export const PLUGIN_ONLY_MESSAGE = "This method is for other plugins";
export const PLUGIN_ID_MESSAGE = "This plugin id is too long";
export const REQUEST_INVALID_MESSAGE = "Unknown right in the request";
export const REQUEST_LIMIT_MESSAGE = "Too many access requests today";
export const GRANT_RIGHT_MESSAGE = "Unknown right";
export const GRANT_ACCOUNT_MESSAGE = "Unknown account";
export const GRANT_GOOGLE_MESSAGE = "Turn this on in Mail settings";
/** A plugin without the right a method needs; names the right so the plugin can ask for it. */
export const missingRightMessage = (right: PluginRight): string => `Makosh Mail: this plugin has no "${right}" access`;

/** Realtime: plugin requests or grants changed; the settings section reloads, the page announces a new request. */
export const PLUGIN_ACCESS_CHANNEL = "plugin-access";
export type PluginAccessPayload = { request: string | null };

const rightSchema = z.enum(PLUGIN_RIGHTS);
const okSchema = z.object({ ok: z.literal(true) });
const requestViewSchema = z.object({ rights: z.array(rightSchema), reason: z.string(), askedAt: z.string() });

/** Every `plugin_*` method: the API other plugins call, then the owner's methods of Mail settings. */
export const pluginApiSchemas = {
  /** The API's version, the caller's grants and its pending request. */
  plugin_access_info: {
    input: z.object({}),
    output: z.object({
      apiVersion: z.literal(PLUGIN_API_VERSION),
      grants: z.array(z.object({ right: rightSchema, accountId: z.string() })),
      request: requestViewSchema.nullable(),
    }),
  },
  /** Asks the owner for rights; replaces the caller's earlier request. Gives nothing by itself. */
  plugin_access_request: {
    input: z.object({ rights: z.array(z.string()).max(PLUGIN_RIGHTS.length * 2), reason: z.string().max(2000) }),
    output: okSchema,
  },
  /** Owner: every plugin that holds a grant or asked for one. */
  plugin_grants_list: {
    input: z.object({}),
    output: z.object({
      plugins: z.array(
        z.object({
          pluginId: z.string(),
          grants: z.array(z.object({ right: rightSchema, accountId: z.string(), grantedAt: z.string() })),
          lastCallAt: z.string().nullable(),
        }),
      ),
      requests: z.array(requestViewSchema.extend({ pluginId: z.string() })),
    }),
  },
  /** Owner: one grant on or off. */
  plugin_grant_set: {
    input: z.object({ pluginId: z.string().min(1), right: z.string(), accountId: z.string(), on: z.boolean() }),
    output: okSchema,
  },
  /** Owner: everything a plugin has and asked for. */
  plugin_grant_revoke: {
    input: z.object({ pluginId: z.string().min(1) }),
    output: okSchema,
  },
  /** Owner: a plugin's pending request, without granting anything. */
  plugin_request_dismiss: {
    input: z.object({ pluginId: z.string().min(1) }),
    output: okSchema,
  },
};

/** Methods a plugin caller may reach, each through the grant check. */
export const PLUGIN_API_METHODS: readonly string[] = ["plugin_access_info", "plugin_access_request"];

/** The owner's methods of Mail settings; a plugin caller is refused on them like on any other. */
export const PLUGIN_OWNER_METHODS: readonly string[] = [
  "plugin_grants_list",
  "plugin_grant_set",
  "plugin_grant_revoke",
  "plugin_request_dismiss",
];

/** The right an API method needs; "google" takes it from the call's input. Absent: no right. */
export const PLUGIN_METHOD_RIGHT: Readonly<Record<string, PluginRight | "google" | undefined>> = {};
