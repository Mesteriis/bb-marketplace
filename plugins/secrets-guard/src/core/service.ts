// The four things the plugin does with the guard: show it, open it, close it,
// and keep the entries of trees opened "with subthreads" in step with the threads.
import { NotLocal, type Clock, type StateStore, type ThreadDirectory } from "./ports.ts";
import {
  close,
  deadline,
  effective,
  openGlobal,
  openThreads,
  resyncTree,
  treeRoots,
  type Effective,
  type Minutes,
  type Scope,
} from "./state.ts";
import { collectDescendants } from "./tree.ts";

export interface GuardView {
  /** Whether the marker location is set. */
  configured: boolean;
  /** Whether the thread runs on the machine that holds the marker. */
  local: boolean;
  effective: Effective | null;
}

export interface GuardService {
  state(input: { threadId: string }): Promise<GuardView>;
  open(input: { threadId: string; scope: Scope; minutes: Minutes }): Promise<GuardView>;
  close(input: { threadId: string }): Promise<GuardView>;
  /** Re-reads the tree of every root opened with subthreads. */
  resync(): Promise<void>;
}

export function createService(deps: {
  store: StateStore;
  threads: ThreadDirectory;
  now: Clock;
}): GuardService {
  const { store, threads, now } = deps;

  async function state(input: { threadId: string }): Promise<GuardView> {
    const local = await threads.isLocal(input.threadId);
    const configured = store.configured && (await store.writable());
    if (!local || !configured) return { configured, local, effective: null };
    return { configured, local, effective: effective(await store.read(), now(), input.threadId) };
  }

  async function requireLocal(threadId: string): Promise<void> {
    if (!(await threads.isLocal(threadId))) throw new NotLocal();
  }

  /**
   * Brings one live tree in step with its threads. When the threads cannot be
   * listed, the subthreads are closed (the root stays): a thread that may have
   * left the tree must not keep its access. Returns whether the tree is known.
   */
  async function resyncRoot(root: string): Promise<boolean> {
    let descendants: readonly string[] | null;
    try {
      descendants = await collectDescendants(root, (id) => threads.children(id));
    } catch {
      descendants = null;
    }
    await store.update(
      (current) => resyncTree(current, now(), root, descendants ?? []),
      (before) => ({
        event: "resync",
        scope: "tree",
        root,
        until: Object.hasOwn(before.threads, root) ? (before.threads[root]?.until ?? null) : null,
      }),
    );
    return descendants !== null;
  }

  return {
    state,
    async open({ threadId, scope, minutes }) {
      await requireLocal(threadId);
      const at = now();
      const until = deadline(at, minutes);
      if (scope === "global") {
        await store.update((current) => openGlobal(current, at, minutes), {
          event: "open",
          scope,
          root: null,
          until,
        });
      } else {
        const descendants =
          scope === "tree" ? await collectDescendants(threadId, (id) => threads.children(id)) : null;
        await store.update((current) => openThreads(current, at, minutes, threadId, descendants), {
          event: "open",
          scope,
          root: threadId,
          until,
        });
        // The tree may have changed between listing it and writing it.
        if (scope === "tree") await resyncRoot(threadId);
      }
      return state({ threadId });
    },
    async close({ threadId }) {
      await requireLocal(threadId);
      const at = now();
      await store.update(
        (current) => close(current, at, threadId),
        (before) => {
          const closed = effective(before, at, threadId);
          return {
            event: "close",
            scope: closed?.scope ?? null,
            root: closed?.rootThreadId ?? null,
            until: null,
          };
        },
      );
      return state({ threadId });
    },
    async resync() {
      if (!store.configured) return;
      let unknown = 0;
      for (const root of treeRoots(await store.read(), now())) {
        if (!(await resyncRoot(root))) unknown += 1;
      }
      if (unknown > 0) throw new Error(`could not list the threads of ${unknown} opened tree(s)`);
    },
  };
}
