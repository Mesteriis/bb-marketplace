// Keeps at most one ChatGPT window per host worker: builds it on first use,
// starts it, feeds its messages to the window session and reports a status
// that carries no text and no conversation.
import { randomUUID } from "node:crypto";
import type { WindowStatusWire } from "../../../contract.ts";
import { acceptAttachment, HIDDEN_ATTACHMENT, type Attachment } from "../../core/attachment.ts";
import { createWindowSession, type ProposalSource, type ProposeResult, type WindowSession } from "../../core/window-session.ts";
import type { BuildResult, LaunchOptions, RunningWindow } from "./native-window.ts";

export interface ControllerDeps {
  build(): Promise<BuildResult>;
  launch(options: Pick<LaunchOptions, "executable" | "onMessage">): RunningWindow;
  onChange(status: WindowStatusWire): void;
  newId?: () => string;
  timeoutMs?: number;
  /** How long `open` and `propose` wait for a window that is being built. */
  startWaitMs?: number;
}

/**
 * Keeps the host worker alive while the window runs and returns the release.
 * BB accepts it only from the call that is running now, so every call passes
 * its own.
 */
export type Retain = () => () => void;

export interface WindowController {
  open(retain: Retain): Promise<WindowStatusWire>;
  /** Where the BB page wants the window. Kept for a window not started yet. */
  attach(view: Attachment): void;
  propose(text: string, source: ProposalSource, retain: Retain): Promise<ProposeResult | { ok: false; reason: "window-unavailable" }>;
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
  let placement: Attachment = HIDDEN_ATTACHMENT;
  let disposed = false;

  function status(): WindowStatusWire {
    const inner = session?.status();
    return { window: phase, reason, proposal: inner?.proposal ?? "none", last: inner?.last ?? last };
  }

  function notify(): void {
    if (!disposed) deps.onChange(status());
  }

  async function start(retain: Retain): Promise<void> {
    phase = "building";
    reason = null;
    try {
      release = retain();
    } catch {
      phase = "closed";
      notify();
      throw new Error("the host refused to keep the window running");
    }
    notify();
    const fail = (why: string) => {
      phase = "unavailable";
      reason = why;
      release?.();
      release = null;
      notify();
    };
    let built: BuildResult;
    try {
      built = await deps.build();
    } catch {
      return fail("Окно не собралось: ошибка файловой системы или компилятора.");
    }
    if (disposed) {
      release?.();
      release = null;
      return;
    }
    if (!built.ok) return fail(built.reason);
    let current: WindowSession | null = null;
    let window: RunningWindow;
    try {
      window = deps.launch({
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
    } catch {
      return fail("Окно не запустилось.");
    }
    current = createWindowSession({
      port: { evaluate: (expression) => window.evaluate(expression), showPanel: (view) => window.showPanel(view) },
      newId,
      timeoutMs: deps.timeoutMs,
      onChange: notify,
    });
    running = window;
    session = current;
    window.attach(placement);
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
  async function ensureOpen(retain: Retain): Promise<void> {
    if (running !== null) return;
    if (starting === null) {
      starting = start(retain).finally(() => {
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
    async open(retain) {
      await ensureOpen(retain);
      return status();
    },

    async propose(text, source, retain) {
      await ensureOpen(retain);
      if (session === null) return { ok: false, reason: "window-unavailable" };
      return session.propose(text, source);
    },

    attach(view) {
      const next = acceptAttachment(placement, view);
      if (next === null) return;
      placement = next;
      running?.attach(next);
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
