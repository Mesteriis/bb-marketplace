// BB Chat Dock — host entry. Runs on the Mac where the ChatGPT window opens:
// builds the window app once and keeps it running while it is open. Close,
// disable, reload or uninstall of the plugin closes the window.
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { hostContract, hostSignals } from "./contract.ts";
import { createHostHandlers, type HostCallContext } from "./src/adapters/bb/host-handlers.ts";
import { buildWindowApp, launchWindow } from "./src/adapters/bb/native-window.ts";

const handlers = createHostHandlers({
  build: (paths) => buildWindowApp(paths),
  launch: (options) => launchWindow(options),
});

export default experimental_defineHostEntry({
  contract: hostContract,
  experimental_signals: hostSignals,
  handlers: {
    open: async (_input, context) => handlers.open(context as unknown as HostCallContext),
    propose: async ({ text, source }, context) => handlers.propose(text, source, context as unknown as HostCallContext),
    status: async (_input, context) => handlers.status(context as unknown as HostCallContext),
  },
  dispose: async () => handlers.dispose(),
});
