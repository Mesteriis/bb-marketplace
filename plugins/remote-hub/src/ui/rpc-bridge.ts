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
import type { ProfilesApi } from "./use-profiles.ts";

/** What useRpc().call looks like to this module; the page's own typing stays in app.tsx. */
export type RpcCall = (method: string, input?: unknown) => Promise<unknown>;

export interface ConnectBridge {
  profiles: ProfilesApi;
  ssh: Pick<SshPageProps, "onSshOpen" | "onAttach" | "onClose">;
  rdp: Pick<RdpPageProps, "onRdpOpen" | "onAttach" | "onClose" | "onDecision" | "onScreenshot">;
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
      remove: (id) => send<{ deleted: boolean }>("profile_delete", { id }),
      duplicate: (id) => send<Profile>("profile_duplicate", { id }),
      sessions: () => send<Array<SessionInfo & { profileId?: string }>>("session_list"),
    },
    ssh: {
      onSshOpen: (target: SshTarget, profileId?: string) => send<SessionHandle>("ssh_open", { target, profileId }),
      onAttach,
      onClose: async (handle) => {
        await close(handle);
      },
    },
    rdp: {
      onRdpOpen: (target: RdpConnectTarget, size, profileId) =>
        send<SessionHandle>("rdp_open", { target, width: size.width, height: size.height, profileId }),
      onAttach,
      onClose: close,
      onDecision: async (handle: SessionHandle, fingerprint: string, accept: RdpDecision) => {
        await send("rdp_cert_decision", { generation: handle.generation, sessionId: handle.sessionId, fingerprint, accept });
      },
      onScreenshot: (handle) => send<RdpScreenshotResult>("rdp_screenshot", handle),
    },
  };
}
