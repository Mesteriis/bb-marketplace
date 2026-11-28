// S16
import { createEditHostHandlers } from "./src/adapters/bb/edit-host-handlers.ts";
import { editHostSchemas } from "./src/core/wire/edit.ts";
import { defineRpcContract, experimental_defineHostEntry } from "@get-bb/plugin-sdk";
import { createHostFs } from "./src/adapters/bb/host-fs/index.ts";
import { HostFsContract } from "./src/core/wire/host-fs.ts";

const fs = createHostFs();
export default experimental_defineHostEntry({
  contract: defineRpcContract({ ...HostFsContract, ...editHostSchemas }),
  handlers: { ...fs.rpcHandlers, ...createEditHostHandlers() },
  dispose: fs.dispose,
});
