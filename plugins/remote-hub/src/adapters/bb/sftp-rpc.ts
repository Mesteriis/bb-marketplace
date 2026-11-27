// The RPC side of SFTP for other plugins (core/sftp-contract.ts). Two sets of handlers with opposite rules: the six
// `hub_sftp_*` calls answer ONLY a caller the host reports as a plugin, and act for that plugin id (never for one named in
// the input); the `sftp_access_*` calls are the owner's page and are wrapped by `ownerOnly` with every other owner RPC.
// A refusal is a stable code and a fixed sentence: nothing ssh, the helper or the Keychain said is passed on.
import { experimental_PluginRpcRefusal } from "@get-bb/plugin-sdk";
import type { AgentAudit } from "../../core/agent-audit.ts";
import { PluginGrantError, type PluginGrantBook } from "../../core/plugin-grants.ts";
import type { Profile } from "../../core/profile.ts";
import type { SftpChannels } from "../../core/sftp-channels.ts";
import { SftpOpError } from "../../core/sftp-client.ts";
import { neededLevel, SFTP_REFUSALS, type SftpRefusalCode } from "../../core/sftp-contract.ts";
import type { RpcCallContext, RpcHandlers } from "./rpc-handlers.ts";

const TEXT: Record<SftpRefusalCode, string> = {
  caller_not_plugin: "this call is for another plugin's backend",
  consent_required: "the owner has not allowed this plugin to use this connection at this level",
  consent_revoked: "the owner took this plugin's access to this connection away",
  host_key_unknown: "the server's host key is not confirmed yet; the owner confirms it in Remote Hub",
  host_key_changed: "the server's host key is not the one that was confirmed; the owner decides in Remote Hub",
  permission_denied: "the server refused: permission denied",
  profile_not_found: "no such connection",
  channel_closed: "the channel is closed; nothing was sent",
  no_such_file: "no such file or directory",
  profile_not_sftp: "this connection cannot do SFTP",
  limit_exceeded: "a limit of the SFTP contract was exceeded",
  invalid_path: "not a valid path",
  profile_needs_config: "this connection cannot be used for SFTP as it is set up",
  agent_unavailable: "no SSH agent is running, or it holds no key the server accepts",
  keychain_locked: "the saved credential is locked",
  keychain_needs_approval: "the saved credential needs the owner's approval",
  credential_missing: "this connection has no usable saved credential",
  auth_failed: "the server refused the sign-in",
  unreachable: "the server could not be reached",
  exists: "it already exists",
  not_empty: "the directory is not empty",
  unsupported: "the server cannot do this",
  outcome_unknown: "the request was sent and the channel ended before the answer; it may or may not have been applied",
  failure: "the operation failed",
};

export function sftpRefusal(code: SftpRefusalCode): experimental_PluginRpcRefusal {
  return new experimental_PluginRpcRefusal({ code: SFTP_REFUSALS[code], message: `${code}: ${TEXT[code]}` });
}

export interface SftpRpcDeps {
  channels: SftpChannels;
  grants: PluginGrantBook;
  profiles: { list(): Profile[]; get(id: string): Profile | null };
  /** Whether the host key of a connection is already confirmed (a hint for the listing; opening decides). */
  hostKeyKnown(profile: Profile): Promise<boolean>;
  audit?: AgentAudit;
}

type PluginMethods = "hub_sftp_profiles" | "hub_sftp_request_access" | "hub_sftp_grants" | "hub_sftp_open" | "hub_sftp_op" | "hub_sftp_close";
type OwnerMethods = "sftp_access_list" | "sftp_access_grant" | "sftp_access_decline" | "sftp_access_revoke" | "sftp_access_revoke_all";

/** Who an audit row names for a plugin's call. */
const actor = (pluginId: string): string => `plugin:${pluginId}`;

function callerPlugin(ctx: RpcCallContext | undefined): string {
  const caller = ctx?.experimental_caller;
  if (caller?.kind !== "plugin" || caller.pluginId === "") throw sftpRefusal("caller_not_plugin");
  return caller.pluginId;
}

async function guarded<T>(run: () => T | Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof experimental_PluginRpcRefusal) throw error;
    if (error instanceof SftpOpError) throw sftpRefusal(error.code);
    if (error instanceof PluginGrantError) throw sftpRefusal(error.code);
    // Anything else is ours: its text may hold what must not leave.
    throw sftpRefusal("failure");
  }
}

/** The six calls other plugins make. NOT wrapped by `ownerOnly`. */
export function createSftpPluginHandlers({ channels, grants, profiles, hostKeyKnown, audit }: SftpRpcDeps): Pick<RpcHandlers, PluginMethods> {
  return {
    hub_sftp_profiles: (_input, ctx) =>
      guarded(async () => {
        const pluginId = callerPlugin(ctx);
        const out = [];
        for (const p of profiles.list()) {
          if (p.protocol !== "ssh" || (p.authType !== "agent" && p.authType !== "key" && p.authType !== "password")) continue;
          const { consent, level } = grants.consentOf(pluginId, p.id);
          let known = false;
          try {
            known = await hostKeyKnown(p);
          } catch {
            known = false;
          }
          out.push({ id: p.id, name: p.name, group: p.group ?? null, host: p.host, port: p.port ?? 22, user: p.username, authType: p.authType, consent, level, hostKey: known ? ("trusted" as const) : ("unknown" as const), needsConfig: p.needsConfig === true });
        }
        return { profiles: out };
      }),
    hub_sftp_request_access: (input, ctx) =>
      guarded(() => {
        const pluginId = callerPlugin(ctx);
        const profile = profiles.get(input.profileId);
        if (profile === null) throw sftpRefusal("profile_not_found");
        if (profile.protocol !== "ssh") throw sftpRefusal("profile_not_sftp");
        const ticket = audit?.begin({ threadId: actor(pluginId), projectId: "", tool: "sftp.request", profileId: input.profileId, detail: input.level });
        const result = grants.request(pluginId, input.profileId, input.level, input.reason);
        ticket?.finish(result.state);
        return result;
      }),
    hub_sftp_grants: (_input, ctx) => guarded(() => ({ grants: grants.list(callerPlugin(ctx)) })),
    hub_sftp_open: (input, ctx) =>
      guarded(async () => {
        const pluginId = callerPlugin(ctx);
        const ticket = audit?.begin({ threadId: actor(pluginId), projectId: "", tool: "sftp.open", profileId: input.profileId });
        try {
          const opened = await channels.open(pluginId, input.profileId);
          ticket?.finish("ok");
          return opened;
        } catch (error) {
          ticket?.finish(error instanceof SftpOpError ? error.code : "failure");
          throw error;
        }
      }),
    hub_sftp_op: (input, ctx) =>
      guarded(async () => {
        const pluginId = callerPlugin(ctx);
        // What changed something on a server is recorded (which operation and how it ended; never a path or a name).
        const ticket = neededLevel(input.op) === "write" ? audit?.begin({ threadId: actor(pluginId), projectId: "", tool: `sftp.${input.op}`, sessionKey: input.channelId }) : undefined;
        try {
          const out = await channels.op(pluginId, input);
          ticket?.finish("ok");
          return out;
        } catch (error) {
          ticket?.finish(error instanceof SftpOpError ? error.code : "failure");
          throw error;
        }
      }),
    hub_sftp_close: (input, ctx) => guarded(() => ({ closed: channels.close(callerPlugin(ctx), input.channelId) })),
  };
}

/** The owner's page. Wrapped by `ownerOnly` in rpc-handlers.ts: a plugin can never grant itself anything. */
export function createSftpOwnerHandlers({ channels, grants, audit }: SftpRpcDeps, owner: string): Pick<RpcHandlers, OwnerMethods> {
  const refuse = (error: unknown): never => {
    if (error instanceof PluginGrantError) throw new experimental_PluginRpcRefusal({ code: "not_found", message: error.message });
    throw error;
  };
  return {
    sftp_access_list: () => ({ requests: grants.pending(), grants: grants.granted(), channels: channels.list() }),
    sftp_access_grant: (input) => {
      const ticket = audit?.begin({ threadId: owner, projectId: "", tool: "sftp.grant", profileId: input.profileId, detail: `${input.level} -> ${input.pluginId}` });
      try {
        grants.grant(input.pluginId, input.profileId, input.level);
      } catch (error) {
        ticket?.finish("refused");
        return refuse(error);
      }
      ticket?.finish("ok");
      return { granted: true as const };
    },
    sftp_access_decline: (input) => ({ declined: grants.decline(input.requestId) }),
    sftp_access_revoke: (input) => {
      const ticket = audit?.begin({ threadId: owner, projectId: "", tool: "sftp.revoke", profileId: input.profileId, detail: input.pluginId });
      const before = channels.list().filter((c) => c.pluginId === input.pluginId && c.profileId === input.profileId).length;
      const revoked = grants.revoke(input.pluginId, input.profileId);
      // The grant book tells the channels (server.ts); this is the same call again for a book wired without that.
      channels.revoked(input.pluginId, input.profileId);
      ticket?.finish(revoked ? "ok" : "nothing");
      return { revoked, channelsClosed: revoked ? before : 0 };
    },
    sftp_access_revoke_all: () => {
      const ticket = audit?.begin({ threadId: owner, projectId: "", tool: "sftp.revoke_all" });
      const held = grants.granted();
      const revoked = grants.revokeAll();
      for (const g of held) channels.revoked(g.pluginId, g.profileId);
      ticket?.finish("ok");
      return { revoked };
    },
  };
}
