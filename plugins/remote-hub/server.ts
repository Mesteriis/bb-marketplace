// Remote Hub — BB backend entry.
//
// Composition root: builds the BB adapter (HelperProcess), exposes a
// schema-validated RPC contract to the app, and tears the helper down on
// dispose. All wire schemas live in src/core/rpc.ts and src/core/protocol.ts.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineRpcContract, experimental_PluginRpcRefusal, type BbPluginApi } from "@get-bb/plugin-sdk";
import { HELPER_BIN_NAME, HelperProcess, HelperRuntimeError, HelperStartError } from "./src/adapters/bb/helper-process.ts";
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
  let helper: HelperProcess | null = null;
  let starting: Promise<HelperProcess> | null = null;

  const startHelper = (): Promise<HelperProcess> => {
    if (helper !== null) return Promise.resolve(helper);
    if (starting === null) {
      starting = HelperProcess.start(pluginRootDir())
        .then((started) => {
          helper = started;
          // A dead helper is dropped from the cache so the next call starts a
          // fresh one; no input is ever replayed.
          started.onExit(() => {
            if (helper === started) helper = null;
          });
          return started;
        })
        .finally(() => {
          starting = null;
        });
    }
    return starting;
  };

  const withHelper = async <T>(run: (process: HelperProcess) => Promise<T>): Promise<T> => {
    try {
      return await run(await startHelper());
    } catch (error) {
      if (error instanceof HelperStartError || error instanceof HelperRuntimeError) {
        throw new experimental_PluginRpcRefusal({ code: "not_found", message: error.message });
      }
      throw error;
    }
  };

  bb.rpc.register(rpcContract, {
    helper_status: () =>
      withHelper(async (process) => {
        const status = process.status!;
        // alive reflects a live ping, not just the handshake snapshot.
        const alive = await process.pingAlive();
        return { ...status, alive };
      }),
    echo_open: (input) => withHelper(async (process) => ({ sessionId: await process.openEcho(input.cols, input.rows) })),
    echo_input: (input) => withHelper(async (process) => process.input(input.sessionId, input.data)),
    echo_close: (input) =>
      withHelper(async (process) => {
        await process.close(input.sessionId);
        return { closed: true };
      }),
  });

  bb.onDispose(() => {
    if (helper !== null) helper.stop();
  });
}
