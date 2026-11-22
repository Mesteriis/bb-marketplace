import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { CHANNEL, windowSchemas } from "../../../core/windows/wire.ts";
import { createWindowsStore } from "./windows-store.ts";

export const windowsContract = defineRpcContract(windowSchemas);

export function registerWindowsRpc(bb: BbPluginApi): void {
  let store: ReturnType<typeof createWindowsStore> | undefined;
  function execute(...args: Parameters<ReturnType<typeof createWindowsStore>>) {
    store ??= createWindowsStore(bb.storage.database());
    const { snapshot, changed } = store(...args);
    if (changed) bb.realtime.publish(CHANNEL, null);
    return snapshot;
  }
  bb.rpc.register(windowsContract, {
    window_sync: ({ credential, close }) => execute(credential, close),
    window_change: ({ credential, threadId, generation, command }) =>
      execute(credential, false, { threadId, generation, command }),
  });
}
