// The one place the pages' callbacks become RPC calls. BB's RPC transport
// carries JSON values only and refuses a property whose value is `undefined`
// ("not a JSON value") before the handler runs, so every payload is stripped of
// undefined-valued keys here; tests drive this bridge through a double that
// applies the strict check. Host-free: the caller is injected.
import { omitUndefined } from "../core/json-wire.ts";
import type { Profile, ProfileInput } from "../core/profile.ts";
import type { RdpDecision, SessionHandle, SessionInfo, SshTarget } from "../core/rpc.ts";
import type { RdpAttach, RdpConnectTarget, RdpPageProps, RdpScreenshotResult } from "./rdp-page.tsx";
import type { SshAttach, SshPageProps } from "./ssh-page.tsx";
import type { CredentialItem, CredentialsApi, CredentialStateName } from "./use-credentials.ts";
import type { ProfilesApi } from "./use-profiles.ts";
import type { AgentApi } from "./agent-panel.tsx";
import type { ImportApi } from "./import-panel.tsx";
import type { PveApi } from "./pve-api.ts";
import type { PveConsolesApi } from "./pve-consoles.tsx";

/** What useRpc().call looks like to this module; the page's own typing stays in app.tsx. */
export type RpcCall = (method: string, input?: unknown) => Promise<unknown>;

export interface ConnectBridge {
  profiles: ProfilesApi;
  credentials: CredentialsApi;
  imports: ImportApi;
  agents: AgentApi;
  pve: PveApi;
  pveConsoles: { attach: PveConsolesApi["attach"]; close: PveConsolesApi["close"]; takeover: NonNullable<PveConsolesApi["takeover"]> };
  ssh: Pick<SshPageProps, "onSshOpen" | "onAttach" | "onClose" | "onTakeover">;
  rdp: Pick<RdpPageProps, "onRdpOpen" | "onAttach" | "onClose" | "onDecision" | "onScreenshot" | "onTakeover">;
}

export function createConnectBridge(call: RpcCall, wsUrl: string): ConnectBridge {
  const send = async <T>(method: string, input?: unknown): Promise<T> =>
    (input === undefined ? await call(method) : await call(method, omitUndefined(input))) as T;

  const onAttach = async (handle: SessionHandle): Promise<SshAttach & RdpAttach> => ({
    token: (await send<{ token: string }>("session_attach", handle)).token,
    wsUrl,
  });
  const close = (handle: SessionHandle) => send<{ reason?: string | null }>("session_close", handle);

  return {
    profiles: {
      list: () => send<Profile[]>("profile_list"),
      save: (input: ProfileInput) => send<Profile>("profile_save", input),
      remove: (id, deleteCredential) => send<{ deleted: boolean; credentialDeleted?: boolean; credentialError?: string }>("profile_delete", { id, deleteCredential }),
      duplicate: (id) => send<Profile>("profile_duplicate", { id }),
      sessions: () => send<Array<SessionInfo & { profileId?: string }>>("session_list"),
    },
    credentials: {
      list: () => send<CredentialItem[]>("credential_list"),
      save: (input) => send<{ ref: string }>("credential_save", input),
      update: (ref, secret) => send("credential_update", { ref, secret }),
      remove: (ref) => send<{ unlinked: number }>("credential_delete", { ref }),
      status: (ref) => send<{ state: CredentialStateName }>("credential_status", { ref }),
      allow: (ref) => send<{ state: CredentialStateName }>("credential_allow", { ref }),
      allowAll: () => send<{ results: Array<{ ref: string; label: string; ok: boolean; code: string | null }> }>("credential_allow_all", {}),
    },
    imports: {
      suggestions: () => send("import_suggestions"),
      list: () => send("import_source_list"),
      add: (input) => send("import_source_add", input),
      set: (input) => send("import_source_set", input),
      remove: (id) => send("import_source_remove", { id }),
      scan: (id) => send("import_scan", { id }),
      apply: (id, keys, scanId) => send("import_apply", { id, keys, scanId }),
      resolve: (id, scanId, keys) => send("import_resolve", { id, scanId, keys }),
      trusted: () => send("known_hosts_list"),
      forget: (host) => send("known_hosts_forget", { host }),
      rdpCerts: () => send("rdp_trusted_list", {}),
      forgetRdpCert: (host, port, fingerprint) => send("rdp_trusted_forget", { host, port, fingerprint }),
    },
    agents: {
      list: () => send("agent_access_list", {}),
      set: (profileId, level, recordCommands) => send("agent_access_set", { profileId, level, recordCommands }),
      revokeAll: () => send("agent_access_revoke_all", {}),
      audit: (limit) => send("agent_audit_list", { limit }),
      sessions: () => send("agent_sessions", {}),
      takeover: (handle) => send("agent_control_takeover", handle),
      allowAgents: (handle) => send("agent_control_allow", handle),
      settings: () => send("agent_settings_get", {}),
      setRequireWatching: (value) => send("agent_settings_set", { requireWatching: value }),
      answer: (handle, promptId, answer) => send("agent_prompt_answer", { generation: handle.generation, sessionId: handle.sessionId, promptId, answer }),
      decideCertificate: async (handle, fingerprint, accept) => {
        await send("rdp_cert_decision", { generation: handle.generation, sessionId: handle.sessionId, fingerprint, accept });
      },
      disconnect: async (handle) => {
        await close(handle);
      },
    },
    pve: {
      targets: (input) => send("pve_targets", input),
      pinTrust: (profileId, fingerprint) => send("pve_trust_pin", { profileId, fingerprint }),
      openConsole: (input) => send("pve_console_open", input),
      linkGuest: (profileId, vmid, linkProfileId) => send("pve_guest_link_set", { profileId, vmid, linkProfileId }),
      onboardPlan: (input) => send("pve_onboard_plan", input),
      onboardApply: (input) => send("pve_onboard_apply", input),
      onboardConnect: (input) => send("pve_onboard_connect", input),
    },
    pveConsoles: {
      attach: onAttach,
      close: async (handle) => {
        await close(handle);
      },
      takeover: async (handle) => {
        await send("agent_control_takeover", handle);
      },
    },
    ssh: {
      onSshOpen: (target: SshTarget, profileId?: string, credentialRef?: string) => send<SessionHandle>("ssh_open", { target, profileId, credentialRef }),
      onAttach,
      onClose: async (handle) => {
        await close(handle);
      },
      onTakeover: async (handle) => {
        await send("agent_control_takeover", handle);
      },
    },
    rdp: {
      onRdpOpen: (target: RdpConnectTarget, size, profileId, options) =>
        send<SessionHandle>("rdp_open", { target, width: size.width, height: size.height, profileId, options }),
      onAttach,
      onClose: close,
      onDecision: async (handle: SessionHandle, fingerprint: string, accept: RdpDecision) => {
        await send("rdp_cert_decision", { generation: handle.generation, sessionId: handle.sessionId, fingerprint, accept });
      },
      onScreenshot: (handle) => send<RdpScreenshotResult>("rdp_screenshot", handle),
      onTakeover: async (handle) => {
        await send("agent_control_takeover", handle);
      },
    },
  };
}
