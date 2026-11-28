// BB server entry: the marker location comes from the guard hook's pointer or,
// as an override, from a setting; the three RPC
// methods expose the service, and thread events keep opened trees in step.
// The plugin registers no CLI command, agent tool or skill: only the owner's
// click in the app opens the guard.
import { homedir } from "node:os";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { StoreUnavailable, type StateStore, type ThreadDirectory } from "../../core/ports.ts";
import { createService } from "../../core/service.ts";
import { GUARD_TAG, rpcContract } from "./contract.ts";
import { createLocatedStore, locateStateFile } from "./location.ts";
import { toRefusal } from "./refusals.ts";

const CHILD_PAGE = 200;
const RESYNC_RETRY_MS = 5_000;
const now = () => Math.floor(Date.now() / 1000);

function threadDirectory(bb: BbPluginApi): ThreadDirectory {
  return {
    async children(threadId) {
      const ids: string[] = [];
      for (let offset = 0; ; offset += CHILD_PAGE) {
        const page = await bb.sdk.threads.list({
          parentThreadId: threadId,
          includeHidden: true,
          limit: CHILD_PAGE,
          offset,
        });
        ids.push(...page.map((thread) => thread.id));
        if (page.length < CHILD_PAGE) return ids;
      }
    },
    // Anything that cannot be established counts as "not here": the button stays inactive.
    async isLocal(threadId) {
      try {
        const thread = await bb.sdk.threads.get({ threadId });
        if (thread.environmentId === null) return true;
        const [environment, config] = await Promise.all([
          bb.sdk.environments.get({ environmentId: thread.environmentId }),
          bb.sdk.system.config(),
        ]);
        return config.primaryHostId !== null && environment.hostId === config.primaryHostId;
      } catch {
        return false;
      }
    },
  };
}

/** `homeDir` is where the guard hook keeps its pointer; tests pass a temporary directory. */
export function createPlugin(host: { homeDir: string }) {
  return (bb: BbPluginApi) => start(bb, host.homeDir);
}

export default createPlugin({ homeDir: homedir() });

function start(bb: BbPluginApi, homeDir: string): void {
  const settings = bb.settings.define({
    stateFile: {
      type: "string",
      label: "Файл отметки охраны (необязательно)",
      description:
        "Пусто — путь берётся у хука охраны Claude Code на этом Mac. Заполните, чтобы переопределить его: полный путь к файлу отметки.",
      default: "",
    },
  });

  let disposed = false;
  let setting = "";
  const located = createLocatedStore({
    locate: () => locateStateFile({ setting, homeDir }),
    now,
    onLeaveFailed: () => bb.log.warn("the previous marker file could not be closed"),
  });
  const store: StateStore = {
    writable: () => located.writable(),
    read: () => located.read(),
    // An unloaded instance must not write: its view of the threads is out of date.
    update: (change, log) =>
      disposed ? Promise.reject(new StoreUnavailable("not_configured")) : located.update(change, log),
  };
  const service = createService({ store, threads: threadDirectory(bb), now });

  let resyncQueued = false;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let chain: Promise<void> = Promise.resolve();

  /** One resync after the running one, however many events arrive meanwhile. */
  function scheduleResync(): void {
    if (disposed || resyncQueued) return;
    resyncQueued = true;
    chain = chain.then(async () => {
      resyncQueued = false;
      if (disposed) return;
      try {
        await service.resync();
      } catch (error) {
        if (disposed) return;
        // The subthreads of a tree that could not be listed are closed by now; try again shortly.
        bb.log.warn(`resync failed: ${error instanceof Error ? error.message : "unknown error"}`);
        if (retry === null) {
          retry = setTimeout(() => {
            retry = null;
            scheduleResync();
          }, RESYNC_RETRY_MS);
        }
      }
      if (!disposed) bb.rpc.experimental_invalidate([GUARD_TAG]);
    });
  }

  /** A changed setting leaves the file used so far: what is open there is closed first. */
  const apply = async (values: { stateFile: string }, changed: boolean) => {
    if (changed && !disposed) await located.leave();
    setting = values.stateFile;
    bb.rpc.experimental_invalidate([GUARD_TAG]);
    scheduleResync();
  };
  const report = (error: unknown) =>
    bb.log.error(`settings could not be applied: ${error instanceof Error ? error.message : "unknown error"}`);
  let ready: Promise<void> = settings.get().then((values) => apply(values, false), report);
  settings.onChange((next, previous) => {
    if (disposed) return;
    ready = ready.then(() => apply(next, next.stateFile.trim() !== previous.stateFile.trim())).catch(report);
  });

  async function guarded<T>(run: () => Promise<T>, changes: boolean): Promise<T> {
    await ready;
    try {
      const result = await run();
      if (changes) bb.rpc.experimental_invalidate([GUARD_TAG]);
      return result;
    } catch (error) {
      throw toRefusal(error);
    }
  }

  bb.rpc.register(rpcContract, {
    state: (input) => guarded(() => service.state(input), false),
    open: (input) => guarded(() => service.open(input), true),
    close: (input) => guarded(() => service.close(input), true),
  });

  bb.events.on("thread.created", scheduleResync);
  bb.events.on("thread.archived", scheduleResync);
  bb.events.on("thread.deleted", scheduleResync);
  bb.events.on("experimental_thread.parentChanged", scheduleResync);

  // The host drops the listeners with the plugin instance; the flag stops work already queued.
  bb.onDispose(() => {
    disposed = true;
    if (retry !== null) clearTimeout(retry);
  });
}
