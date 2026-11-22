// The `bb-thread` panels: one existing BB thread per panel. The list of
// threads comes from BB through `ThreadDirectory`, which a component fills
// from the SDK's public hook; this module never creates, forks or stops a
// thread.
import type { ReactNode } from "react";
import { z } from "zod";
import type { PanelProvider, PanelRef, PanelRegistry } from "../../../core/panels/index.ts";
import type { PanelLabel } from "../../../ui/tiles/index.ts";
import { Listeners, type ContentSource } from "./content-sources.ts";
import { appStrings } from "./strings.ts";

const text = appStrings.threads;

export const THREAD_PROVIDER = "bb-thread";

const ADDRESSEE_PREFIX = "thread:";

/** Who a thread panel addresses: the thread itself. */
export function threadAddressee(threadId: string): string {
  return ADDRESSEE_PREFIX + threadId;
}

/** The thread an addressee names, or `null` when it names something else. */
export function threadOfAddressee(addressee: string): string | null {
  return addressee.startsWith(ADDRESSEE_PREFIX) && addressee.length > ADDRESSEE_PREFIX.length ? addressee.slice(ADDRESSEE_PREFIX.length) : null;
}

export function threadRef(threadId: string): PanelRef {
  return { provider: THREAD_PROVIDER, params: { threadId } };
}

/** A thread as the workspace shows it. */
export interface ThreadEntry {
  readonly id: string;
  readonly title: string;
  /** `null` for a thread of the personal project. */
  readonly hostId?: string;
  readonly projectName: string | null;
  /** The thread this one was spawned from; absent for a root thread. */
  readonly parentThreadId?: string;
  /** What the agent is doing; absent while the thread is idle. */
  readonly status?: NonNullable<PanelLabel["status"]>;
}

export type ThreadDirectoryState =
  | { readonly status: "loading" }
  /** BB did not give this window the list. */
  | { readonly status: "error" }
  | { readonly status: "ready"; readonly threads: readonly ThreadEntry[] };

/** The threads BB lists for this window, as last reported. */
export class ThreadDirectory {
  private state: ThreadDirectoryState = { status: "loading" };
  private byId = new Map<string, ThreadEntry>();
  private readonly listeners = new Listeners();

  subscribe = this.listeners.subscribe;

  get(): ThreadDirectoryState {
    return this.state;
  }

  find(threadId: string): ThreadEntry | undefined {
    return this.byId.get(threadId);
  }

  set(state: ThreadDirectoryState): void {
    this.state = state;
    this.byId = new Map(state.status === "ready" ? state.threads.map((thread) => [thread.id, thread]) : []);
    this.listeners.notify();
  }

  /** The state once BB has answered: never `loading`. */
  settled(): Promise<Exclude<ThreadDirectoryState, { status: "loading" }>> {
    return new Promise((resolve) => {
      const check = (): boolean => {
        if (this.state.status === "loading") return false;
        resolve(this.state);
        return true;
      };
      if (check()) return;
      const stop = this.listeners.subscribe(() => {
        if (check()) stop();
      });
    });
  }
}

const paramsSchema = z.strictObject({ threadId: z.string().min(1).max(128) });

export interface ThreadSourceOptions {
  readonly directory: ThreadDirectory;
  /** Draws the chat of an existing thread; BB's `ThreadChat` in the app. */
  renderChat(threadId: string): ReactNode;
}

export function createThreadSource({ directory, renderChat }: ThreadSourceOptions): ContentSource {
  /** The thread of every view the registry asked for and has not released. */
  const views = new Map<string, string>();
  let registry: Pick<PanelRegistry, "report"> | null = null;

  const provider: PanelProvider = {
    type: THREAD_PROVIDER,
    // Checked by reading the SDK contract; two chats in one host and a view
    // that survives a rebuilt layout were not confirmed on every BB build.
    capabilities: {
      showNativeRoute: "yes",
      embedInstance: "unverified",
      keepLiveInDocument: "unverified",
      rebindToSession: "yes",
      transferBetweenWindows: "no",
      restoreAfterRestart: "yes",
    },
    multipleViews: false,
    paramsSchema,
    async open({ instanceId, ref }) {
      const threadId = paramsSchema.parse(ref.params).threadId;
      views.set(instanceId, threadId);
      const state = await directory.settled();
      if (!views.has(instanceId)) return { status: "lost" };
      if (state.status === "error") return { status: "access-denied" };
      return directory.find(threadId) === undefined ? { status: "session-ended" } : { status: "live", addressee: threadAddressee(threadId) };
    },
    release(instanceId) {
      views.delete(instanceId);
    },
    // Closing a chat view leaves the thread and its agent as they are.
    endsSessionOnLastClose: () => false,
    // Chertog has no action that stops a thread: the outcome is never "ended".
    endSession: async () => "unknown",
  };

  // A thread that left BB's list ends the panels that show it.
  directory.subscribe(() => {
    if (registry === null || directory.get().status !== "ready") return;
    for (const [instanceId, threadId] of views) {
      if (directory.find(threadId) === undefined) registry.report(instanceId, "session-ended");
    }
  });

  return {
    provider,
    sectionTitle: text.section,
    neutralLabel: text.neutral,
    canEndSession: false,
    offered: () => true,
    section() {
      const state = directory.get();
      if (state.status === "loading") return { state: "loading", items: [] };
      if (state.status === "error") return { state: "denied", items: [] };
      return {
        state: "ready",
        items: state.threads.map((thread) => ({
          id: thread.id,
          title: thread.title,
          context: thread.projectName ?? text.noProject,
          ...(thread.status === undefined ? {} : { status: thread.status.label }),
        })),
      };
    },
    refOf: (itemId) => (directory.find(itemId) === undefined ? null : threadRef(itemId)),
    stableRefOf: (itemId) => (directory.find(itemId) === undefined ? null : threadRef(itemId)),
    label(ref) {
      const parsed = paramsSchema.safeParse(ref.params);
      const thread = parsed.success ? directory.find(parsed.data.threadId) : undefined;
      if (thread === undefined) return null;
      return {
        title: thread.title,
        context: thread.projectName ?? text.noProject,
        ...(thread.status === undefined ? {} : { status: thread.status }),
      };
    },
    render(ref) {
      return renderChat(paramsSchema.parse(ref.params).threadId);
    },
    stateText(state) {
      if (state === "session-ended") return { title: text.goneTitle, description: text.goneText };
      if (state === "access-denied") return { title: text.deniedTitle, description: text.deniedText };
      return null;
    },
    connect(target) {
      registry = target;
    },
    subscribe: directory.subscribe,
  };
}
