// BB Chat Dock — BB backend entry.
//
// Relays four calls between the BB page and the plugin's host entry on the
// server's own machine: open the ChatGPT window, place it on the page's
// reserved area, propose a text for it, read its status. No call returns page content, and none writes into the page:
// that happens only after the user presses "Вставить в черновик" in the
// window itself. No settings, CLI commands, agent tools or storage.
import { experimental_PluginRpcRefusal, type BbPluginApi } from "@get-bb/plugin-sdk";
import { hostContract, hostSignals, rpcContract, STATUS_CHANNEL, type WindowStatusWire } from "./contract.ts";

export { rpcContract };

export default async function plugin(bb: BbPluginApi) {
  const host = bb.hosts.experimental_client({ contract: hostContract, experimental_signals: hostSignals });

  async function localHost(): Promise<string> {
    const { primaryHostId } = await bb.sdk.system.config();
    if (primaryHostId === null) {
      throw new experimental_PluginRpcRefusal({ code: "conflict", message: "Компьютер, на котором работает BB, не подключён как хост" });
    }
    return primaryHostId;
  }

  const closed: WindowStatusWire = { window: "closed", reason: null, proposal: "none", last: null };

  const unsubscribe = host.experimental_onSignal("changed", ({ payload }) => {
    bb.realtime.publish(STATUS_CHANNEL, payload);
  });
  const unsubscribeExit = host.experimental_onWorkerExit(() => {
    bb.realtime.publish(STATUS_CHANNEL, closed);
  });
  bb.onDispose(() => {
    unsubscribe();
    unsubscribeExit();
  });

  bb.rpc.register(rpcContract, {
    async open() {
      return host.call("open", null, { hostId: await localHost() });
    },
    async propose(input) {
      return host.call("propose", input, { hostId: await localHost() });
    },
    async status() {
      return host.call("status", null, { hostId: await localHost() });
    },
    async attach(input) {
      return host.call("attach", input, { hostId: await localHost() });
    },
  });
}
