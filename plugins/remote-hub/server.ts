// Remote Hub — BB backend entry.
//
// Composition root: builds the BB adapter (HelperProcess) and the host-free
// service, exposes a schema-validated RPC contract to the app, and tears the
// helper down on dispose. All wire schemas live in src/core/rpc.ts and
// src/core/protocol.ts.
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineRpcContract, experimental_PluginRpcRefusal, type BbPluginApi } from "@get-bb/plugin-sdk";
import { HELPER_BIN_NAME, HelperProcess, HelperRequestError, HelperRuntimeError, HelperStartError } from "./src/adapters/bb/helper-process.ts";
import { PROFILE_MIGRATIONS, createSqliteProfileStore } from "./src/adapters/bb/profile-sqlite.ts";
import { createRemoteHubService } from "./src/adapters/bb/service.ts";
import { registerStreamSocket } from "./src/adapters/bb/stream-socket.ts";
import { ProfileBook, ProfileError } from "./src/core/profile-book.ts";
import { rpcSchemas } from "./src/core/rpc.ts";

export const rpcContract = defineRpcContract(rpcSchemas);

/**
 * The plugin root: server.ts lives there in a checkout and is compiled to
 * dist/ by bb plugin build, so try the current directory and its parent.
 */
function pluginRootDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [here, dirname(here)];
  for (const dir of candidates) {
    if (existsSync(join(dir, "bin", HELPER_BIN_NAME))) return dir;
  }
  return here;
}

export default function plugin(bb: BbPluginApi): void {
  const service = createRemoteHubService({
    startHelper: () => HelperProcess.start(pluginRootDir()),
  });

  const db = bb.storage.database();
  bb.storage.migrate(db, PROFILE_MIGRATIONS);
  const profiles = new ProfileBook({
    store: createSqliteProfileStore(db),
    now: () => new Date(),
    newId: () => randomUUID(),
    onHistoryError: (code) => bb.log.warn(`profile history not written (${code})`),
  });
  const withProfile = <T>(run: () => T): T => {
    try {
      return run();
    } catch (error) {
      if (error instanceof ProfileError) throw new experimental_PluginRpcRefusal({ code: "not_found", message: error.message });
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

  bb.rpc.register(rpcContract, {
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
    ssh_open: (input) => {
      const profileId = profiles.attribute(input.profileId, {
        protocol: "ssh",
        host: input.target.host,
        port: input.target.port ?? 22,
        user: input.target.user ?? null,
        domain: null,
      });
      return profiles.track(profileId, () => withHelper(() => service.sshOpen(input.target, input.cols, input.rows, profileId)));
    },
    rdp_open: (input) => {
      const profileId = profiles.attribute(input.profileId, {
        protocol: "rdp",
        host: input.target.host,
        port: input.target.port,
        user: input.target.username,
        domain: input.target.domain ?? null,
      });
      return profiles.track(profileId, () => withHelper(() => service.rdpOpen(input.target, input.width, input.height, profileId)));
    },
    profile_list: () => profiles.list(),
    profile_save: (input) => withProfile(() => profiles.save(input)),
    profile_delete: (input) => ({ deleted: profiles.remove(input.id) }),
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
  });

  registerStreamSocket(bb, { service });

  bb.onDispose(() => {
    service.stop();
  });
}
