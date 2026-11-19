// The plugin API: the only methods another plugin's server may call.
// Everything else in the contract refuses a plugin caller (the guard in
// src/adapters/bb/plugin-guard.ts); these are reached only with the owner's
// grant. A change that breaks a caller raises the version.

import { z } from "zod";

import { noLineBreaks } from "./model.ts";
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

export const PLUGIN_QUERY_MAX = 500;
export const PLUGIN_MESSAGES_MAX = 100;
export const PLUGIN_CONTACTS_MAX = 200;
export const PLUGIN_READ_CHARS = 100_000;
export const PLUGIN_RECIPIENTS_MAX = 50;
export const PLUGIN_LETTER_CHARS = 200_000;
export const CURSOR_MESSAGE = "Unknown cursor";
export const QUERY_MESSAGE = "Say who or what to look for";
export const INVITES_LIMIT_MESSAGE = "Too many invitations read this hour";
/** Each read of an invitation signs in to the mail server. */
export const INVITE_READS_PER_HOUR = 30;
export const UNKNOWN_MESSAGE = "Unknown message";

const personSchema = z.object({ name: z.string().nullable(), address: z.string() });
const pluginMessageSchema = z.object({
  id: z.string(),
  accountId: z.string(),
  threadId: z.string(),
  date: z.string().nullable(),
  from: personSchema,
  subject: z.string(),
  snippet: z.string(),
});

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
  /** The accounts the caller may read: nothing but what the owner sees as the account's name. */
  plugin_accounts_list: {
    input: z.object({}),
    output: z.object({
      accounts: z.array(z.object({ id: z.string(), email: z.string(), displayName: z.string().nullable(), provider: z.string() })),
    }),
  },
  /**
   * Search in one granted account, in Mail's own search syntax (free text and
   * operators such as from:, to:, after:). Only what the owner shares with
   * agents; newest first.
   */
  plugin_messages_search: {
    input: z.object({
      accountId: z.string(),
      query: z.string().max(PLUGIN_QUERY_MAX).default(""),
      limit: z.number().int().min(1).max(PLUGIN_MESSAGES_MAX).default(50),
      cursor: z.string().max(400).nullish(),
    }),
    output: z.object({ messages: z.array(pluginMessageSchema), nextCursor: z.string().nullable() }),
  },
  /** One message as plain text with its headers; passwords, codes and tokens in it are hidden as for agents. */
  plugin_message_read: {
    input: z.object({ messageId: z.string() }),
    output: pluginMessageSchema.omit({ snippet: true }).extend({
      to: z.array(personSchema),
      cc: z.array(personSchema),
      text: z.string(),
      attachments: z.array(z.object({ name: z.string().nullable(), size: z.number(), type: z.string() })),
    }),
  },
  /** People of one granted account, from mail headers. */
  plugin_contacts_list: {
    input: z.object({
      accountId: z.string(),
      /** A name, an address or a topic: a list of everyone is not offered. */
      query: z.string().min(1).max(PLUGIN_QUERY_MAX),
      limit: z.number().int().min(1).max(PLUGIN_CONTACTS_MAX).default(100),
    }),
    output: z.object({
      contacts: z.array(
        z.object({ name: z.string().nullable(), address: z.string(), received: z.number(), sent: z.number(), lastAt: z.string().nullable() }),
      ),
    }),
  },
  /** Messages of one granted account that carry a calendar part, newest first. */
  plugin_invites_list: {
    input: z.object({
      accountId: z.string(),
      limit: z.number().int().min(1).max(PLUGIN_MESSAGES_MAX).default(50),
      cursor: z.string().max(400).nullish(),
    }),
    output: z.object({
      invites: z.array(pluginMessageSchema.omit({ snippet: true })),
      nextCursor: z.string().nullable(),
    }),
  },
  /**
   * Puts a new letter in front of the owner as a draft marked with the calling
   * plugin. It is never sent from here: the owner sends it from the composer.
   */
  plugin_mail_propose: {
    input: z.object({
      accountId: z.string(),
      to: z.array(z.string().max(320)).min(1).max(PLUGIN_RECIPIENTS_MAX),
      cc: z.array(z.string().max(320)).max(PLUGIN_RECIPIENTS_MAX).default([]),
      subject: z.string().max(998).refine(noLineBreaks, { message: "Line breaks are not allowed" }),
      text: z.string().max(PLUGIN_LETTER_CHARS),
    }),
    output: z.object({ draftId: z.string() }),
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
export const PLUGIN_API_METHODS: readonly string[] = [
  "plugin_access_info",
  "plugin_access_request",
  "plugin_accounts_list",
  "plugin_messages_search",
  "plugin_message_read",
  "plugin_contacts_list",
  "plugin_invites_list",
  "plugin_invite_read",
  "plugin_mail_propose",
];

/** The owner's methods of Mail settings; a plugin caller is refused on them like on any other. */
export const PLUGIN_OWNER_METHODS: readonly string[] = [
  "plugin_grants_list",
  "plugin_grant_set",
  "plugin_grant_revoke",
  "plugin_request_dismiss",
];

/** The right an API method needs; "google" takes it from the call's input. Absent: no right. */
export const PLUGIN_METHOD_RIGHT: Readonly<Record<string, PluginRight | "google" | undefined>> = {
  plugin_accounts_list: "mail.read",
  plugin_messages_search: "mail.read",
  plugin_message_read: "mail.read",
  plugin_contacts_list: "contacts.read",
  plugin_invites_list: "invites.read",
  plugin_invite_read: "invites.read",
  plugin_mail_propose: "mail.propose",
};
