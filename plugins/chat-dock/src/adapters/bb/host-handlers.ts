// The host entry's handlers, apart from the SDK so they can be tested with
// contexts that behave like BB's: a context's worker lease can be taken only
// while its own call runs.
import type { WindowStatusWire } from "../../../contract.ts";
import type { Attachment } from "../../core/attachment.ts";
import type { ProposalSource } from "../../core/window-session.ts";
import type { BuildResult, LaunchOptions, RunningWindow } from "./native-window.ts";
import { createWindowController, type Retain, type WindowController } from "./window-controller.ts";

export interface HostCallContext {
  experimental_paths: { dataDir: string; tempDir: string };
  experimental_retainWorker(): { dispose(): void };
  experimental_emitSignal(name: "changed", payload: WindowStatusWire): Promise<void>;
  lifecycle: { signal: AbortSignal };
}

export interface HostHandlerDeps {
  build(paths: { dataDir: string; tempDir: string }): Promise<BuildResult>;
  launch(options: Pick<LaunchOptions, "executable" | "onMessage">): RunningWindow;
}

export function createHostHandlers(deps: HostHandlerDeps) {
  let controller: WindowController | null = null;
  // Signals and paths are the worker's own, so any call's context serves.
  let signalContext: HostCallContext | null = null;

  function controllerFor(context: HostCallContext): WindowController {
    signalContext = context;
    if (controller !== null) return controller;
    const paths = { dataDir: context.experimental_paths.dataDir, tempDir: context.experimental_paths.tempDir };
    const created = createWindowController({
      build: () => deps.build(paths),
      launch: (options) => deps.launch(options),
      onChange(status) {
        try {
          void signalContext?.experimental_emitSignal("changed", status).catch(() => {});
        } catch {
          // The page refreshes the status on its next call.
        }
      },
    });
    context.lifecycle.signal.addEventListener("abort", () => created.dispose(), { once: true });
    controller = created;
    return created;
  }

  // Taken from the call that is running now: BB refuses a finished call's.
  const retainFor =
    (context: HostCallContext): Retain =>
    () => {
      const lease = context.experimental_retainWorker();
      return () => lease.dispose();
    };

  return {
    open: (context: HostCallContext) => controllerFor(context).open(retainFor(context)),
    propose: (text: string, source: ProposalSource, context: HostCallContext) =>
      controllerFor(context).propose(text, source, retainFor(context)),
    status: (context: HostCallContext) => controllerFor(context).status(),
    attach(view: Attachment, context: HostCallContext): { ok: true } {
      controllerFor(context).attach(view);
      return { ok: true };
    },
    dispose() {
      controller?.dispose();
      controller = null;
    },
  };
}
