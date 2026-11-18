// The RPC handlers, built from their dependencies so tests can drive the REAL handlers with
// fakes (the security checks live here: credential-to-endpoint binding, attribution of an open to
// a profile, error mapping). server.ts only composes and registers them.
import { experimental_PluginRpcRefusal } from "@get-bb/plugin-sdk";
import { CredentialError, type CredentialBook } from "../../core/credential.ts";
import { ProfileError, type ProfileBook } from "../../core/profile-book.ts";
import type { RpcSchemas } from "../../core/rpc.ts";
import type { z } from "zod";
import { HelperRequestError, HelperRuntimeError, HelperStartError } from "./helper-process.ts";
import type { RemoteHubService } from "./service.ts";

type Input<K extends keyof RpcSchemas> = z.output<RpcSchemas[K]["input"]>;
type Output<K extends keyof RpcSchemas> = z.input<RpcSchemas[K]["output"]>;
/** Every handler takes its parsed input and returns (a promise of) its declared output. */
export type RpcHandlers = { [K in keyof RpcSchemas]: (input: Input<K>) => Output<K> | Promise<Output<K>> };

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
  };
  return new experimental_PluginRpcRefusal({ code: codeOf[error.code] ?? "invalid", message: error.code + ": " + error.message });
}


export interface RpcHandlerDeps {
  service: RemoteHubService;
  profiles: ProfileBook;
  credentials: CredentialBook;
}

export function createRpcHandlers({ service, profiles, credentials }: RpcHandlerDeps): RpcHandlers {
  const withProfile = async <T>(run: () => T | Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      if (error instanceof ProfileError) throw new experimental_PluginRpcRefusal({ code: "not_found", message: error.message });
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

  return {
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
      const profileId = profiles.attribute(input.profileId, {
        protocol: "ssh",
        host: input.target.host,
        port: input.target.port ?? 22,
        user: input.target.user ?? null,
        domain: null,
      });
      return profiles.track(profileId, () => withHelper(() => service.sshOpen(input.target, input.cols, input.rows, profileId)));
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
      return profiles.track(profileId, () => withHelper(() => service.rdpOpen(input.target, input.width, input.height, profileId)));
    },
    profile_list: () => profiles.list(),
    profile_save: (input) => withProfile(async () => (await credentials.saveProfile(input)).profile),
    profile_delete: (input) => withProfile(() => credentials.deleteProfile(input.id, input.deleteCredential ?? false)),
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
        await service.rdpCertDecision({ generation: input.generation, sessionId: input.sessionId }, input.fingerprint, input.accept);
        return { decided: true as const };
      }),
    rdp_screenshot: (input) =>
      withHelper(() => service.rdpScreenshot({ generation: input.generation, sessionId: input.sessionId })),
    session_list: () => withHelper(() => service.sessionList()),
    session_close: (input) =>
      withHelper(() =>
        service.sessionClose({ generation: input.generation, sessionId: input.sessionId }),
      ),
    session_attach: (input) =>
      withHelper(() => ({ token: service.sessionAttach({ generation: input.generation, sessionId: input.sessionId }) })),
  };
}
