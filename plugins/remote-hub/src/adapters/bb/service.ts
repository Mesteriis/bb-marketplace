// The Remote Hub backend service: owns the cached HelperProcess, restarts it
// after a crash without replaying any input, and exposes the operations the
// RPC surface wraps. Host-free of the BB SDK (only the adapter), so it is
// unit-testable with an injected startHelper factory.
import { HelperProcess, HelperStatus } from "./helper-process.ts";
import type { SessionHandle } from "../../core/rpc.ts";

export interface RemoteHubServiceDeps {
  startHelper: () => Promise<HelperProcess>;
}

export interface RemoteHubService {
  helperStatus(): Promise<HelperStatus>;
  echoOpen(cols: number, rows: number): Promise<SessionHandle>;
  echoInput(handle: SessionHandle, data: string): Promise<{ output: string; truncated: boolean }>;
  echoClose(handle: SessionHandle): Promise<{ closed: boolean }>;
  stop(): void;
}

export function createRemoteHubService(deps: RemoteHubServiceDeps): RemoteHubService {
  let helper: HelperProcess | null = null;
  let starting: Promise<HelperProcess> | null = null;

  const start = (): Promise<HelperProcess> => {
    if (helper !== null) return Promise.resolve(helper);
    if (starting === null) {
      starting = deps
        .startHelper()
        .then((started) => {
          helper = started;
          // Drop a dead helper from the cache so the next call starts fresh;
          // nothing is replayed to a new helper.
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

  return {
    async helperStatus() {
      const process = await start();
      const alive = await process.pingAlive();
      return { ...process.status!, alive };
    },
    async echoOpen(cols, rows) {
      const process = await start();
      return process.openEcho(cols, rows);
    },
    async echoInput(handle, data) {
      const process = await start();
      return process.input(handle, data);
    },
    async echoClose(handle) {
      const process = await start();
      await process.close(handle);
      return { closed: true };
    },
    stop() {
      if (helper !== null) helper.stop();
    },
  };
}
