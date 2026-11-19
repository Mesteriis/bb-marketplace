// The RPC handlers, built from their dependencies so tests can drive the REAL handlers with
// fakes (the security checks live here: credential-to-endpoint binding, attribution of an open to
// a profile, error mapping). server.ts only composes and registers them.
import { experimental_PluginRpcRefusal } from "@get-bb/plugin-sdk";
import { AgentAccessError, type AgentAccessBook } from "../../core/agent-access.ts";
import type { AgentAudit } from "../../core/agent-audit.ts";
import { CredentialError, type CredentialBook } from "../../core/credential.ts";
import { ImportError, type ImportBook, type ImportSource } from "../../core/import-book.ts";
import type { Profile } from "../../core/profile.ts";
import { ProfileError, type ProfileBook } from "../../core/profile-book.ts";
import type { RpcSchemas } from "../../core/rpc.ts";
import type { SshTarget as SshOpenTarget } from "../../core/ssh-args.ts";
import type { z } from "zod";
import { HelperRequestError, HelperRuntimeError, HelperStartError } from "./helper-process.ts";
import type { AgentControlRpc } from "./agent-control-rpc.ts";
import type { RemoteHubService } from "./service.ts";
import type { PveRpc } from "./pve-rpc.ts";
import { PveRpcError } from "./pve-rpc.ts";

type Input<K extends keyof RpcSchemas> = z.output<RpcSchemas[K]["input"]>;
type Output<K extends keyof RpcSchemas> = z.input<RpcSchemas[K]["output"]>;
/** Every handler takes its parsed input and returns (a promise of) its declared output. */
/** The second argument is what the host passes: who is calling. Absent only in tests that call a handler directly. */
export interface RpcCallContext {
  readonly experimental_caller?: { readonly kind: "plugin"; readonly pluginId: string } | { readonly kind: "client" };
}
export type RpcHandlers = { [K in keyof RpcSchemas]: (input: Input<K>, ctx?: RpcCallContext) => Output<K> | Promise<Output<K>> };

/** Who the audit names for a change made through the owner's page. */
export const OWNER_RPC = "owner RPC";

/**
 * These RPCs are the owner's page talking to this plugin. Another plugin has no business calling them, least of
 * all to widen an agent grant, so a caller of kind "plugin" is refused. (The host reports every other caller,
 * including `bb plugin rpc call` from a shell, as kind "client": that cannot be told apart from the page.)
 */
export function ownerOnly(handlers: RpcHandlers): RpcHandlers {
  const wrapped: Record<string, unknown> = {};
  for (const [name, handler] of Object.entries(handlers) as Array<[string, (input: unknown, ctx?: RpcCallContext) => unknown]>) {
    wrapped[name] = async (input: unknown, ctx?: RpcCallContext) => {
      if (ctx?.experimental_caller?.kind === "plugin") throw new experimental_PluginRpcRefusal({ code: "forbidden", message: "this RPC is for the Remote Hub page, not for other plugins" });
      return await handler(input, ctx);
    };
  }
  return wrapped as unknown as RpcHandlers;
}

/** A credential failure as an RPC refusal; the stable code travels in front of the text. */
export function credentialRefusal(error: CredentialError): experimental_PluginRpcRefusal {
  const codeOf: Record<string, "not_found" | "forbidden" | "conflict" | "invalid"> = {
    keychain_locked: "forbidden",
    keychain_denied: "forbidden",
    credential_target_mismatch: "forbidden",
    keychain_unavailable: "not_found",
    credential_unknown: "not_found",
    credential_missing: "not_found",
    profile_not_found: "not_found",
    credential_exists: "conflict",
    profile_needs_config: "invalid",
  };
  return new experimental_PluginRpcRefusal({ code: codeOf[error.code] ?? "invalid", message: error.code + ": " + error.message });
}


export interface RpcHandlerDeps {
  service: RemoteHubService;
  profiles: ProfileBook;
  credentials: CredentialBook;
  imports: ImportBook;
  /** Agent grants and the audit (stage 4a); the owner's page is the only caller of these RPCs. */
  agents?: { access: AgentAccessBook; audit: AgentAudit };
  /** Taking a session back from an agent, listing what agents opened, answering their questions (stage 4b-1). */
  agentControl?: AgentControlRpc;
  /** Which agent thread opened a session (stage 4c): the catalogue marks those. */
  openedBy?: (sessionKey: string) => string | undefined;
  /** Proxmox discovery and onboarding (the owner's page only). */
  pve?: PveRpc;
}

export function createRpcHandlers({ service, profiles, credentials, imports, agents, agentControl, openedBy, pve }: RpcHandlerDeps): RpcHandlers {
  const withPve = async <T>(run: (p: PveRpc) => T | Promise<T>): Promise<T> => {
    if (pve === undefined) throw new experimental_PluginRpcRefusal({ code: "not_found", message: "Proxmox support is not available" });
    try {
      return await run(pve);
    } catch (error) {
      if (error instanceof PveRpcError) throw new experimental_PluginRpcRefusal({ code: error.code, message: error.message });
      if (error instanceof ProfileError) throw new experimental_PluginRpcRefusal({ code: "not_found", message: error.message });
      if (error instanceof HelperStartError || error instanceof HelperRuntimeError) throw new experimental_PluginRpcRefusal({ code: "not_found", message: error.message });
      throw error;
    }
  };
  const control = (): AgentControlRpc => {
    if (agentControl === undefined) throw new experimental_PluginRpcRefusal({ code: "not_found", message: "agent control is not available" });
    return agentControl;
  };
  const withAgents = <T>(run: (a: { access: AgentAccessBook; audit: AgentAudit }) => T): T => {
    if (agents === undefined) throw new experimental_PluginRpcRefusal({ code: "not_found", message: "agent access is not available" });
    try {
      return run(agents);
    } catch (error) {
      if (error instanceof AgentAccessError) throw new experimental_PluginRpcRefusal({ code: error.code === "profile_not_found" ? "not_found" : "invalid", message: error.message });
      throw error;
    }
  };

  const withProfile = async <T>(run: () => T | Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      if (error instanceof ProfileError) throw new experimental_PluginRpcRefusal({ code: "not_found", message: error.message });
      if (error instanceof CredentialError) throw credentialRefusal(error);
      throw error;
    }
  };

  const withImport = async <T>(run: () => T | Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      if (error instanceof ImportError) {
        const code = error.code === "source_unknown" ? "not_found" : error.code === "source_disabled" || error.code === "ssh_g_off" ? "forbidden" : error.code === "scan_required" ? "conflict" : "invalid";
        throw new experimental_PluginRpcRefusal({ code, message: error.code + ": " + error.message });
      }
      if (error instanceof CredentialError) throw credentialRefusal(error);
      throw error;
    }
  };

  const withHelper = async <T>(run: () => T | Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      if (error instanceof HelperStartError || error instanceof HelperRuntimeError || error instanceof HelperRequestError) {
        // The helper's stable code travels in front of the text so the page can act on it.
        const message = error instanceof HelperRequestError ? error.code + ": " + error.message : error.message;
        throw new experimental_PluginRpcRefusal({ code: "not_found", message });
      }
      throw error;
    }
  };

  return ownerOnly({
    helper_status: () => withHelper(() => service.helperStatus()),
    echo_open: (input) => withHelper(() => service.echoOpen(input.cols, input.rows)),
    echo_input: (input) =>
      withHelper(() =>
        service.echoInput({ generation: input.generation, sessionId: input.sessionId }, input.data),
      ),
    echo_close: (input) =>
      withHelper(() => service.echoClose({ generation: input.generation, sessionId: input.sessionId })),
    // profileId is a claim, not a fact: it is kept only when the target is the
    // profile's own endpoint; otherwise the open runs unattributed.
    ssh_open: async (input) => {
      const endpoint = {
        protocol: "ssh" as const,
        host: input.target.host.toLowerCase(),
        port: input.target.port ?? 22,
        user: input.target.user ?? null,
        domain: null,
      };
      // A saved secret only works for the connection it was saved for; the server, not the
      // client, decides how the session authenticates (the one prompt that is expected).
      let target: SshOpenTarget = input.target;
      let askpass: { credentialRef: string } | undefined;
      if (input.credentialRef !== undefined) {
        try {
          const authMethod = credentials.authorizeSsh(input.credentialRef, endpoint, input.target.identityFile);
          target = { ...input.target, authMethod };
          askpass = { credentialRef: input.credentialRef };
        } catch (error) {
          if (error instanceof CredentialError) throw credentialRefusal(error);
          throw error;
        }
      }
      const profileId = profiles.attribute(input.profileId, endpoint);
      return profiles.track(profileId, () => withHelper(() => service.sshOpen(target, input.cols, input.rows, profileId, askpass)));
    },
    rdp_open: async (input) => {
      const endpoint = {
        protocol: "rdp" as const,
        host: input.target.host,
        port: input.target.port,
        user: input.target.username,
        domain: input.target.domain ?? null,
      };
      // A saved credential only works against the endpoint it was saved for.
      if (input.target.credentialRef !== undefined) {
        try {
          credentials.authorizeEndpoint(input.target.credentialRef, endpoint);
        } catch (error) {
          if (error instanceof CredentialError) throw credentialRefusal(error);
          throw error;
        }
      }
      const profileId = profiles.attribute(input.profileId, endpoint);
      // A saved profile's own options win (read here, never taken from the page); Quick connect sends a preset; with neither
      // the default (Balanced) applies in the helper.
      const options = profileId === undefined ? input.options : (profiles.get(profileId)?.rdpOptions ?? undefined);
      return profiles.track(profileId, () => withHelper(() => service.rdpOpen(input.target, input.width, input.height, profileId, options)));
    },
    profile_list: () => imports.decorate(profiles.list()),
    profile_save: (input) =>
      withProfile(async () => {
        // A certificate pin is a decision about a certificate the owner was shown: only the guarded paths may store one.
        if (pve !== undefined) {
          try {
            pve.checkProfileSave(input);
          } catch (error) {
            if (error instanceof PveRpcError) throw new experimental_PluginRpcRefusal({ code: error.code, message: error.message });
            throw error;
          }
        }
        return imports.decorate([(await credentials.saveProfile(input)).profile])[0] as Profile;
      }),
    known_hosts_list: () => withImport(() => withHelper(() => imports.trustedHosts())),
    known_hosts_forget: (input) => withImport(() => withHelper(async () => ({ removed: await imports.forgetHost(input.host) }))),
    import_suggestions: () => imports.suggestions(),
    import_source_list: () => imports.sources(),
    import_source_add: (input) => withImport(() => imports.addSource(input)),
    import_source_set: (input) =>
      withImport(() => {
        if (input.enabled !== undefined) imports.setEnabled(input.id, input.enabled);
        if (input.useSshG !== undefined) imports.setSshG(input.id, input.useSshG);
        return imports.sources().find((s) => s.id === input.id) as ImportSource;
      }),
    import_source_remove: (input) => withImport(() => ({ removed: imports.removeSource(input.id) })),
    import_scan: (input) => withImport(() => imports.scan(input.id)),
    import_apply: (input) => withImport(() => imports.apply(input.id, input.keys, input.scanId)),
    import_resolve: (input) => withImport(() => imports.resolve(input.id, input.scanId, input.keys)),
    profile_delete: (input) =>
      withProfile(async () => {
        const result = await credentials.deleteProfile(input.id, input.deleteCredential ?? false);
        if (result.deleted) pve?.onProfileDeleted(input.id);
        return result;
      }),
    pve_targets: (input) => withPve(async (p) => ({ connections: await p.targets({ profileIds: input.profileIds, refresh: input.refresh }) })),
    pve_trust_pin: (input) =>
      withPve((p) => {
        p.pinTrust(input.profileId, input.fingerprint);
        return { pinned: true as const };
      }),
    pve_guest_link_set: (input) =>
      withPve((p) => {
        p.linkGuest(input.profileId, input.vmid, input.linkProfileId);
        return { linked: input.linkProfileId !== null };
      }),
    pve_console_open: (input) =>
      withPve(async (p) => {
        const request = input.console === "node" ? ({ console: "node", node: input.node as string } as const) : ({ console: input.console, vmid: input.vmid as number } as const);
        const answer = await p.openConsole({ ...request, profileId: input.profileId, cols: input.cols, rows: input.rows });
        return answer.ok ? { ok: true as const, generation: answer.handle.generation, sessionId: answer.handle.sessionId, kind: answer.kind } : answer;
      }),
    pve_onboard_plan: (input) => withPve((p) => p.onboardPlan(input)),
    pve_onboard_apply: (input) => withPve((p) => p.onboardApply(input)),
    pve_onboard_connect: (input) => withPve((p) => p.onboardConnect(input)),
    credential_list: () => credentials.list(),
    credential_save: (input) => withProfile(() => credentials.save(input)),
    credential_update: (input) =>
      withProfile(async () => {
        await credentials.update(input.ref, input.secret);
        return { updated: true as const };
      }),
    credential_delete: (input) => withProfile(() => credentials.delete(input.ref)),
    credential_status: (input) => withProfile(async () => ({ state: await credentials.status(input.ref) })),
    profile_duplicate: (input) => withProfile(() => profiles.duplicate(input.id)),
    rdp_cert_decision: (input) =>
      withHelper(async () => {
        // The owner's decision about a certificate is recorded like any other act of theirs on a session an agent may touch:
        // which session and what they chose, never the certificate.
        const ticket = agents?.audit.begin({ threadId: OWNER_RPC, projectId: "", tool: "cert.decision", sessionKey: `${input.generation}.${input.sessionId}`, detail: input.accept });
        try {
          await service.rdpCertDecision({ generation: input.generation, sessionId: input.sessionId }, input.fingerprint, input.accept);
          ticket?.finish("ok");
        } catch (error) {
          ticket?.finish(error instanceof HelperRequestError ? error.code : "error");
          throw error;
        }
        return { decided: true as const };
      }),
    agent_access_list: async () => withAgents(({ access }) => access.list().map(({ profileId, level, recordCommands, updatedAt }) => ({ profileId, level: level as "observe" | "input" | "exec", recordCommands, updatedAt }))),
    agent_access_set: async (input) =>
      withAgents(({ access, audit }) => {
        const ticket = audit.begin({ threadId: OWNER_RPC, projectId: "", tool: "access.set", profileId: input.profileId, detail: `${input.level} <- ${access.get(input.profileId).level}` });
        try {
          const grant = access.set(input.profileId, input.level, input.recordCommands);
          ticket.finish("ok");
          return { profileId: grant.profileId, level: grant.level, recordCommands: grant.recordCommands };
        } catch (error) {
          ticket.finish(error instanceof AgentAccessError ? error.code : "error");
          throw error;
        }
      }),
    agent_access_revoke_all: async () =>
      withAgents(({ access, audit }) => {
        const ticket = audit.begin({ threadId: OWNER_RPC, projectId: "", tool: "access.revoke_all", detail: `removed ${access.list().length}` });
        const revoked = access.revokeAll();
        ticket.finish("ok");
        return { revoked };
      }),
    agent_audit_list: async (input) => withAgents(({ audit }) => audit.list(input.limit)),
    agent_control_takeover: async (input) => control().agent_control_takeover(input),
    agent_control_allow: async (input) => control().agent_control_allow(input),
    agent_settings_get: async (input) => control().agent_settings_get(input),
    agent_settings_set: async (input) => control().agent_settings_set(input),
    agent_sessions: async (input) => control().agent_sessions(input),
    agent_prompt_answer: async (input) => control().agent_prompt_answer(input),
    rdp_trusted_list: () => withHelper(async () => service.rdpTrustedList()),
    rdp_trusted_forget: (input) => withHelper(async () => ({ removed: service.rdpTrustedForget(input.host, input.port, input.fingerprint) })),
    rdp_screenshot: (input) =>
      withHelper(() => service.rdpScreenshot({ generation: input.generation, sessionId: input.sessionId })),
    session_list: () => withHelper(() => service.sessionList().map((s) => ({ ...s, openedByAgent: openedBy?.(`${s.generation}.${s.sessionId}`) ?? null }))),
    session_close: (input) =>
      withHelper(() =>
        service.sessionClose({ generation: input.generation, sessionId: input.sessionId }),
      ),
    session_attach: (input) =>
      withHelper(() => ({ token: service.sessionAttach({ generation: input.generation, sessionId: input.sessionId }) })),
  });
}
