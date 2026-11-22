// BB Chat Dock — host entry. Runs on the Mac where the ChatGPT window opens:
// builds the window app once and keeps it running while it is open. Close,
// disable, reload or uninstall of the plugin closes the window.
import { experimental_defineHostEntry, type ExperimentalHostWorkerLease } from "@get-bb/plugin-sdk/host";
import { hostContract, hostSignals } from "./contract.ts";
import { buildWindowApp, launchWindow } from "./src/adapters/bb/native-window.ts";
import { createWindowController, type WindowController } from "./src/adapters/bb/window-controller.ts";

let controller: WindowController | null = null;

interface Context {
  experimental_paths: { dataDir: string; tempDir: string };
  experimental_retainWorker(): ExperimentalHostWorkerLease;
  experimental_emitSignal(name: "changed", payload: ReturnType<WindowController["status"]>): Promise<void>;
  lifecycle: { signal: AbortSignal };
}

function controllerFor(context: Context): WindowController {
  if (controller !== null) return controller;
  const created = createWindowController({
    build: () => buildWindowApp({ dataDir: context.experimental_paths.dataDir, tempDir: context.experimental_paths.tempDir }),
    launch: (options) => launchWindow(options),
    retain() {
      const lease = context.experimental_retainWorker();
      return () => lease.dispose();
    },
    onChange(status) {
      void context.experimental_emitSignal("changed", status).catch(() => {});
    },
  });
  context.lifecycle.signal.addEventListener("abort", () => created.dispose(), { once: true });
  controller = created;
  return created;
}

export default experimental_defineHostEntry({
  contract: hostContract,
  experimental_signals: hostSignals,
  handlers: {
    open: async (_input, context) => controllerFor(context as unknown as Context).open(),
    propose: async ({ text, source }, context) => controllerFor(context as unknown as Context).propose(text, source),
    status: async (_input, context) => controllerFor(context as unknown as Context).status(),
  },
  dispose: async () => {
    controller?.dispose();
    controller = null;
  },
});
