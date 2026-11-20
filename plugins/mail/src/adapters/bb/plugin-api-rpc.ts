// Handlers of the plugin API (src/core/plugin-api.ts) and of the owner's
// methods that grant it. A plugin is known only by the id BB verified for
// the call; a client caller has none, so the API's own methods refuse it.
import type { ExperimentalPluginRpcHandlerContext } from "@get-bb/plugin-sdk";

import { pluginRef, type LogEntryInput, type LogTool } from "../../core/agent-log.ts";
import { redactedSubject } from "../../core/agent-text.ts";
import type { InviteView } from "../../core/calendar-invite.ts";
import type { Contact } from "../../core/contacts.ts";
import type { MessageHeader, MessageSummary, SearchCursor } from "../../core/model.ts";
import {
  GOOGLE_RIGHT_SCOPE,
  PLUGIN_ID_MAX,
  REQUESTS_PER_DAY,
  cleanRequest,
  grantedAccounts,
  hasRight,
  isGoogleRight,
  isPluginRight,
  overDailyLimit,
  type PluginGrant,
  type PluginRight,
} from "../../core/plugin-access.ts";
import {
  CURSOR_MESSAGE,
  INVITES_LIMIT_MESSAGE,
  INVITE_READS_PER_HOUR,
  QUERY_MESSAGE,
  UNKNOWN_MESSAGE,
  GRANT_ACCOUNT_MESSAGE,
  GOOGLE_KEY_REVOKED_MESSAGE,
  GOOGLE_KEY_UNAVAILABLE_MESSAGE,
  GOOGLE_NOT_SIGNED_MESSAGE,
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
import { PROPOSE_REFUSAL_TEXT, type PluginLetter, type proposePluginLetter } from "../../core/plugin-propose.ts";
import type { MailStore } from "../../core/ports.ts";
import { refuse } from "./bb-rpc.ts";
import type { PluginCheck } from "./plugin-guard.ts";

export type PluginApiDeps = {
  store: MailStore;
  now: () => Date;
  /** Requests or grants changed; `request` is the plugin that has just asked, if one has. */
  announce: (request: string | null) => void;
  /** One content-free row of the activity log. */
  log: (entry: LogEntryInput) => void;
  /** Milliseconds, as Date.now(): the hourly limit of refused-call rows. */
  clockMs?: () => number;
  /** The reads agents use: inside the owner's AI access, secrets hidden. */
  reads: PluginReads;
  /** An access token of the account's Google sign-in narrowed to one scope; never the refresh token. */
  googleKey: (accountId: string, scope: string) => Promise<GoogleKey>;
  /** A letter as a marked draft of the account; never a send. */
  propose: (pluginId: string, letter: PluginLetter) => ReturnType<typeof proposePluginLetter>;
};

export type GoogleKey =
  | { ok: true; accessToken: string; expiresAt: number; scope: string }
  | { ok: false; reason: "not_google" | "scope" | "revoked" | "unavailable" };

export type PluginReads = {
  /** A page of one account's search in Mail's syntax; `refused` when the text would match a secret. */
  search: (
    query: string,
    accountId: string,
    limit: number,
    cursor: SearchCursor | null,
  ) => { refused: string } | { hits: MessageSummary[]; nextCursor: SearchCursor | null };
  /** One message when the owner shares it, with its redacted plain text. */
  read: (messageId: string) => { header: MessageHeader; subject: string; text: string; hiddenCount: number } | null;
  /** People of one account, read from that account's shared mail only. */
  contacts: (query: string, limit: number, accountId: string) => Contact[];
  /** Whether a stored message carries a calendar part. */
  calendarPart: (messageId: string) => boolean;
  /** The message's header when the owner shares it. */
  shared: (messageId: string) => MessageHeader | null;
  /** The invitation a message carries, parsed; null when it holds none. */
  invite: (messageId: string) => Promise<InviteView | null>;
};

const REFUSED_LOG_MS = 60 * 60 * 1000;

function encodeCursor(cursor: SearchCursor | null): string | null {
  return cursor === null ? null : Buffer.from(JSON.stringify([cursor.date, cursor.id]), "utf8").toString("base64url");
}

/** A cursor carries a position only; one that does not parse is refused. */
function decodeCursor(text: string | null | undefined): SearchCursor | null {
  if (text == null) return null;
  try {
    const value: unknown = JSON.parse(Buffer.from(text, "base64url").toString("utf8"));
    if (Array.isArray(value) && value.length === 2 && (value[0] === null || typeof value[0] === "string") && typeof value[1] === "string") {
      return { date: value[0] as string | null, id: value[1] };
    }
  } catch {
    // Falls through to the refusal.
  }
  throw refuse("invalid", CURSOR_MESSAGE);
}

type Context = ExperimentalPluginRpcHandlerContext;

/** The log's name for each API method. */
const TOOL_OF: Readonly<Record<string, LogTool>> = {
  plugin_access_request: "plugin_request",
  plugin_accounts_list: "plugin_accounts",
  plugin_messages_search: "plugin_search",
  plugin_message_read: "plugin_read",
  plugin_contacts_list: "plugin_contacts",
  plugin_invites_list: "plugin_invites",
  plugin_invite_read: "plugin_invites",
  plugin_mail_propose: "plugin_propose",
  plugin_google_token: "plugin_token",
};

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
      throw missing(pluginId, method, asked);
    }
  };

  /** Per plugin, when it read an invitation in the last hour. */
  const inviteReads = new Map<string, number[]>();
  const refusedAt = new Map<string, number>();
  /** The refusal for a missing right; logged once per plugin, method and hour. */
  function missing(pluginId: string, method: string, right: PluginRight): Error {
    const key = `${pluginId}\n${method}`;
    const nowMs = (deps.clockMs ?? Date.now)();
    const last = refusedAt.get(key);
    if (last === undefined || nowMs - last >= REFUSED_LOG_MS) {
      refusedAt.set(key, nowMs);
      if (refusedAt.size > 1000) refusedAt.clear();
      deps.log({ actor: "plugin", tool: TOOL_OF[method] ?? "plugin_request", outcome: "refused_scope", refId: pluginRef(pluginId) });
    }
    return refuse("forbidden", missingRightMessage(right));
  }

  /** The account when the plugin holds the right for it; otherwise the refusal that names the right. */
  function granted(pluginId: string, method: string, right: PluginRight, accountId: string): string {
    if (!hasRight(store.listPluginGrants(), pluginId, right, accountId)) throw missing(pluginId, method, right);
    return accountId;
  }

  const done = (pluginId: string, tool: LogTool, ids: readonly string[], count: number, hiddenCount = 0) =>
    deps.log({ actor: "plugin", tool, outcome: count === 0 ? "empty" : "ok", messageIds: ids, count, hiddenCount, refId: pluginRef(pluginId) });

  /** A name is the sender's own text: secrets in it are hidden like in a subject. */
  const person = (address: { name: string | null; address: string }) => ({
    name: address.name === null ? null : redactedSubject(address.name),
    address: address.address,
  });

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
      deps.log({ actor: "plugin", tool: "plugin_request", outcome: "ok", count: clean.rights.length, refId: pluginRef(pluginId) });
      deps.announce(pluginId);
      return ok;
    },

    plugin_accounts_list: (_input: Record<string, never>, context: Context) => {
      const pluginId = callingPlugin(context);
      const mine = new Set(grantedAccounts(store.listPluginGrants(), pluginId, "mail.read"));
      const scope = store.getAiScope();
      const accounts = store
        .listAccounts()
        .filter((account) => mine.has(account.id))
        // An account the owner shares with no AI is named by id only, as it is to agents.
        .map((account) =>
          scope.accounts.get(account.id)?.mode === "none"
            ? { id: account.id, email: "", displayName: null, provider: account.preset }
            : { id: account.id, email: account.email, displayName: account.displayName ?? null, provider: account.preset },
        );
      done(pluginId, "plugin_accounts", [], accounts.length);
      return { accounts };
    },

    plugin_messages_search: (
      input: { accountId: string; query: string; limit: number; cursor?: string | null | undefined },
      context: Context,
    ) => {
      const pluginId = callingPlugin(context);
      const accountId = granted(pluginId, "plugin_messages_search", "mail.read", input.accountId);
      const page = deps.reads.search(input.query, accountId, input.limit, decodeCursor(input.cursor));
      if ("refused" in page) {
        deps.log({ actor: "plugin", tool: "plugin_search", outcome: "refused_invalid", refId: pluginRef(pluginId) });
        throw refuse("invalid", page.refused);
      }
      // The account is checked again on every row: a wider store answer must not widen the grant.
      const hits = page.hits.filter((hit) => hit.accountId === accountId);
      done(pluginId, "plugin_search", hits.map((hit) => hit.id), hits.length);
      return {
        messages: hits.map((hit) => ({
          id: hit.id,
          accountId: hit.accountId,
          threadId: hit.threadId,
          date: hit.date,
          from: person(hit.from),
          subject: redactedSubject(hit.subject),
          snippet: "",
        })),
        nextCursor: encodeCursor(page.nextCursor),
      };
    },

    plugin_message_read: (input: { messageId: string }, context: Context) => {
      const pluginId = callingPlugin(context);
      const read = deps.reads.read(input.messageId);
      // An id outside the grant or the owner's sharing is unknown, not forbidden: existence is not disclosed.
      if (read === null || !hasRight(store.listPluginGrants(), pluginId, "mail.read", read.header.accountId)) {
        deps.log({ actor: "plugin", tool: "plugin_read", outcome: "refused_invalid", refId: pluginRef(pluginId) });
        throw refuse("not_found", UNKNOWN_MESSAGE);
      }
      const { header } = read;
      done(pluginId, "plugin_read", [header.id], 1, read.hiddenCount);
      return {
        id: header.id,
        accountId: header.accountId,
        threadId: header.threadId,
        date: header.date,
        from: person(header.from),
        to: header.to.map(person),
        cc: header.cc.map(person),
        subject: read.subject,
        text: read.text,
        attachments: header.attachments.map((part) => ({
          name: part.filename == null ? null : redactedSubject(part.filename),
          size: part.size,
          type: part.mimeType,
        })),
      };
    },

    plugin_contacts_list: (input: { accountId: string; query: string; limit: number }, context: Context) => {
      const pluginId = callingPlugin(context);
      const accountId = granted(pluginId, "plugin_contacts_list", "contacts.read", input.accountId);
      if (input.query.trim() === "") throw refuse("invalid", QUERY_MESSAGE);
      const contacts = deps.reads
        .contacts(input.query, input.limit, accountId)
        .map((contact) => ({
          name: contact.name === null ? null : redactedSubject(contact.name),
          address: contact.address,
          received: contact.received,
          sent: contact.sentByOwner,
          lastAt: contact.lastDate,
        }));
      done(pluginId, "plugin_contacts", [], contacts.length);
      return { contacts };
    },

    plugin_invites_list: (input: { accountId: string; limit: number; cursor?: string | null | undefined }, context: Context) => {
      const pluginId = callingPlugin(context);
      const accountId = granted(pluginId, "plugin_invites_list", "invites.read", input.accountId);
      const rows = store.calendarMessages(accountId, input.limit, decodeCursor(input.cursor));
      const last = rows.at(-1);
      const headers = rows.map((row) => deps.reads.shared(row.id)).filter((header): header is MessageHeader => header !== null);
      done(pluginId, "plugin_invites", headers.map((header) => header.id), headers.length);
      return {
        invites: headers.map((header) => ({
          id: header.id,
          accountId: header.accountId,
          threadId: header.threadId,
          date: header.date,
          from: person(header.from),
          subject: redactedSubject(header.subject),
        })),
        nextCursor: rows.length < input.limit || last === undefined ? null : encodeCursor({ date: last.date ?? "", id: last.id }),
      };
    },

    plugin_invite_read: async (input: { messageId: string }, context: Context) => {
      const pluginId = callingPlugin(context);
      const header = deps.reads.shared(input.messageId);
      if (header === null || !hasRight(store.listPluginGrants(), pluginId, "invites.read", header.accountId)) {
        deps.log({ actor: "plugin", tool: "plugin_invites", outcome: "refused_invalid", refId: pluginRef(pluginId) });
        throw refuse("not_found", UNKNOWN_MESSAGE);
      }
      // A read signs in to the mail server: only for a message that carries an invitation, and not in bursts.
      if (!deps.reads.calendarPart(header.id)) throw refuse("not_found", UNKNOWN_MESSAGE);
      const nowMs = (deps.clockMs ?? Date.now)();
      const recent = (inviteReads.get(pluginId) ?? []).filter((at) => nowMs - at < REFUSED_LOG_MS);
      if (recent.length >= INVITE_READS_PER_HOUR) {
        deps.log({ actor: "plugin", tool: "plugin_invites", outcome: "refused_caps", refId: pluginRef(pluginId) });
        throw refuse("conflict", INVITES_LIMIT_MESSAGE);
      }
      inviteReads.set(pluginId, [...recent, nowMs]);
      const read = await deps.reads.invite(header.id);
      const hide = (text: string | null) => (text === null ? null : redactedSubject(text));
      // The event's text and names are the sender's: secrets in them are hidden as in a message.
      const invite =
        read === null
          ? null
          : {
              ...read,
              summary: redactedSubject(read.summary),
              location: hide(read.location),
              description: hide(read.description),
              organizer: read.organizer === null ? null : { ...read.organizer, name: hide(read.organizer.name) },
              attendees: read.attendees.map((attendee) => ({ ...attendee, name: hide(attendee.name) })),
            };
      done(pluginId, "plugin_invites", [header.id], invite === null ? 0 : 1);
      return { invite };
    },

    plugin_mail_propose: async (
      input: { accountId: string; to: string[]; cc: string[]; subject: string; text: string },
      context: Context,
    ) => {
      const pluginId = callingPlugin(context);
      const accountId = granted(pluginId, "plugin_mail_propose", "mail.propose", input.accountId);
      const result = await deps.propose(pluginId, { ...input, accountId });
      if (!result.ok) {
        deps.log({ actor: "plugin", tool: "plugin_propose", outcome: result.reason === "limit" ? "refused_caps" : "refused_invalid", refId: pluginRef(pluginId) });
        throw refuse(result.reason === "limit" ? "conflict" : result.reason === "account" ? "not_found" : "invalid", PROPOSE_REFUSAL_TEXT[result.reason]);
      }
      deps.log({ actor: "plugin", tool: "plugin_propose", outcome: "prepared", count: 1, refId: pluginRef(pluginId) });
      deps.announce(null);
      return { draftId: result.draftId };
    },

    plugin_google_token: async (input: { accountId: string; right: string }, context: Context) => {
      const pluginId = callingPlugin(context);
      if (!isGoogleRight(input.right)) throw refuse("invalid", GRANT_RIGHT_MESSAGE);
      const accountId = granted(pluginId, "plugin_google_token", input.right, input.accountId);
      const key = await deps.googleKey(accountId, GOOGLE_RIGHT_SCOPE[input.right]);
      if (!key.ok) {
        deps.log({ actor: "plugin", tool: "plugin_token", outcome: "failed", refId: pluginRef(pluginId) });
        throw refuse(
          key.reason === "not_google" || key.reason === "scope" ? "invalid" : "conflict",
          key.reason === "not_google"
            ? GOOGLE_NOT_SIGNED_MESSAGE
            : key.reason === "scope"
              ? GRANT_GOOGLE_MESSAGE
              : key.reason === "revoked"
                ? GOOGLE_KEY_REVOKED_MESSAGE
                : GOOGLE_KEY_UNAVAILABLE_MESSAGE,
        );
      }
      // The log says a key was taken and by whom; never the key.
      deps.log({ actor: "plugin", tool: "plugin_token", outcome: "ok", count: 1, refId: pluginRef(pluginId) });
      return { accessToken: key.accessToken, expiresAt: new Date(key.expiresAt).toISOString(), scope: key.scope };
    },

    plugin_grants_list: (_input: Record<string, never>, _context?: Context) => {
      const grants = store.listPluginGrants();
      const requests = store.getPluginRequests();
      const lastCalls = store.pluginLastCalls();
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
        const account = store.getAccount(grant.accountId);
        if (account === null) throw refuse("not_found", GRANT_ACCOUNT_MESSAGE);
        // A Google key needs Google's own consent for its service first: the mailbox signs in with it in Mail settings.
        if (isGoogleRight(grant.right) && !(account.authKind === "google" && account.grantedScopes.includes(GOOGLE_RIGHT_SCOPE[grant.right]))) {
          throw refuse("conflict", GRANT_GOOGLE_MESSAGE);
        }
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
