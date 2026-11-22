// Keeps at most one ChatGPT window per host worker: builds it on first use,
// starts it, feeds its messages to the window session and reports a status
// that carries no text and no conversation.
import { randomUUID } from "node:crypto";
import type { WindowStatusWire } from "../../../contract.ts";
import { createWindowSession, type ProposalSource, type ProposeResult, type WindowSession } from "../../core/window-session.ts";
import type { BuildResult, LaunchOptions, RunningWindow } from "./native-window.ts";

export interface ControllerDeps {
  build(): Promise<BuildResult>;
  launch(options: Pick<LaunchOptions, "executable" | "onMessage">): RunningWindow;
  /** Keeps the host worker alive while the window runs; returns the release. */
  retain(): () => void;
  onChange(status: WindowStatusWire): void;
  newId?: () => string;
  timeoutMs?: number;
  /** How long `open` and `propose` wait for a window that is being built. */
  startWaitMs?: number;
}

export interface WindowController {
  open(): Promise<WindowStatusWire>;
  propose(text: string, source: ProposalSource): Promise<ProposeResult | { ok: false; reason: "window-unavailable" }>;
  status(): WindowStatusWire;
  dispose(): void;
}

export function createWindowController(deps: ControllerDeps): WindowController {
  const newId = deps.newId ?? randomUUID;
  let phase: WindowStatusWire["window"] = "closed";
  let reason: string | null = null;
  let running: RunningWindow | null = null;
  let session: WindowSession | null = null;
  let starting: Promise<void> | null = null;
  let release: (() => void) | null = null;
  let last: WindowStatusWire["last"] = null;
  let disposed = false;

  function status(): WindowStatusWire {
    const inner = session?.status();
    return { window: phase, reason, proposal: inner?.proposal ?? "none", last: inner?.last ?? last };
  }

  function notify(): void {
    if (!disposed) deps.onChange(status());
  }

  async function start(): Promise<void> {
    phase = "building";
    reason = null;
    release = deps.retain();
    notify();
    const built = await deps.build();
    if (disposed) return;
    if (!built.ok) {
      phase = "unavailable";
      reason = built.reason;
      release?.();
      release = null;
      notify();
      return;
    }
    let current: WindowSession | null = null;
    const window = deps.launch({
      executable: built.executable,
      onMessage(message) {
        if (current === null) return;
        switch (message.type) {
          case "url":
            current.urlChanged(message.url);
            return;
          case "pressed":
            void current.pressed(message.action);
            return;
          case "copied":
            current.copied(message.ok);
            return;
          case "closed":
            current.closed();
            return;
          case "ready":
            return;
        }
      },
    });
    current = createWindowSession({
      port: { evaluate: (expression) => window.evaluate(expression), showPanel: (view) => window.showPanel(view) },
      newId,
      timeoutMs: deps.timeoutMs,
      onChange: notify,
    });
    running = window;
    session = current;
    phase = "open";
    notify();
    void window.exited.then(() => {
      if (running !== window) return;
      last = current?.status().last ?? last;
      current?.dispose();
      running = null;
      session = null;
      phase = "closed";
      release?.();
      release = null;
      notify();
    });
  }

  // Waits for the window, but not past the host call's own time limit: a
  // first build can take longer, and the caller then sees "building".
  async function ensureOpen(): Promise<void> {
    if (running !== null) {
      running.show();
      return;
    }
    if (starting === null) {
      starting = start().finally(() => {
        starting = null;
      });
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      starting,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, deps.startWaitMs ?? 20_000);
      }),
    ]);
    clearTimeout(timer);
  }

  return {
    async open() {
      await ensureOpen();
      return status();
    },

    async propose(text, source) {
      await ensureOpen();
      if (session === null) return { ok: false, reason: "window-unavailable" };
      return session.propose(text, source);
    },

    status,

    dispose() {
      disposed = true;
      session?.dispose();
      running?.quit();
      running = null;
      session = null;
      release?.();
      release = null;
    },
  };
}
