// Keeps at most one ChatGPT window per host worker: builds it on first use,
// starts it, places it on the BB page and reports whether it is open.
import type { WindowStatusWire } from "../../../contract.ts";
import { acceptAttachment, HIDDEN_ATTACHMENT, type Attachment } from "../../core/attachment.ts";
import type { BuildResult, LaunchOptions, RunningWindow } from "./native-window.ts";

export interface ControllerDeps {
  build(): Promise<BuildResult>;
  launch(options: Pick<LaunchOptions, "executable">): RunningWindow;
  onChange(status: WindowStatusWire): void;
  /** How long `open` waits for a window that is being built. */
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
  status(): WindowStatusWire;
  dispose(): void;
}

export function createWindowController(deps: ControllerDeps): WindowController {
  let phase: WindowStatusWire["window"] = "closed";
  let reason: string | null = null;
  let running: RunningWindow | null = null;
  let starting: Promise<void> | null = null;
  let release: (() => void) | null = null;
  let placement: Attachment = HIDDEN_ATTACHMENT;
  let disposed = false;

  function status(): WindowStatusWire {
    return { window: phase, reason };
  }

  function notify(): void {
    if (!disposed) deps.onChange(status());
  }

  function dropLease(): void {
    release?.();
    release = null;
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
      dropLease();
      notify();
    };
    let built: BuildResult;
    try {
      built = await deps.build();
    } catch {
      return fail("Окно не собралось: ошибка файловой системы или компилятора.");
    }
    if (disposed) return dropLease();
    if (!built.ok) return fail(built.reason);
    let window: RunningWindow;
    try {
      window = deps.launch({ executable: built.executable });
    } catch {
      return fail("Окно не запустилось.");
    }
    running = window;
    window.attach(placement);
    phase = "open";
    notify();
    void window.exited.then(() => {
      if (running !== window) return;
      running = null;
      phase = "closed";
      dropLease();
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

    attach(view) {
      const next = acceptAttachment(placement, view);
      if (next === null) return;
      placement = next;
      running?.attach(next);
    },

    status,

    dispose() {
      disposed = true;
      running?.quit();
      running = null;
      dropLease();
    },
  };
}
