// BB server entry: the marker location comes from a setting, the three RPC
// methods expose the service, and thread events keep opened trees in step.
// The plugin registers no CLI command, agent tool or skill: only the owner's
// click in the app opens the guard.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { StoreUnavailable, type StateStore, type ThreadDirectory } from "../../core/ports.ts";
import { createService } from "../../core/service.ts";
import { GUARD_TAG, rpcContract } from "./contract.ts";
import { createFileStore } from "./file-store.ts";
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

export default function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    stateFile: {
      type: "string",
      label: "Файл отметки охраны",
      description:
        "Полный путь к файлу отметки, который читает хук охраны Claude Code на этом Mac. Пока поле пусто, кнопка неактивна.",
      default: "",
    },
  });

  let disposed = false;
  let currentPath = "";
  let current = createFileStore({ stateFile: null, now });
  const store: StateStore = {
    get configured() {
      return current.configured;
    },
    writable: () => current.writable(),
    read: () => current.read(),
    // An unloaded instance must not write: its view of the threads is out of date.
    update: (change, log) =>
      disposed ? Promise.reject(new StoreUnavailable("not_configured")) : current.update(change, log),
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

  const apply = (values: { stateFile: string }) => {
    const nextPath = values.stateFile.trim();
    if (nextPath !== currentPath && current.configured) {
      // The old file stays in force for the hook, and nothing here could close it any more.
      const previous = current;
      void previous
        .update(
          (state) =>
            state.until === undefined && Object.keys(state.threads).length === 0 ? state : { threads: {} },
          { event: "close", scope: null, root: null, until: null },
        )
        .catch(() => bb.log.warn("the previous marker file could not be closed"));
    }
    currentPath = nextPath;
    current = createFileStore({ stateFile: nextPath, now });
    bb.rpc.experimental_invalidate([GUARD_TAG]);
    scheduleResync();
  };
  const ready = settings.get().then(apply, (error: unknown) => {
    bb.log.error(`settings are unreadable: ${error instanceof Error ? error.message : "unknown error"}`);
  });
  settings.onChange((next) => {
    if (!disposed) apply(next);
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
