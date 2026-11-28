// S16
import { CommanderError } from "./src/core/errors.ts";
import { createEditHostHandlers } from "./src/adapters/bb/edit-host-handlers.ts";
import { editHostSchemas } from "./src/core/wire/edit.ts";
import { defineRpcContract, experimental_defineHostEntry } from "@get-bb/plugin-sdk";
import { createHostFs } from "./src/adapters/bb/host-fs/index.ts";
import { HostFsContract } from "./src/core/wire/host-fs.ts";

const fs = createHostFs();

function requireDataDir<I, O>(handler: (input: I, context: Parameters<typeof fs.rpcHandlers.read>[1]) => Promise<O>) {
  return async (input: I, context: Parameters<typeof fs.rpcHandlers.read>[1]) => {
    if (!context.experimental_paths?.dataDir) {
      throw new Error(JSON.stringify(new CommanderError("unsupported", "Каталог редактора BB недоступен").toShape()));
    }
    return handler(input, context);
  };
}

const protectedFs = Object.fromEntries(Object.entries(fs.rpcHandlers).map(([name, handler]) =>
  [name, requireDataDir(handler as (input: never, context: Parameters<typeof fs.rpcHandlers.read>[1]) => Promise<unknown>)]
)) as typeof fs.rpcHandlers;

export default experimental_defineHostEntry({
  contract: defineRpcContract({ ...HostFsContract, ...editHostSchemas }),
  handlers: { ...protectedFs, ...createEditHostHandlers() },
  dispose: fs.dispose,
});
