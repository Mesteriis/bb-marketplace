// Remote Hub — BB backend entry.
//
// Composition root: builds the BB adapter (HelperProcess) and the host-free
// service, exposes a schema-validated RPC contract to the app, and tears the
// helper down on dispose. All wire schemas live in src/core/rpc.ts and
// src/core/protocol.ts.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineRpcContract, experimental_PluginRpcRefusal, type BbPluginApi } from "@get-bb/plugin-sdk";
import { HELPER_BIN_NAME, HelperProcess, HelperRuntimeError, HelperStartError } from "./src/adapters/bb/helper-process.ts";
import { createRemoteHubService } from "./src/adapters/bb/service.ts";
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

  const withHelper = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      if (error instanceof HelperStartError || error instanceof HelperRuntimeError) {
        throw new experimental_PluginRpcRefusal({ code: "not_found", message: error.message });
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
  });

  bb.onDispose(() => {
    service.stop();
  });
}
