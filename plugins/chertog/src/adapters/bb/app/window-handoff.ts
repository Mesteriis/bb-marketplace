import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { PRESENCE_MS, type Action } from "../../../core/windows/ownership.ts";
import { snapshotSchema, type WindowSnapshot } from "../../../core/windows/wire.ts";
import { HandoffControls, IncomingTransfer } from "../../../ui/windows/handoff.tsx";
import { findThreadComposer } from "./addressee.ts";
import { threadAddressee } from "./thread-source.ts";
import { Listeners } from "./content-sources.ts";
import type { WindowWorkspace } from "./window-workspace.ts";

type Rpc = (method: "window_sync" | "window_change", input: Record<string, unknown>) => Promise<unknown>;
interface State {
  snapshot: WindowSnapshot | null;
  error: string | null;
}

export class WindowClient {
  private credential = crypto.randomUUID();
  private rpc: Rpc | undefined;
  private listeners = new Listeners();
  private state: State = { snapshot: null, error: null };
  private tail: Promise<void> = Promise.resolve();
  private readonly pendingChanges = new Map<string, Promise<void>>();
  private pendingRead: Promise<void> | null = null;
  private expiry: ReturnType<typeof setTimeout> | undefined;
  lastKnown: WindowSnapshot | null = null;
  private version = 0;
  private validUntil = 0;
  private wallDeadline = 0;
  private readonly approvals = new Map<string, number>();
  accept(threadId: string, generation: number) {
    this.approvals.set(threadId, generation);
    this.set({ ...this.state });
  }
  accepted(threadId: string, generation: number) {
    return this.approvals.get(threadId) === generation;
  }
  read = () => this.state;
  subscribe = this.listeners.subscribe;
  valid = () => performance.now() < this.validUntil && Date.now() < this.wallDeadline && this.state.snapshot !== null;
  canInput(threadId: string): boolean {
    const snapshot = this.state.snapshot;
    const placement = snapshot?.placements.find((item) => item.threadId === threadId)?.placement;
    return (
      this.valid() &&
      !!placement &&
      placement.owner === snapshot?.instanceId &&
      (!placement.transfer || placement.transfer.phase === "prepared")
    );
  }
  private set(state: State) {
    this.state = state;
    this.listeners.notify();
  }
  start(rpc: Rpc) {
    this.rpc = rpc;
    return this.sync();
  }
  resumeFromHistory(rpc: Rpc) {
    // The pre-navigation identity may have an outstanding leave or mutation.
    // Start a fresh queue and require the new identity's own server snapshot.
    this.credential = crypto.randomUUID();
    this.approvals.clear();
    this.pendingChanges.clear();
    this.tail = Promise.resolve();
    return this.start(rpc);
  }
  stop = () => {
    this.version++;
    this.rpc = undefined;
    this.pendingRead = null;
    clearTimeout(this.expiry);
    this.set({ snapshot: null, error: null });
  };
  leave = () => {
    const rpc = this.rpc;
    this.stop();
    void rpc?.("window_sync", { credential: this.credential, close: true }).catch(() => {});
  };
  sync = () => {
    if (!this.rpc) return Promise.resolve();
    if (!this.pendingRead) {
      const read = this.call("window_sync", {});
      this.pendingRead = read;
      void read.finally(() => {
        if (this.pendingRead === read) this.pendingRead = null;
      });
    }
    return this.pendingRead;
  };
  change(threadId: string, generation: number, command: Action) {
    const key = JSON.stringify([threadId, generation, command]);
    const pending = this.pendingChanges.get(key);
    if (pending) return pending;
    const change = this.call("window_change", { provider: "bb-thread", threadId, generation, command });
    this.pendingChanges.set(key, change);
    void change.finally(() => {
      if (this.pendingChanges.get(key) === change) this.pendingChanges.delete(key);
    });
    return change;
  }
  private call(method: Parameters<Rpc>[0], input: Record<string, unknown>) {
    const version = this.version;
    const rpc = this.rpc;
    this.tail = this.tail.then(async () => {
      if (!rpc || version !== this.version) return;
      const started = performance.now();
      const wallStarted = Date.now();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const snapshot = snapshotSchema.parse(
          await Promise.race([
            rpc(method, { ...input, credential: this.credential }),
            new Promise<never>((_, reject) => {
              timeout = setTimeout(() => reject(new Error("Ответ окна не получен")), PRESENCE_MS / 2);
            }),
          ]),
        );
        if (version !== this.version) return;
        const until = started + PRESENCE_MS - 1000;
        if (performance.now() >= until) throw new Error("Время подтверждения окна истекло");
        clearTimeout(this.expiry);
        this.validUntil = until;
        this.wallDeadline = wallStarted + PRESENCE_MS - 1000;
        this.expiry = setTimeout(
          () => this.set({ snapshot: null, error: "Связь с сервером потеряна" }),
          until - performance.now(),
        );
        this.lastKnown = snapshot;
        this.set({ snapshot, error: null });
      } catch (error) {
        if (version === this.version) this.set({ snapshot: null, error: error instanceof Error ? error.message : String(error) });
      } finally {
        clearTimeout(timeout);
      }
    });
    return this.tail;
  }
}
const ActiveWindow = createContext<WindowWorkspace | null>(null);

/** Mounted around the live layer in every BB document, including an empty workspace. */
export function WindowOverlay({ workspace, call, children }: { workspace: WindowWorkspace; call: Rpc; children: ReactNode }) {
  const client = workspace.handoff;
  const latest = useRef(call);
  latest.current = call;
  useEffect(() => {
    const rpc: Rpc = (method, input) => latest.current(method, input);
    void client.start(rpc);
    let cached = false;
    const hide = (event: PageTransitionEvent) => {
      cached = event.persisted;
      client.leave();
    };
    const show = (event: PageTransitionEvent) => {
      if (!cached || !event.persisted) return;
      cached = false;
      void client.resumeFromHistory(rpc);
    };
    const heartbeat = setInterval(client.sync, 5000);
    window.addEventListener("pagehide", hide);
    window.addEventListener("pageshow", show);
    return () => {
      clearInterval(heartbeat);
      window.removeEventListener("pagehide", hide);
      window.removeEventListener("pageshow", show);
      client.stop();
    };
  }, [client]);
  const { snapshot } = useSyncExternalStore(client.subscribe, client.read);
  const sessionVersion = useSyncExternalStore(workspace.session.subscribe, workspace.session.getVersion);
  // Commands and attachments use the same fence as keyboard input. A live but
  // read-only composer must not be addressable through the panel registry.
  useLayoutEffect(() => {
    for (const instance of workspace.session.registry.list()) {
      const threadId = instance.ref.params.threadId;
      if (instance.ref.provider === "bb-thread" && typeof threadId === "string") {
        workspace.session.registry.setAddressee(
          instance.instanceId,
          client.canInput(threadId) ? threadAddressee(threadId) : null,
        );
      }
    }
  }, [snapshot, sessionVersion, workspace, client]);
  useEffect(() => {
    if (!snapshot) return;
    const held = new Set(
      workspace.session.registry
        .list()
        .filter((view) => view.ref.provider === "bb-thread")
        .map((view) => view.ref.params.threadId),
    );
    for (const { threadId, placement } of snapshot.placements) {
      if (placement.owner === snapshot.instanceId && !placement.transfer && !held.has(threadId)) {
        void client.change(threadId, placement.generation, { action: "release" });
      }
    }
  }, [snapshot, sessionVersion, workspace, client]);
  const place = useSyncExternalStore(workspace.bridge.subscribe, workspace.bridge.getPlace);
  const incoming =
    snapshot?.placements.filter(
      ({ placement: p }) => p.transfer?.target === snapshot.instanceId && p.transfer.phase === "prepared",
    ) ?? [];
  const [problem, setProblem] = useState("");
  return createElement(
    ActiveWindow.Provider,
    { value: workspace },
    children,
    ...incoming.map(({ threadId, placement }) => {
      const thread = workspace.threads.find(threadId);
      return createElement(IncomingTransfer, {
        key: threadId,
        title: thread?.title ?? "Тред недоступен",
        enabled: !!thread && !!place,
        problem,
        onCancel: () => {
          void client.change(threadId, placement.generation, { action: "cancel" });
        },
        onAccept: () => {
          const result = workspace.session.openContent(
            { providerId: "bb-thread", itemId: threadId, placement: "tab" },
            { kind: "new-tile" },
          );
          if (result !== null) {
            setProblem("Не удалось открыть панель: " + result);
            return;
          }
          // The live thread panel checks the provider and acknowledges its committed, inert render.
          workspace.handoff.accept(threadId, placement.generation);
        },
      });
    }),
  );
}

export function WindowThread({ threadId, children }: { threadId: string; children: ReactNode }) {
  const workspace = useContext(ActiveWindow);
  return workspace ? createElement(CoordinatedThread, { workspace, threadId, children }) : children;
}
function CoordinatedThread({
  workspace,
  threadId,
  children,
}: {
  workspace: WindowWorkspace;
  threadId: string;
  children: ReactNode;
}) {
  const client = workspace.handoff;
  const { snapshot, error } = useSyncExternalStore(client.subscribe, client.read);
  const known = snapshot ?? client.lastKnown;
  const p = known?.placements.find((item) => item.threadId === threadId)?.placement;
  const me = known?.instanceId;
  const owner = !!me && p?.owner === me;
  const t = p?.transfer;
  const generation = p?.generation ?? 0;
  const command = (action: Action) => client.change(threadId, generation, action);
  const fenced = owner && t?.phase === "ready";
  const retired = t?.phase === "switched" && t.source === me;
  const allowed = client.canInput(threadId);
  const accepted = client.accepted(threadId, generation);
  const composers = useSyncExternalStore(workspace.composers.subscribe, workspace.composers.list);
  const hasComposer = findThreadComposer(composers, threadId).status === "one";
  const preparing = t?.target === me && (accepted || t?.phase === "ready");
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (snapshot && (!p || p.owner === null)) void command({ action: "claim" });
  }, [!!snapshot, p?.owner]);
  useLayoutEffect(() => {
    if (!snapshot || !client.valid()) return;
    if (fenced) void command({ action: "switch" });
    else if (t?.phase === "prepared" && t.target === me && accepted && hasComposer && workspace.threads.find(threadId))
      void command({ action: "ready" });
    else if (owner && hasComposer && t?.phase === "switched") void command({ action: "received" });
  }, [generation, fenced, owner, accepted, hasComposer, !!snapshot]);
  const guard = (event: { preventDefault(): void; stopPropagation(): void }) => {
    if (!allowed || !client.canInput(threadId)) {
      event.preventDefault();
      event.stopPropagation();
    }
  };
  const targets = snapshot?.windows.filter((id) => id !== me) ?? [];
  return createElement(
    "div",
    { className: "flex h-full min-h-0 flex-col" },
    createElement(HandoffControls, {
      owner,
      ownerId: p?.owner ?? null,
      windowId: me ?? null,
      targets,
      show,
      onToggle: () => setShow(!show),
      busy: !!t,
      error,
      onPick: (target: string) => {
        setShow(false);
        void command({ action: "prepare", target });
      },
      onCancel: t?.source === me && t?.phase === "prepared" ? () => void command({ action: "cancel" }) : undefined,
      onRecover:
        p?.owner && snapshot && !snapshot.windows.includes(p.owner) ? () => void command({ action: "claim" }) : undefined,
    }),
    (owner || retired || preparing) &&
      createElement(
        "div",
        {
          inert: !allowed,
          className: "min-h-0 flex-1",
          onKeyDownCapture: guard,
          onPointerDownCapture: guard,
          onBeforeInputCapture: guard,
          onClickCapture: guard,
          onPasteCapture: guard,
        },
        children,
      ),
  );
}
